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
  extractInvoiceIdFromText,
  parseInvoiceId,
  formatInvoiceId,
} from '../src/bot/helpers/format.helpers';
import type { Config } from '../src/config/config';

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

describe('Regression: /paid with Receipt Image and #INV0009', () => {
  describe('Invoice ID Extraction Helpers', () => {
    it('extracts numeric invoice ID from various caption and text patterns', () => {
      assert.equal(extractInvoiceIdFromText('#INV0009'), 9);
      assert.equal(extractInvoiceIdFromText('🆔 #INV0009'), 9);
      assert.equal(extractInvoiceIdFromText('#INV-0009'), 9);
      assert.equal(extractInvoiceIdFromText('INV0009'), 9);
      assert.equal(extractInvoiceIdFromText('INV-0009'), 9);
      assert.equal(extractInvoiceIdFromText('#9'), 9);

      // Multiline photo invoice caption
      const photoCaption = [
        '🧾 MEAT INVOICE',
        '━━━━━━━━━━━━━━━━',
        '1. Qozon — 62.68 kg',
        '  62.68 kg × ₩12,700',
        '  = ₩796,036',
        '',
        '💰 Total: ₩796,036',
        '━━━━━━━━━━━━━━━━━━━━',
        '🆔 #INV0009',
        "🏢 Baraka Go'sht",
        '🏦 Hana Bank: 123-456-7890 (Ali Veli)',
        '📅 22 Oct 2026, 14:00',
      ].join('\n');
      assert.equal(extractInvoiceIdFromText(photoCaption), 9);
      assert.equal(parseInvoiceId(photoCaption), 9);

      // Non-matching inputs
      assert.equal(extractInvoiceIdFromText('No invoice here'), null);
      assert.equal(extractInvoiceIdFromText(''), null);
    });

    it('parseInvoiceId handles standard and caption-embedded formats', () => {
      assert.equal(parseInvoiceId('#INV0009'), 9);
      assert.equal(parseInvoiceId('🆔 #INV0009'), 9);
      assert.equal(parseInvoiceId('INV0009'), 9);
      assert.equal(parseInvoiceId('9'), 9);
      assert.equal(parseInvoiceId('#9'), 9);
    });
  });

  describe('Direct Reply with Receipt Image and /paid', () => {
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
      const sentPhotos: any[] = [];
      const sentMediaGroups: any[] = [];
      const deletedMessageIds: number[] = [];
      const editedCaptions: any[] = [];
      const failDeleteIds = new Set<number>();

      const { bot } = createBot({
        config: testConfig,
        db,
        executionContext: { waitUntil: () => {} } as any,
      });

      bot.api.config.use(async (prev, method, payload: any) => {
        if (method === 'sendMessage') {
          const id = 7000 + sentMessages.length;
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
        if (method === 'sendPhoto') {
          const id = 8000 + sentPhotos.length;
          sentPhotos.push({ ...payload, message_id: id });
          return {
            ok: true,
            result: {
              message_id: id,
              chat: { id: payload.chat_id },
              photo: [{ file_id: payload.photo }],
              caption: payload.caption,
              date: Math.floor(Date.now() / 1000),
            } as any,
          };
        }
        if (method === 'sendMediaGroup') {
          const id = 9000 + sentMediaGroups.length;
          sentMediaGroups.push({ ...payload, message_id: id });
          return {
            ok: true,
            result: payload.media.map((m: any, idx: number) => ({
              message_id: id + idx,
              chat: { id: payload.chat_id },
              photo: [{ file_id: m.media }],
              caption: m.caption,
              date: Math.floor(Date.now() / 1000),
            })) as any,
          };
        }
        if (method === 'deleteMessage') {
          if (failDeleteIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be deleted");
          }
          deletedMessageIds.push(payload.message_id);
          return { ok: true, result: true as any };
        }
        if (method === 'editMessageCaption') {
          editedCaptions.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
              caption: payload.caption,
              reply_markup: payload.reply_markup,
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
        sentPhotos,
        sentMediaGroups,
        deletedMessageIds,
        editedCaptions,
        failDeleteIds,
      };
    }

    it('successfully confirms invoice #INV0009 when user replies with receipt image and /paid', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMediaGroups,
        sentMessages,
        deletedMessageIds,
      } = await setupTestContext();

      // Create 8 dummy transactions so the 9th gets ID 9 (#INV0009)
      for (let i = 1; i <= 8; i++) {
        await txService.registerTransaction(
          String(testConfig.telegramGroupId),
          testConfig.pendingTopicId,
          1000 + i
        );
      }

      // 9th transaction: #INV0009
      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        1009
      );
      assert.equal(invoiceTx.id, 9);
      assert.equal(formatInvoiceId(invoiceTx.id), '#INV0009');

      // Assign distributor and amount
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 796036);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 5009);

      // User workflow:
      // Reply directly to #INV0009, attach payment receipt image, and send /paid as caption
      const invoiceCaption = [
        '🧾 MEAT INVOICE',
        '━━━━━━━━━━━━━━━━',
        '1. Qozon — 62.68 kg',
        '  62.68 kg × ₩12,700',
        '  = ₩796,036',
        '',
        '💰 Total: ₩796,036',
        '━━━━━━━━━━━━━━━━━━━━',
        '🆔 #INV0009',
        "🏢 Baraka Go'sht",
        '🏦 Hana Bank: 123-456-7890 (Ali Veli)',
      ].join('\n');

      const paymentUpdate = {
        update_id: 100,
        message: {
          message_id: 2001,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [
            { file_id: 'receipt_small_id', width: 320, height: 240 },
            { file_id: 'receipt_large_id', width: 1280, height: 960 },
          ],
          caption: '/paid',
          reply_to_message: {
            message_id: 5009,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            photo: [
              { file_id: 'invoice_small_id', width: 320, height: 240 },
              { file_id: 'invoice_large_id', width: 1280, height: 960 },
            ],
            caption: invoiceCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify transaction is PAID
      const updatedTx = await txRepo.findById(9);
      assert.ok(updatedTx);
      assert.equal(updatedTx.status, 'PAID');
      assert.ok(updatedTx.paid_at);

      // Verify media group album was sent to Confirmed topic with both invoice and receipt photos
      assert.equal(sentMediaGroups.length, 1);
      const mediaGroup = sentMediaGroups[0];
      assert.equal(mediaGroup.message_thread_id, testConfig.confirmedTopicId);
      assert.equal(mediaGroup.media.length, 2);
      assert.equal(mediaGroup.media[0].media, 'invoice_large_id');
      assert.equal(mediaGroup.media[1].media, 'receipt_large_id');
      assert.match(mediaGroup.media[0].caption, /#INV0009/);

      // Verify history record posted in Pending topic
      const historyMsg = sentMessages.find((m) => m.message_thread_id === testConfig.pendingTopicId);
      assert.ok(historyMsg);
      assert.match(historyMsg.text, /#INV0009/);

      // Verify ephemeral confirmation message was sent and not an error
      const errorMsg = sentMessages.find((m) => typeof m.text === 'string' && m.text.includes('Invalid payment confirmation'));
      assert.equal(errorMsg, undefined, 'Must not return "Invalid payment confirmation" error');

      // Verify pending messages were deleted
      assert.ok(deletedMessageIds.includes(2001), 'Payment message must be deleted');
      assert.ok(deletedMessageIds.includes(5009), 'Invoice message must be deleted');
    });

    it('recovers and confirms #INV0009 via photo caption fallback even if message_id was unmapped or chat ID had prefix variance', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMediaGroups,
        sentMessages,
      } = await setupTestContext();

      // Create 8 dummy transactions
      for (let i = 1; i <= 8; i++) {
        await txService.registerTransaction(
          String(testConfig.telegramGroupId),
          testConfig.pendingTopicId,
          2000 + i
        );
      }

      // Create #INV0009 in DB with original message 9999, but user replies to an unmapped message ID 7777
      // (e.g. forward, cached client ID, or unlinked bot edit)
      const invoiceTx = await txService.registerTransaction(
        '123456', // Saved without -100 prefix
        testConfig.pendingTopicId,
        9999
      );
      assert.equal(invoiceTx.id, 9);

      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 500000);

      // User replies to message 7777 whose caption explicitly has 🆔 #INV0009
      const invoiceCaption = [
        'Invoice Photo',
        '━━━━━━━━━━━━━━━━━━━━',
        '🆔 #INV0009',
        "🏢 Baraka Go'sht",
      ].join('\n');

      const paymentUpdate = {
        update_id: 101,
        message: {
          message_id: 3001,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' }, // -100123456
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo', width: 640, height: 480 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 7777, // Unmapped ID
            chat: { id: testConfig.telegramGroupId },
            photo: [{ file_id: 'invoice_photo', width: 640, height: 480 }],
            caption: invoiceCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify transaction 9 was successfully resolved and marked PAID
      const updatedTx = await txRepo.findById(9);
      assert.ok(updatedTx);
      assert.equal(updatedTx.status, 'PAID');

      // Verify no error message was returned
      const errorMsg = sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Invalid payment confirmation')
      );
      assert.equal(errorMsg, undefined, 'Must not return "Invalid payment confirmation"');
      assert.equal(sentMediaGroups.length, 1);
    });

    it('auto-recovers and confirms #INV0009 when replying with /paid even if transaction was not present in database', async () => {
      const {
        bot,
        txRepo,
        sentMediaGroups,
        sentMessages,
      } = await setupTestContext();

      // Database is completely fresh / empty: transaction 9 does NOT exist in DB
      const notFound = await txRepo.findById(9);
      assert.equal(notFound, undefined);

      // User replies to message 87 (which has 🆔 #INV0009 and ABC distribution)
      const invoiceCaption = [
        'Receipt Photo',
        '━━━━━━━━━━━━━━━━━━━━',
        '🆔 #INV0009',
        '🏢 ABC distribution',
        '🏦 Hana Bank',
        '💳 1234 1234 1234 1234',
        '👤 ABC distribution Co',
      ].join('\n');

      const paymentUpdate = {
        update_id: 102,
        message: {
          message_id: 4001,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'toss_receipt_photo', width: 640, height: 480 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 87,
            chat: { id: testConfig.telegramGroupId },
            photo: [{ file_id: 'original_invoice_photo', width: 640, height: 480 }],
            caption: invoiceCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify transaction 9 was auto-recovered and marked PAID
      const recoveredTx = await txRepo.findById(9);
      assert.ok(recoveredTx, 'Transaction 9 must be created and recovered');
      assert.equal(recoveredTx.status, 'PAID');
      assert.equal(recoveredTx.distributor_snapshot?.includes('ABC distribution'), true);

      // Verify no error message was returned
      const errorMsg = sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Invalid payment confirmation')
      );
      assert.equal(errorMsg, undefined, 'Must not return "Invalid payment confirmation"');
      assert.equal(sentMediaGroups.length, 1);
    });

    it('removes copy button and adds "Should be deleted manually!" notice when Telegram deleteMessage fails on older invoice', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedCaptions,
        failDeleteIds,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        85
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 87);

      // Simulate Telegram rejecting deleteMessage for 10-day-old invoice message 87
      failDeleteIds.add(87);

      const invoiceCaption = [
        '🆔 #INV0001',
        '🏢 ABC distribution',
        '🏦 Hana Bank: 1234 1234 1234 1234 (ABC distribution Co)',
      ].join('\n');

      const paymentUpdate = {
        update_id: 103,
        message: {
          message_id: 5001,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo', width: 640, height: 480 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 87,
            chat: { id: testConfig.telegramGroupId },
            photo: [{ file_id: 'invoice_photo', width: 640, height: 480 }],
            caption: invoiceCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify the transaction was confirmed as PAID
      const updatedTx = await txRepo.findById(invoiceTx.id);
      assert.ok(updatedTx);
      assert.equal(updatedTx.status, 'PAID');

      // Verify editMessageCaption was called on message 87
      const edited = editedCaptions.find((e) => e.message_id === 87);
      assert.ok(edited, 'Old invoice message 87 must be edited');
      assert.equal(edited.caption, '🔴 Should be deleted manually! 🔴');
      // Verify copy button was removed
      assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
    });
  });
});

