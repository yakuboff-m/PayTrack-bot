/// <reference types="@cloudflare/workers-types" />

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SqliteDatabaseAdapter } from '../src/database/adapter';
import { DistributorRepository } from '../src/distributors/distributor.repository';
import { DistributorService } from '../src/distributors/distributor.service';
import { TransactionRepository } from '../src/transactions/transaction.repository';
import { TransactionService } from '../src/transactions/transaction.service';
import { DatabaseConversationStore } from '../src/distributors/conversation.store';
import { parseConfigFromEnv, getBotIdFromToken } from '../src/config/config';
import { createBot } from '../src/bot/bot';
import worker from '../src/worker';
import type { Env } from '../src/database/d1.types';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import fs from 'fs';
import path from 'path';

function createInMemoryDb(): SqliteDatabaseAdapter {
  const sqlite = new Database(':memory:');
  const schemaPath = path.join(__dirname, '../src/database/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  sqlite.exec(schema);
  return new SqliteDatabaseAdapter(sqlite);
}

describe('Migration Verification Test Suite', () => {
  describe('Config & Token Extraction', () => {
    it('extracts bot ID from Telegram bot token without network calls', () => {
      const token = '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ';
      const botId = getBotIdFromToken(token);
      assert.equal(botId, 7123456789);
    });

    it('parses environment configuration for Cloudflare Workers', () => {
      const env = {
        BOT_TOKEN: '123456:SECRET_TOKEN',
        TELEGRAM_GROUP_ID: '-1001987654321',
        TELEGRAM_PENDING_TOPIC_ID: '42',
        TELEGRAM_CONFIRMED_TOPIC_ID: '43',
        TELEGRAM_ADMIN_USER_IDS: '111, 222, 333',
        WEBHOOK_SECRET: 'super-secret',
      };
      const config = parseConfigFromEnv(env);
      assert.equal(config.botToken, '123456:SECRET_TOKEN');
      assert.equal(config.telegramGroupId, -1001987654321);
      assert.equal(config.pendingTopicId, 42);
      assert.equal(config.confirmedTopicId, 43);
      assert.deepEqual(config.adminUserIds, [111, 222, 333]);
    });

    it('strictly validates integer types and rejects invalid values', () => {
      const baseEnv = {
        BOT_TOKEN: '123456:SECRET_TOKEN',
        TELEGRAM_GROUP_ID: '-100123',
        TELEGRAM_PENDING_TOPIC_ID: '1',
        TELEGRAM_CONFIRMED_TOPIC_ID: '2',
        TELEGRAM_ADMIN_USER_IDS: '100',
      };

      assert.throws(
        () => parseConfigFromEnv({ ...baseEnv, TELEGRAM_GROUP_ID: 'not-an-int' }),
        /must be a valid integer/
      );
      assert.throws(
        () => parseConfigFromEnv({ ...baseEnv, TELEGRAM_PENDING_TOPIC_ID: '' }),
        /Missing TELEGRAM_PENDING_TOPIC_ID/
      );
      assert.throws(
        () => parseConfigFromEnv({ ...baseEnv, TELEGRAM_ADMIN_USER_IDS: 'abc' }),
        /Invalid admin user ID/
      );
    });
  });

  describe('Worker Webhook Secret Enforcement', () => {
    const mockEnv: Env = {
      paytrack_bot_db: {} as any,
      BOT_TOKEN: '123456:TOKEN',
      TELEGRAM_GROUP_ID: '-100123',
      TELEGRAM_PENDING_TOPIC_ID: '1',
      TELEGRAM_CONFIRMED_TOPIC_ID: '2',
      TELEGRAM_ADMIN_USER_IDS: '111',
      WEBHOOK_SECRET: 'expected-secret-token',
    };

    const mockCtx: ExecutionContext = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    it('rejects POST with 500 when WEBHOOK_SECRET is missing from environment', async () => {
      const envWithoutSecret = { ...mockEnv, WEBHOOK_SECRET: '' };
      const req = new Request('https://worker.dev/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'some-token' },
      });

      const res = await worker.fetch(req, envWithoutSecret, mockCtx);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.match(text, /Webhook secret is not configured/);
    });

    it('rejects POST with 403 when secret header is missing or wrong', async () => {
      // Missing header
      const reqMissing = new Request('https://worker.dev/webhook', {
        method: 'POST',
      });
      const resMissing = await worker.fetch(reqMissing, mockEnv, mockCtx);
      assert.equal(resMissing.status, 403);

      // Wrong secret header
      const reqWrong = new Request('https://worker.dev/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
      });
      const resWrong = await worker.fetch(reqWrong, mockEnv, mockCtx);
      assert.equal(resWrong.status, 403);
    });

    it('serves healthy GET request without secret', async () => {
      const req = new Request('https://worker.dev/health', { method: 'GET' });
      const res = await worker.fetch(req, mockEnv, mockCtx);
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.status, 'ok');
    });
  });

  describe('Payment Confirmation Uncertain-Status Recovery Safety', () => {
    const testConfig = {
      botToken: '123456:TOKEN',
      telegramGroupId: -100123,
      pendingTopicId: 1,
      confirmedTopicId: 2,
      adminUserIds: [111],
    };

    it('does NOT delete Telegram confirmation messages when both write and verification query fail', async () => {
      const deletedMessageIds: number[] = [];
      const fakeApi = {
        sendMediaGroup: async () => [{ message_id: 8888 }],
        sendMessage: async () => ({ message_id: 9999 }),
        copyMessage: async () => ({ message_id: 8888 }),
        editMessageText: async () => ({}),
        editMessageCaption: async () => ({}),
        editMessageReplyMarkup: async () => ({}),
        deleteMessage: async (_chatId: any, msgId: number) => {
          deletedMessageIds.push(msgId);
        },
      } as unknown as Api;

      // Mock repository where markPaid throws AND findById also throws
      const repoMock = {
        markPaid: async () => {
          throw new Error('D1 connection timeout');
        },
        findById: async () => {
          throw new Error('D1 still unreachable during verification query');
        },
      } as unknown as TransactionRepository;

      const service = new TransactionService(repoMock, testConfig);

      const fakeTx = {
        id: 101,
        telegramChatId: '-100123',
        pendingTopicId: 1,
        originalMessageId: 1001,
        distributorId: 1,
        distributorSnapshot: { name: 'Supplier' },
        amount: 50000,
        currency: 'KRW',
        status: 'PENDING' as const,
        receivedAt: new Date().toISOString(),
        paidAt: null,
        paymentMessageId: null,
        confirmationMessageId: null,
        confirmationUrl: null,
        historyMessageId: null,
        metadataMessageId: null,
        notes: [],
        createdAt: new Date().toISOString(),
      };

      const result = await service.executeConfirmation(
        fakeApi,
        fakeTx,
        2001,
        { text: 'invoice', message_id: 1001 } as Message,
        { text: '/paid', message_id: 2001 } as Message
      );

      // Must report failure due to uncertain status
      assert.equal(result.success, false);
      assert.match(result.error!, /Commit status is uncertain/);

      // CRITICAL SAFETY CHECK: Neither the confirmed message (8888) nor the history message (9999)
      // may be deleted when commit status is uncertain!
      assert.equal(deletedMessageIds.includes(8888), false);
      assert.equal(deletedMessageIds.includes(9999), false);
    });

    it('preserves messages if verification query proves the transaction was committed before timeout', async () => {
      const deletedMessageIds: number[] = [];
      const fakeApi = {
        sendMediaGroup: async () => [{ message_id: 8888 }],
        sendMessage: async (_chatId: any, _text: string, options: any) => {
          return { message_id: options?.message_thread_id === testConfig.confirmedTopicId ? 8888 : 9999 };
        },
        copyMessage: async () => ({ message_id: 8888 }),
        editMessageText: async () => ({}),
        editMessageCaption: async () => ({}),
        editMessageReplyMarkup: async () => ({}),
        deleteMessage: async (_chatId: any, msgId: number) => {
          deletedMessageIds.push(msgId);
        },
      } as unknown as Api;

      // markPaid throws, BUT findById shows status === 'PAID' and confirmation_message_id === 8888
      const repoMock = {
        markPaid: async () => {
          throw new Error('Network timeout after commit');
        },
        findById: async () => ({
          id: 101,
          status: 'PAID',
          confirmation_message_id: 8888,
        }),
      } as unknown as TransactionRepository;

      const service = new TransactionService(repoMock, testConfig);

      const fakeTx = {
        id: 101,
        telegramChatId: '-100123',
        pendingTopicId: 1,
        originalMessageId: 1001,
        distributorId: 1,
        distributorSnapshot: { name: 'Supplier' },
        amount: 50000,
        currency: 'KRW',
        status: 'PENDING' as const,
        receivedAt: new Date().toISOString(),
        paidAt: null,
        paymentMessageId: null,
        confirmationMessageId: null,
        confirmationUrl: null,
        historyMessageId: null,
        metadataMessageId: null,
        notes: [],
        createdAt: new Date().toISOString(),
      };

      const result = await service.executeConfirmation(
        fakeApi,
        fakeTx,
        2001,
        { text: 'invoice', message_id: 1001 } as Message,
        { text: '/paid', message_id: 2001 } as Message
      );

      // Successfully treated as committed!
      assert.equal(result.success, true);
      assert.ok(result.confirmationUrl);
      // Confirmed message 8888 was NOT deleted
      assert.equal(deletedMessageIds.includes(8888), false);
    });
  });

  describe('Distributor Repository & Service (Async + Positional Params)', () => {
    it('creates, retrieves, updates, and deletes distributors', async () => {
      const db = createInMemoryDb();
      const repo = new DistributorRepository(db);
      const service = new DistributorService(repo);

      // Create
      const created = await service.create({
        name: 'Halal Foods',
        alias: 'halal',
        bankName: 'Shinhan',
        accountNumber: '110-123-456789',
        accountHolder: 'Kim Halal',
      });
      assert.equal(created.name, 'Halal Foods');
      assert.equal(created.alias, 'halal');

      // Duplicate alias check
      await assert.rejects(
        () =>
          service.create({
            name: 'Another Vendor',
            alias: 'halal',
            bankName: 'Woori',
            accountNumber: '1002-123',
            accountHolder: 'Lee',
          }),
        /already in use/
      );

      // Find by alias
      const found = await service.findByAlias('halal');
      assert.ok(found);
      assert.equal(found.id, created.id);

      // Update
      const updated = await service.update(created.id, {
        bankName: 'Hana Bank',
      });
      assert.equal(updated.bankName, 'Hana Bank');

      // Delete
      await service.delete(created.id);
      const afterDelete = await service.findById(created.id);
      assert.equal(afterDelete, undefined);
    });
  });

  describe('Transaction Repository & CAS Concurrency Handling', () => {
    it('handles transaction lifecycle and prevents duplicate confirmation via compare-and-swap', async () => {
      const db = createInMemoryDb();
      const repo = new TransactionRepository(db);

      // 1. Create distributor and transaction
      const distRepo = new DistributorRepository(db);
      const dist = await distRepo.create({
        name: 'Vendor 1',
        alias: 'vendor1',
        bankName: 'Shinhan',
        accountNumber: '110-123',
        accountHolder: 'Vendor',
      });

      const tx = await repo.create('-100123', 10, 1001, new Date().toISOString());
      assert.ok(tx.id > 0);
      assert.equal(tx.status, 'PENDING');

      // 2. Assign distributor snapshot and amount
      await repo.updateDistributor(tx.id, dist.id, JSON.stringify({ name: 'Vendor 1' }));
      await repo.updateAmount(tx.id, 150000);

      const loaded = await repo.findById(tx.id);
      assert.equal(loaded?.amount, 150000);
      assert.equal(loaded?.status, 'PENDING');

      // 3. Mark paid (First attempt - CAS succeeds)
      const firstCommit = await repo.markPaid(
        tx.id,
        new Date().toISOString(),
        2001,
        3001,
        'https://t.me/c/123/3001',
        4001
      );
      assert.equal(firstCommit, true);

      // Verify status is now PAID
      const paidTx = await repo.findById(tx.id);
      assert.equal(paidTx?.status, 'PAID');
      assert.equal(paidTx?.confirmation_message_id, 3001);

      // 4. Mark paid (Second concurrent attempt - CAS returns false)
      const secondCommit = await repo.markPaid(
        tx.id,
        new Date().toISOString(),
        2002,
        3002,
        'https://t.me/c/123/3002',
        4002
      );
      assert.equal(secondCommit, false);

      // Confirm confirmation_message_id was not overwritten by second attempt
      const finalTx = await repo.findById(tx.id);
      assert.equal(finalTx?.confirmation_message_id, 3001);
    });
  });

  describe('Database Conversation Store', () => {
    it('persists and retrieves multi-step conversation states across requests', async () => {
      const db = createInMemoryDb();
      const store = new DatabaseConversationStore(db);

      const key = '-100123:999';
      await store.set(key, {
        step: 'alias',
        action: 'add',
        data: { name: 'New Supplier' },
        startedAt: Date.now(),
      });

      const loaded = await store.get(key);
      assert.ok(loaded);
      assert.equal(loaded.step, 'alias');
      assert.equal(loaded.action, 'add');
      assert.equal(loaded.data.name, 'New Supplier');

      // Deleting state
      await store.delete(key);
      const afterDelete = await store.get(key);
      assert.equal(afterDelete, null);
    });

    it('expires conversation states older than 5 minutes', async () => {
      const db = createInMemoryDb();
      const store = new DatabaseConversationStore(db);

      const key = '-100123:888';
      // 6 minutes ago
      await store.set(key, {
        step: 'name',
        action: 'add',
        data: {},
        startedAt: Date.now() - 6 * 60 * 1000,
      });

      const loaded = await store.get(key);
      assert.equal(loaded, null);
    });
  });

  describe('Local Node.js Compatibility', () => {
    it('instantiates createBot with custom config and database without errors', () => {
      const db = createInMemoryDb();
      const config = {
        botToken: '123456789:ABCdefGHI',
        telegramGroupId: -100123456,
        pendingTopicId: 1,
        confirmedTopicId: 2,
        adminUserIds: [111, 222],
      };

      const { bot } = createBot({
        config,
        db,
      });

      assert.ok(bot);
      assert.equal(bot.botInfo.id, 123456789);
    });
  });
});
