import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SqliteDatabaseAdapter } from '../src/database/adapter';
import { DistributorRepository } from '../src/distributors/distributor.repository';
import { DistributorService } from '../src/distributors/distributor.service';
import { TransactionRepository } from '../src/transactions/transaction.repository';
import { TransactionService } from '../src/transactions/transaction.service';
import { createBot } from '../src/bot/bot';
import {
  formatNoteTimestamp,
  formatNotesBlock,
  extractNoteFromText,
} from '../src/bot/helpers/format.helpers';
import type { Config } from '../src/config/config';
import type { InvoiceNote } from '../src/types';

function createInMemoryDb(): SqliteDatabaseAdapter {
  const sqlite = new Database(':memory:');
  const schemaPath = path.join(__dirname, '../src/database/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  sqlite.exec(schema);
  return new SqliteDatabaseAdapter(sqlite);
}

const testConfig: Config = {
  botToken: '123456789:ABCdefGHI',
  telegramGroupId: -100123456,
  pendingTopicId: 10,
  confirmedTopicId: 20,
  adminUserIds: [111, 222],
};

describe('PayTrack Bot /note Feature Test Suite', () => {
  describe('Helper & Formatting Tests', () => {
    it('formats note timestamp in Asia/Seoul timezone as "d MMM, HH:mm"', () => {
      // 2026-10-22T01:30:00.000Z -> 2026-10-22 10:30 in Asia/Seoul (UTC+9)
      const ts = '2026-10-22T01:30:00.000Z';
      const formatted = formatNoteTimestamp(ts);
      assert.equal(formatted, '22 Oct, 10:30');

      // 2026-10-22T02:45:00.000Z -> 2026-10-22 11:45 in Asia/Seoul
      const ts2 = '2026-10-22T02:45:00.000Z';
      assert.equal(formatNoteTimestamp(ts2), '22 Oct, 11:45');
    });

    it('formats note block chronologically with bullet points', () => {
      const notes: InvoiceNote[] = [
        { text: 'First note', createdAt: '2026-10-22T01:30:00.000Z' },
        { text: 'Second note', createdAt: '2026-10-22T02:45:00.000Z' },
      ];
      const block = formatNotesBlock(notes);
      const expected = [
        '📝 NOTES:',
        '• 22 Oct, 10:30 — First note',
        '• 22 Oct, 11:45 — Second note',
      ].join('\n');
      assert.equal(block, expected);
    });

    it('extracts note directive from text correctly', () => {
      const input = 'Meat delivery 30kg\n/note Urgent payment needed';
      const extracted = extractNoteFromText(input);
      assert.equal(extracted.cleanText, 'Meat delivery 30kg');
      assert.equal(extracted.note, 'Urgent payment needed');

      const input2 = 'Meat delivery 30kg\nNote: Approved by director';
      const extracted2 = extractNoteFromText(input2);
      assert.equal(extracted2.cleanText, 'Meat delivery 30kg');
      assert.equal(extracted2.note, 'Approved by director');

      const noNote = 'Meat delivery 30kg';
      const extracted3 = extractNoteFromText(noNote);
      assert.equal(extracted3.cleanText, 'Meat delivery 30kg');
      assert.equal(extracted3.note, null);
    });
  });

  describe('Integration & Bot Handler Scenarios', () => {
    async function setupTestContext() {
      const db = createInMemoryDb();
      const distRepo = new DistributorRepository(db);
      const distService = new DistributorService(distRepo);
      const txRepo = new TransactionRepository(db);
      const txService = new TransactionService(txRepo, testConfig);

      const distributor = await distService.create({
        name: "Baraka Go'sht",
        alias: 'baraka',
        bankName: 'Hana Bank',
        accountNumber: '123-456-7890',
        accountHolder: 'Ali Veli',
      });

      const sentMessages: any[] = [];
      const editedMessages: any[] = [];
      const editedCaptions: any[] = [];
      const deletedMessageIds: number[] = [];

      const { bot } = createBot({
        config: testConfig,
        db,
        executionContext: { waitUntil: () => {} } as any,
      });

      // Intercept Bot API calls
      bot.api.config.use(async (prev, method, payload: any) => {
        if (method === 'sendMessage') {
          const id = 5000 + sentMessages.length;
          sentMessages.push({ ...payload, message_id: id });
          return {
            ok: true,
            result: {
              message_id: id,
              chat: { id: payload.chat_id },
              date: Math.floor(Date.now() / 1000),
              ...payload,
            } as any,
          };
        }
        if (method === 'editMessageText') {
          editedMessages.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
              text: payload.text,
            } as any,
          };
        }
        if (method === 'editMessageCaption') {
          editedCaptions.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
              caption: payload.caption,
            } as any,
          };
        }
        if (method === 'deleteMessage') {
          deletedMessageIds.push(payload.message_id);
          return { ok: true, result: true as any };
        }
        if (method === 'copyMessage') {
          const id = 6000 + sentMessages.length;
          sentMessages.push({ ...payload, message_id: id });
          return {
            ok: true,
            result: {
              message_id: id,
            } as any,
          };
        }
        return { ok: true, result: {} as any };
      });

      return {
        db,
        distService,
        txRepo,
        txService,
        distributor,
        bot,
        sentMessages,
        editedMessages,
        editedCaptions,
        deletedMessageIds,
      };
    }

    // 1. Registering an invoice with a note
    it('1. registers a new invoice with an initial note parsed from registration flow', async () => {
      const { bot, txRepo, sentMessages } = await setupTestContext();

      // Post invoice with note directive in Pending topic
      const update = {
        update_id: 1,
        message: {
          message_id: 101,
          from: { id: 111, is_bot: false, username: 'admin_user' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: 'Beef tenderloin 50kg\n/note Initial batch approved',
        },
      };

      await bot.handleUpdate(update as any);

      // Verify transaction was saved with initial note in database
      const tx = await txRepo.findByMessageId(String(testConfig.telegramGroupId), 101);
      assert.ok(tx);
      const notes = JSON.parse(tx.notes ?? '[]');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'Initial batch approved');
      assert.equal(notes[0].author, 'admin_user');

      // Verify message was re-sent as bot with notes displayed
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /Beef tenderloin 50kg/);
      assert.match(sentMessages[0].text, /📝 NOTES:/);
      assert.match(sentMessages[0].text, /Initial batch approved/);
    });

    // 2. Registering an invoice without a note
    it('2. registers a new invoice without a note retaining existing behavior unchanged', async () => {
      const { bot, txRepo, sentMessages } = await setupTestContext();

      const update = {
        update_id: 2,
        message: {
          message_id: 102,
          from: { id: 111, is_bot: false, username: 'admin_user' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: 'Beef tenderloin 50kg',
        },
      };

      await bot.handleUpdate(update as any);

      const tx = await txRepo.findByMessageId(String(testConfig.telegramGroupId), 102);
      assert.ok(tx);
      const notes = JSON.parse(tx.notes ?? '[]');
      assert.equal(notes.length, 0);
      // Without note, original message is untouched (not re-sent)
      assert.equal(sentMessages.length, 0);
    });

    // 3. Appending a note to an existing invoice
    it('3. appends a note to an existing invoice without creating duplicate transactions', async () => {
      const { bot, txRepo, txService, sentMessages, deletedMessageIds, editedMessages } =
        await setupTestContext();

      // Register initial invoice
      const initialTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        201
      );
      // Simulate bot message created
      await txRepo.updateMetadataMessageId(initialTx.id, 5001);

      // Reply with /note
      const update = {
        update_id: 3,
        message: {
          message_id: 202,
          from: { id: 111, is_bot: false, username: 'supervisor' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Verified weight on scale',
          reply_to_message: {
            message_id: 5001,
            text: 'Original invoice content\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      // Check DB
      const updated = await txRepo.findById(initialTx.id);
      assert.ok(updated);
      const notes = JSON.parse(updated.notes ?? '[]');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'Verified weight on scale');
      assert.equal(notes[0].author, 'supervisor');

      // Ensure no separate note message was sent to Telegram chat
      assert.equal(sentMessages.length, 0);
      // Original bot message was edited
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0].text, /Verified weight on scale/);

      // Ensure command message was deleted
      assert.ok(deletedMessageIds.includes(202));
    });

    // 4. Preserving previous notes and their timestamps
    it('4. preserves previous notes and timestamps in chronological order', async () => {
      const { bot, txRepo, txService, editedMessages } = await setupTestContext();

      const initialNotes: InvoiceNote[] = [
        { text: 'First note', createdAt: '2026-10-22T01:30:00.000Z', author: 'user1' },
      ];
      const initialTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        301,
        initialNotes
      );
      await txRepo.updateMetadataMessageId(initialTx.id, 5002);

      const update = {
        update_id: 4,
        message: {
          message_id: 302,
          from: { id: 111, is_bot: false, username: 'user2' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Second note added later',
          reply_to_message: {
            message_id: 5002,
            text: 'Invoice text\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n\n📝 NOTES:\n• 22 Oct, 10:30 — First note\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      const updated = await txRepo.findById(initialTx.id);
      assert.ok(updated);
      const notes = JSON.parse(updated.notes ?? '[]');
      assert.equal(notes.length, 2);
      assert.equal(notes[0].text, 'First note');
      assert.equal(notes[0].createdAt, '2026-10-22T01:30:00.000Z');
      assert.equal(notes[1].text, 'Second note added later');

      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0].text, /• 22 Oct, 10:30 — First note/);
      assert.match(editedMessages[0].text, /Second note added later/);
    });

    // 5. Rejecting /note without a valid invoice reply
    it('5. rejects /note without a valid invoice reply and shows usage instruction', async () => {
      const { bot, sentMessages } = await setupTestContext();

      // No reply_to_message
      const update = {
        update_id: 5,
        message: {
          message_id: 401,
          from: { id: 111, is_bot: false, username: 'user1' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Floating note without reply',
        },
      };

      await bot.handleUpdate(update as any);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /Usage: Reply to an invoice message with/);

      // Reply to an unknown non-invoice message
      const update2 = {
        update_id: 6,
        message: {
          message_id: 402,
          from: { id: 111, is_bot: false, username: 'user1' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Some note',
          reply_to_message: {
            message_id: 99999,
            text: 'Random chat message',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update2 as any);
      assert.equal(sentMessages.length, 2);
      assert.match(sentMessages[1].text, /Could not find an invoice/);
    });

    // 6. Rejecting empty note content
    it('6. rejects empty note content or excessively long notes', async () => {
      const { bot, txService, sentMessages } = await setupTestContext();

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        501
      );

      // Empty note
      const updateEmpty = {
        update_id: 7,
        message: {
          message_id: 502,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note   ',
          reply_to_message: {
            message_id: 501,
            text: 'Invoice',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(updateEmpty as any);
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /Please provide note content/);

      // Excessively long note (> 1000 chars)
      const longText = '/note ' + 'a'.repeat(1005);
      const updateLong = {
        update_id: 8,
        message: {
          message_id: 503,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: longText,
          reply_to_message: {
            message_id: 501,
            text: 'Invoice',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(updateLong as any);
      assert.equal(sentMessages.length, 2);
      assert.match(sentMessages[1].text, /Note is too long/);
    });

    // 7. Correctly editing text-only invoices
    it('7. correctly edits text-only invoices using editMessageText', async () => {
      const { bot, txRepo, txService, editedMessages } = await setupTestContext();

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        601
      );
      await txRepo.updateMetadataMessageId(tx.id, 6001);

      const update = {
        update_id: 9,
        message: {
          message_id: 602,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Text invoice note test',
          reply_to_message: {
            message_id: 6001,
            text: 'Invoice #601 Text\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      assert.equal(editedMessages.length, 1);
      assert.equal(editedMessages[0].message_id, 6001);
      assert.match(editedMessages[0].text, /Text invoice note test/);
    });

    // 8. Correctly editing photo/document invoice captions
    it('8. correctly edits photo/document invoice captions using editMessageCaption', async () => {
      const { bot, txRepo, txService, editedCaptions } = await setupTestContext();

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        701
      );
      await txRepo.updateMetadataMessageId(tx.id, 7001);

      const update = {
        update_id: 10,
        message: {
          message_id: 702,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Photo invoice note test',
          reply_to_message: {
            message_id: 7001,
            photo: [{ file_id: 'photo_file_123', file_unique_id: 'p1', width: 100, height: 100 }],
            caption: 'Receipt Photo\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      assert.equal(editedCaptions.length, 1);
      assert.equal(editedCaptions[0].message_id, 7001);
      assert.match(editedCaptions[0].caption, /Photo invoice note test/);
    });

    // 9. Preserving note history when an invoice becomes Confirmed
    it('9. preserves note history when an invoice becomes Confirmed', async () => {
      const { bot, txRepo, txService, distributor, sentMessages } = await setupTestContext();

      const initialNotes: InvoiceNote[] = [
        { text: 'Confirmed test note', createdAt: '2026-10-22T01:30:00.000Z' },
      ];
      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        801,
        initialNotes
      );
      const snapshot = {
        name: distributor.name,
        bankName: distributor.bankName,
        accountNumber: distributor.accountNumber,
        accountHolder: distributor.accountHolder,
      };
      await txService.assignDistributor(tx.id, distributor.id, snapshot);
      await txService.setAmount(tx.id, 500000);
      await txRepo.updateMetadataMessageId(tx.id, 8001);

      // Confirm the invoice via /paid
      const update = {
        update_id: 11,
        message: {
          message_id: 802,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid Payment done',
          reply_to_message: {
            message_id: 8001,
            text: 'Invoice text\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n🏢 Baraka\n💰 ₩500,000\n\n📝 NOTES:\n• 22 Oct, 10:30 — Confirmed test note\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      // Verify transaction is PAID and notes are still intact
      const paidTx = await txRepo.findById(tx.id);
      assert.ok(paidTx);
      assert.equal(paidTx.status, 'PAID');
      const savedNotes = JSON.parse(paidTx.notes ?? '[]');
      assert.equal(savedNotes.length, 1);
      assert.equal(savedNotes[0].text, 'Confirmed test note');

      // Verify Confirmed header and Pending history message both display the notes
      const confirmedMsg = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedMsg);
      assert.match(confirmedMsg.text ?? confirmedMsg.caption, /📝 NOTES:/);
      assert.match(confirmedMsg.text ?? confirmedMsg.caption, /Confirmed test note/);

      const historyMsg = sentMessages.find((m) => m.message_thread_id === testConfig.pendingTopicId);
      assert.ok(historyMsg);
      assert.match(historyMsg.text, /📝 NOTES:/);
      assert.match(historyMsg.text, /Confirmed test note/);
    });

    // 10. Handling Telegram edit failures without losing persisted notes
    it('10. handles Telegram edit failures safely without losing persisted notes', async () => {
      const db = createInMemoryDb();
      const txRepo = new TransactionRepository(db);
      const txService = new TransactionService(txRepo, testConfig);

      const { bot } = createBot({
        config: testConfig,
        db,
        executionContext: { waitUntil: () => {} } as any,
      });

      // Mock bot API where editMessageText fails with a Telegram API error
      bot.api.config.use(async (prev, method, payload: any) => {
        if (method === 'editMessageText') {
          throw new Error('Telegram API 502 Bad Gateway');
        }
        if (method === 'deleteMessage') {
          return { ok: true, result: true as any };
        }
        return { ok: true, result: {} as any };
      });

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        901
      );
      await txRepo.updateMetadataMessageId(tx.id, 9001);

      const update = {
        update_id: 12,
        message: {
          message_id: 902,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Note when telegram is failing',
          reply_to_message: {
            message_id: 9001,
            text: 'Invoice\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      // Handler should catch the edit error and not throw or crash
      await bot.handleUpdate(update as any);

      // Verify the note is still safely stored in database
      const savedTx = await txRepo.findById(tx.id);
      assert.ok(savedTx);
      const notes = JSON.parse(savedTx.notes ?? '[]');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'Note when telegram is failing');
    });

    // 11. Handling legacy invoices with no note history
    it('11. handles legacy invoices where notes column is null', async () => {
      const { bot, txRepo, txService, editedMessages } = await setupTestContext();

      // Insert legacy row with null notes
      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        1001
      );
      await txRepo.updateMetadataMessageId(tx.id, 10001);
      // Explicitly set notes to null in DB to simulate legacy row
      await txRepo.updateNotes(tx.id, null as any);

      const legacyRow = await txRepo.findById(tx.id);
      assert.equal(legacyRow?.notes, null);

      // Reply with /note
      const update = {
        update_id: 13,
        message: {
          message_id: 1002,
          from: { id: 111, is_bot: false },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/note Appended to legacy invoice',
          reply_to_message: {
            message_id: 10001,
            text: 'Legacy invoice text\n\n━━━━━━━━━━━━\n🆔 #INV-0001\n━━━━━━━━━━━━',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      const updated = await txRepo.findById(tx.id);
      assert.ok(updated);
      const notes = JSON.parse(updated.notes ?? '[]');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'Appended to legacy invoice');
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0].text, /Appended to legacy invoice/);
    });
  });
});
