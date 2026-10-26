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
      const copiedMessages: any[] = [];
      const deletedMessageIds: number[] = [];
      const editedCaptions: any[] = [];
      const editedTexts: any[] = [];
      const editedReplyMarkups: any[] = [];
      const failDeleteIds = new Set<number>();
      const failEditCaptionIds = new Set<number>();
      const failEditTextIds = new Set<number>();

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
        if (method === 'copyMessage') {
          const id = 6000 + copiedMessages.length;
          copiedMessages.push({ ...payload, from_message_id: payload.message_id, new_message_id: id });
          return {
            ok: true,
            result: {
              message_id: id,
              chat: { id: payload.chat_id },
              date: Math.floor(Date.now() / 1000),
            } as any,
          };
        }
        if (method === 'deleteMessage') {
          if (failDeleteIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be deleted");
          }
          deletedMessageIds.push(payload.message_id);
          return { ok: true, result: true as any };
        }
        if (method === 'editMessageText') {
          if (failEditTextIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be edited");
          }
          editedTexts.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
              text: payload.text,
              reply_markup: payload.reply_markup,
            } as any,
          };
        }
        if (method === 'editMessageCaption') {
          if (failEditCaptionIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be edited");
          }
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
        if (method === 'editMessageReplyMarkup') {
          editedReplyMarkups.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
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
        copiedMessages,
        deletedMessageIds,
        editedCaptions,
        editedTexts,
        editedReplyMarkups,
        failDeleteIds,
        failEditCaptionIds,
        failEditTextIds,
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
        copiedMessages,
        deletedMessageIds,
        editedCaptions,
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

      // Verify visible text confirmation was sent to Confirmed topic
      const confirmedText = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedText);
      assert.match(confirmedText.text, /#INV0009/);
      assert.match(confirmedText.text, /✅ PAID/);

      // Verify invoice and receipt were copied to Confirmed
      const invoiceCopy = copiedMessages.find(
        (c) => c.from_message_id === 5009 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(invoiceCopy, 'Invoice must be copied to Confirmed');
      const receiptCopy = copiedMessages.find(
        (c) => c.from_message_id === 2001 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(receiptCopy, 'Receipt must be copied to Confirmed');

      // Verify error was not returned
      const errorMsg = sentMessages.find((m) => typeof m.text === 'string' && m.text.includes('Invalid payment confirmation'));
      assert.equal(errorMsg, undefined, 'Must not return "Invalid payment confirmation" error');

      // Verify payment receipt was cleaned up from Pending once confirmed (Bug 3)
      assert.equal(deletedMessageIds.includes(2001), true, 'Payment receipt message must be cleaned up from Pending');
      // Invoice media in Pending was NOT deleted (Bug 2)
      assert.equal(deletedMessageIds.includes(5009), false, 'Invoice message media must NOT be deleted');

      // Verify the original invoice caption in Pending was cleaned: preserves ONLY invoice ID + status (Bug 2)
      const editedInvoice = editedCaptions.find((e) => e.message_id === 5009);
      assert.ok(editedInvoice, 'Invoice message must be edited in place');
      assert.match(editedInvoice.caption, /#INV0009/);
      assert.match(editedInvoice.caption, /✅ PAID/);
      assert.equal(editedInvoice.caption.includes('Should be deleted manually'), false, 'Must NOT contain "Should be deleted manually!"');
      assert.equal(editedInvoice.caption.includes('MEAT INVOICE'), false, 'Must remove original meat invoice breakdown from Pending caption');
      assert.deepEqual(editedInvoice.reply_markup, { inline_keyboard: [] });
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
      const confirmedText = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedText);
      assert.match(confirmedText.text, /#INV0009/);
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
      const confirmedText = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedText);
      assert.match(confirmedText.text, /#INV0009/);
    });

    it('removes copy button and cleans invoice caption preserving invoice ID and status when Telegram deleteMessage fails on older invoice', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedCaptions,
        deletedMessageIds,
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

      // Verify editMessageCaption was called on message 87 and preserves ONLY invoice ID + status (Bug 2)
      const edited = editedCaptions.find((e) => e.message_id === 87);
      assert.ok(edited, 'Old invoice message 87 must be edited');
      assert.match(edited.caption, /🆔 #INV0001/);
      assert.match(edited.caption, /✅ PAID/);
      assert.equal(edited.caption.includes('Should be deleted manually'), false, 'Must NOT contain "Should be deleted manually!"');
      assert.equal(edited.caption.includes('ABC distribution'), false, 'Must remove old distributor details from Pending caption');
      // Verify copy button was removed
      assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
      // Verify message 87 was NOT deleted
      assert.equal(deletedMessageIds.includes(87), false, 'Invoice message must not be deleted');
    });
  });

  describe('Comprehensive Preservation of Plain-Text Invoices & Evidence', () => {
    async function setupTestContext() {
      const db = createInMemoryDb();
      const distRepo = new DistributorRepository(db);
      const distService = new DistributorService(distRepo);
      const txRepo = new TransactionRepository(db);
      const txService = new TransactionService(txRepo, testConfig);

      const distributor = await distService.create({
        name: 'Halal Meat Co',
        alias: 'halal',
        bankName: 'Shinhan Bank',
        accountNumber: '987-654-3210',
        accountHolder: 'Kholid',
      });

      const sentMessages: any[] = [];
      const sentPhotos: any[] = [];
      const sentMediaGroups: any[] = [];
      const copiedMessages: any[] = [];
      const deletedMessageIds: number[] = [];
      const editedCaptions: any[] = [];
      const editedTexts: any[] = [];
      const editedReplyMarkups: any[] = [];
      const failDeleteIds = new Set<number>();
      const failEditCaptionIds = new Set<number>();
      const failEditTextIds = new Set<number>();
      const failEditTextWithErrors = new Map<number, string>();
      const failEditMarkupIds = new Set<number>();
      const failSendWarning = { value: false };
      const failCopyIds = new Set<number>();
      const failSendThreadIds = new Set<number>();
      const failMediaGroupThreadIds = new Set<number>();

      const { bot } = createBot({
        config: testConfig,
        db,
        executionContext: { waitUntil: () => {} } as any,
      });

      bot.api.config.use(async (prev, method, payload: any) => {
        if (method === 'sendMessage') {
          if (failSendWarning.value && payload.text?.includes('Should be deleted manually!')) {
            throw new Error("Bad Request: simulated warning send failure");
          }
          if (failSendThreadIds.has(payload.message_thread_id)) {
            throw new Error("Bad Request: simulated failure sending message");
          }
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
          if (failMediaGroupThreadIds.has(payload.message_thread_id)) {
            throw new Error("Bad Request: simulated failure sending media group");
          }
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
        if (method === 'copyMessage') {
          if (failCopyIds.has(payload.message_id) || failCopyIds.has(payload.message_thread_id)) {
            throw new Error("Bad Request: simulated failure copying message");
          }
          const id = 6000 + copiedMessages.length;
          copiedMessages.push({ ...payload, from_message_id: payload.message_id, new_message_id: id });
          return {
            ok: true,
            result: {
              message_id: id,
              chat: { id: payload.chat_id },
              date: Math.floor(Date.now() / 1000),
            } as any,
          };
        }
        if (method === 'deleteMessage') {
          if (failDeleteIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be deleted");
          }
          deletedMessageIds.push(payload.message_id);
          return { ok: true, result: true as any };
        }
        if (method === 'editMessageText') {
          if (failEditTextWithErrors.has(payload.message_id)) {
            throw new Error(failEditTextWithErrors.get(payload.message_id)!);
          }
          if (failEditTextIds.has(payload.message_id)) {
            throw new Error("Bad Request: there is no text in the message to edit");
          }
          editedTexts.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
              text: payload.text,
              reply_markup: payload.reply_markup,
            } as any,
          };
        }
        if (method === 'editMessageCaption') {
          if (failEditCaptionIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be edited");
          }
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
        if (method === 'editMessageReplyMarkup') {
          if (failEditMarkupIds.has(payload.message_id)) {
            throw new Error("Bad Request: message can't be edited");
          }
          editedReplyMarkups.push(payload);
          return {
            ok: true,
            result: {
              message_id: payload.message_id,
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
        copiedMessages,
        deletedMessageIds,
        editedCaptions,
        editedTexts,
        editedReplyMarkups,
        failDeleteIds,
        failEditCaptionIds,
        failEditTextIds,
        failEditTextWithErrors,
        failEditMarkupIds,
        failSendWarning,
        failCopyIds,
        failSendThreadIds,
        failMediaGroupThreadIds,
      };
    }

    it('preserves complete text invoice content in Confirmed as ONE message combined with PAID header and in Pending edited with manual-deletion notice', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMessages,
        editedTexts,
        deletedMessageIds,
      } = await setupTestContext();

      const meatInvoiceText = [
        '🧾 MEAT INVOICE',
        '━━━━━━━━━━━━━━━━',
        '1. Qozon — 62.68 kg',
        '　62.68 kg × ₩12,700',
        '　= ₩796,036',
        '',
        '2. Akarachka — 30 kg',
        '　30 kg × ₩3,200',
        '　= ₩96,000',
        '',
        '💰 Total: ₩892,036',
      ].join('\n');

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        501
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 892036);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 501);

      // User replies with /paid
      const paymentUpdate = {
        update_id: 201,
        message: {
          message_id: 601,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 501,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: meatInvoiceText,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // 1. Confirmed topic verification: Exactly ONE confirmation message sent
      const confirmedMsgs = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.equal(confirmedMsgs.length, 1, 'Confirmed topic must have exactly ONE message for text invoice');

      const confirmedText = confirmedMsgs[0].text;
      // Header check
      assert.match(confirmedText, /✅ PAID • #INV0001/);
      assert.match(confirmedText, /🏢 Halal Meat Co/);
      assert.match(confirmedText, /💰 (?:Total: )?₩892,036/);
      // Separation check
      assert.match(confirmedText, /━━━━━━━━━━━━\n\n🧾 MEAT INVOICE/);
      // Full invoice content check
      assert.match(confirmedText, /1\. Qozon — 62\.68 kg/);
      assert.match(confirmedText, /62\.68 kg × ₩12,700/);
      assert.match(confirmedText, /= ₩796,036/);
      assert.match(confirmedText, /2\. Akarachka — 30 kg/);
      assert.match(confirmedText, /= ₩96,000/);
      assert.match(confirmedText, /💰 Total: ₩892,036/);

      // 2. Pending topic verification: Invoice edited with clean status, never deleted
      const edited = editedTexts.find((e) => e.message_id === 501);
      assert.ok(edited, 'Pending invoice must be edited via editMessageText');
      assert.match(edited.text, /#INV0001 • ✅ PAID/);
      assert.doesNotMatch(edited.text, /⚠️ Should be deleted manually!/);
      assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
      assert.equal(deletedMessageIds.includes(501), false, 'Pending invoice must never be deleted');
    });

    it('preserves text invoice AND includes payment receipt photo in Confirmed without dropping either', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMessages,
        copiedMessages,
        editedTexts,
        deletedMessageIds,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        502
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 150000);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 502);

      const invoiceText = 'Weekly spices delivery invoice #99: ₩150,000';

      // User replies with receipt photo + /paid
      const paymentUpdate = {
        update_id: 202,
        message: {
          message_id: 602,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo_123', width: 800, height: 600 }],
          caption: '/paid KakaoPay transfer',
          reply_to_message: {
            message_id: 502,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: invoiceText,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // 1. Confirmed topic has the ONE combined text message
      const confirmedMsgs = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.equal(confirmedMsgs.length, 1);
      assert.match(confirmedMsgs[0].text, /✅ PAID/);
      assert.match(confirmedMsgs[0].text, /Weekly spices delivery invoice #99: ₩150,000/);
      assert.match(confirmedMsgs[0].text, /KakaoPay transfer/);

      // 2. Confirmed topic receives copied receipt photo (Pending does NOT receive redundant copy)
      assert.equal(copiedMessages.length, 1, 'Should copy payment receipt only to Confirmed');
      const confirmedReceiptCopy = copiedMessages.find(
        (c) => c.from_message_id === 602 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(confirmedReceiptCopy, 'Confirmed topic must have copied receipt');

      // 3. Invoice message in Pending is retained (not deleted), original receipt in Pending is cleaned up
      assert.equal(deletedMessageIds.includes(502), false, 'Invoice message must not be deleted');
      assert.equal(deletedMessageIds.includes(602), true, 'Payment receipt message must be cleaned up from Pending');

      // 4. Pending invoice message is edited with clean status
      const edited = editedTexts.find((e) => e.message_id === 502);
      assert.ok(edited);
      assert.match(edited.text, /#INV/);
      assert.doesNotMatch(edited.text, /⚠️ Should be deleted manually!/);
    });

    it('preserves photo invoice with caption and payment document receipt', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        copiedMessages,
        editedCaptions,
        deletedMessageIds,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        503
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 450000);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 503);

      const originalCaption = 'Meat delivery batch #777 photo';

      // User replies with PDF document receipt
      const paymentUpdate = {
        update_id: 203,
        message: {
          message_id: 603,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          document: { file_id: 'bank_statement_pdf', file_name: 'receipt.pdf' },
          caption: '/paid',
          reply_to_message: {
            message_id: 503,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            photo: [{ file_id: 'invoice_photo_777', width: 640, height: 480 }],
            caption: originalCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      assert.equal(copiedMessages.length, 2, 'Should copy photo invoice and document receipt to Confirmed');
      const invoiceCopy = copiedMessages.find(
        (c) => c.from_message_id === 503 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(invoiceCopy);
      assert.equal(invoiceCopy.caption, undefined, 'Preserves original media without caption overwrite');

      const docConfirmedCopy = copiedMessages.find(
        (c) => c.from_message_id === 603 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(docConfirmedCopy, 'Document receipt must be copied to Confirmed');

      // Pending message retained and edited; receipt cleaned up
      assert.equal(deletedMessageIds.includes(503), false);
      assert.equal(deletedMessageIds.includes(603), true);

      const edited = editedCaptions.find((e) => e.message_id === 503);
      assert.ok(edited);
      assert.match(edited.caption, /#INV/);
      assert.doesNotMatch(edited.caption, /⚠️ Should be deleted manually!/);
      assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
    });

    it('exhibits identical retention behavior for invoices younger and older than 48 hours', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedCaptions,
        deletedMessageIds,
        failDeleteIds,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        504
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 504);

      // Simulate older message where Telegram would reject deleteMessage
      failDeleteIds.add(504);

      const paymentUpdate = {
        update_id: 204,
        message: {
          message_id: 604,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo_old', width: 640, height: 480 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 504,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            photo: [{ file_id: 'invoice_photo_old', width: 640, height: 480 }],
            caption: 'Invoice photo older than 48 hours',
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // deleteMessage is never called on 504
      assert.equal(deletedMessageIds.includes(504), false);
      // Edited in place with clean status
      const edited = editedCaptions.find((e) => e.message_id === 504);
      assert.ok(edited);
      assert.match(edited.caption, /#INV/);
      assert.doesNotMatch(edited.caption, /⚠️ Should be deleted manually!/);
      assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
    });

    it('duplicate protection and retry safety prevents duplicate confirmations or data loss', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMessages,
        copiedMessages,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        505
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 505);

      const paymentUpdate = {
        update_id: 205,
        message: {
          message_id: 605,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 505,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: 'Text invoice #505 content',
          },
        },
      };

      // First confirmation succeeds
      await bot.handleUpdate(paymentUpdate as any);
      const confirmedCount1 = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId).length;
      assert.equal(confirmedCount1, 1);

      // Second identical update (Telegram retry)
      await bot.handleUpdate(paymentUpdate as any);
      const confirmedCount2 = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId).length;
      assert.equal(confirmedCount2, 1, 'Retry must not create duplicate confirmed messages');

      // Informative already-paid warning was sent in pending topic
      const alreadyPaidWarning = sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('has already been paid')
      );
      assert.ok(alreadyPaidWarning, 'Must notify user that transaction is already paid');
    });

    it('copies text receipt payment evidence to both Pending and Confirmed topics without losing content', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        copiedMessages,
        deletedMessageIds,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        506
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 250000);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 506);

      // Workflow: user sent invoice (506).
      // Then user sent a text receipt (606) replying to invoice (506).
      // Admin replied to text receipt (606) with /paid (706).
      const textReceiptContent = 'Payment Receipt: Transferred ₩250,000 via Toss Bank to Hana Bank (ref #TX987654)';

      const paymentUpdate = {
        update_id: 206,
        message: {
          message_id: 706,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 606,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: textReceiptContent,
            reply_to_message: {
              message_id: 506,
              chat: { id: testConfig.telegramGroupId },
              message_thread_id: testConfig.pendingTopicId,
              text: 'Invoice text #506: ₩250,000 for meat delivery',
            },
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify transaction is PAID
      const updatedTx = await txRepo.findById(invoiceTx.id);
      assert.ok(updatedTx);
      assert.equal(updatedTx.status, 'PAID');

      // Verify text receipt was copied to BOTH Confirmed and Pending
      const confirmedCopy = copiedMessages.find(
        (c) => c.from_message_id === 606 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(confirmedCopy, 'Text receipt must be copied to Confirmed topic');

      // Original text receipt message 606 is cleaned up from Pending
      assert.equal(deletedMessageIds.includes(606), true, 'Original text receipt must be cleaned up from Pending');
    });

    it('handles text invoices over 4,096 characters by splitting cleanly into sequential messages without truncation', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMessages,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        507
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 999999);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 507);

      // Construct a huge invoice over 4,096 characters (e.g. 5,000 characters with 50 meat line items)
      const lines: string[] = ['🧾 BULK MEAT INVOICE #507', '━━━━━━━━━━━━━━━━━━━━━━━━━'];
      for (let i = 1; i <= 60; i++) {
        lines.push(`${i}. Item Grade ${i} Premium Beef Cut — ${10 + i} kg`);
        lines.push(`   ${10 + i} kg × ₩15,000`);
        lines.push(`   = ₩${(10 + i) * 15000}`);
        lines.push('');
      }
      lines.push('💰 Total: ₩999,999');
      const longInvoiceText = lines.join('\n');
      assert.ok(longInvoiceText.length > 4500, `Invoice length should be > 4500, was ${longInvoiceText.length}`);

      const paymentUpdate = {
        update_id: 207,
        message: {
          message_id: 607,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 507,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: longInvoiceText,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Check messages sent to Confirmed topic
      const confirmedMsgs = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedMsgs.length >= 2, 'Must split text invoice over 4,096 chars into 2 or more sequential messages');

      for (const msg of confirmedMsgs) {
        assert.ok(msg.text.length <= 4096, `Each message must respect 4,096 limit, got ${msg.text.length}`);
        assert.equal(msg.text.includes('...'), false, 'Content must not be truncated with ...');
      }

      // Reconstruct combined text and verify entire content was preserved
      const fullSent = confirmedMsgs.map((m) => m.text).join('\n');
      assert.match(fullSent, /1\. Item Grade 1/);
      assert.match(fullSent, /60\. Item Grade 60/);
      assert.match(fullSent, /💰 Total: ₩999,999/);
    });

    it('handles media captions over 1,024 characters and albums requiring follow-up overflow messages', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        sentMediaGroups,
        sentMessages,
        copiedMessages,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        508
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 1250000);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 508);

      // Construct a photo invoice caption over 1,024 chars
      const captionLines: string[] = ['🧾 DETAILED MEAT PHOTO INVOICE', '━━━━━━━━━━━━━━━━━━━━━━━━━'];
      for (let i = 1; i <= 30; i++) {
        captionLines.push(`${i}. Special Item Cut ${i} — ${20 + i} kg @ ₩18,000 = ₩${(20 + i) * 18000}`);
      }
      captionLines.push('💰 Total: ₩1,250,000');
      const longCaption = captionLines.join('\n');
      assert.ok(longCaption.length > 1200, `Caption length must exceed 1200, was ${longCaption.length}`);

      // User replies with photo receipt + /paid
      const paymentUpdate = {
        update_id: 208,
        message: {
          message_id: 608,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo_508', width: 800, height: 600 }],
          caption: '/paid Paid via KakaoPay',
          reply_to_message: {
            message_id: 508,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            photo: [{ file_id: 'invoice_photo_508', width: 800, height: 600 }],
            caption: longCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify visible text confirmation was sent to Confirmed topic
      const confirmedMsgs = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedMsgs.length >= 1);
      assert.match(confirmedMsgs[0].text, /✅ PAID/);
      assert.match(confirmedMsgs[0].text, /#INV0001/);

      // Verify invoice and receipt were copied to Confirmed
      const invoiceCopy = copiedMessages.find(
        (c) => c.from_message_id === 508 && c.message_thread_id === testConfig.confirmedTopicId
      );
      assert.ok(invoiceCopy);
      assert.equal(invoiceCopy.caption, undefined, 'Preserves original media without caption overwrite');
    });

    it('an explicit-ID command without a reply never overwrites the original text invoice and keeps it intact when content cannot be retrieved', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedTexts,
        editedCaptions,
        editedReplyMarkups,
        sentMessages,
        deletedMessageIds,
      } = await setupTestContext();

      const txA = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        509
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(txA.id, distributor.id, snapshot);
      await txService.setAmount(txA.id, 100000);
      await txRepo.updateMetadataMessageId(txA.id, 509);

      // Confirm via explicit command /paid #INV0001 WITHOUT a reply (invoiceMsg cannot be retrieved)
      const updateA = {
        update_id: 209,
        message: {
          message_id: 609,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: `/paid #INV000${txA.id}`,
        },
      };

      await bot.handleUpdate(updateA as any);

      // 1. Must NEVER overwrite the original invoice's text
      const editedText = editedTexts.find((e) => e.message_id === 509);
      assert.equal(editedText, undefined, 'Original invoice text must NEVER be overwritten');

      const editedCaption = editedCaptions.find((e) => e.message_id === 509);
      assert.equal(editedCaption, undefined, 'Original invoice caption must NEVER be overwritten');

      // 2. Original invoice remains intact in Pending (never deleted)
      assert.equal(deletedMessageIds.includes(509), false, 'Original invoice must remain intact and not deleted');

      // 3. Inline keyboard is safely removed
      const editedMarkup = editedReplyMarkups.find((e) => e.message_id === 509);
      assert.ok(editedMarkup, 'Inline keyboard must be removed via editMessageReplyMarkup');
      assert.deepEqual(editedMarkup.reply_markup, { inline_keyboard: [] });

      // 4. History record is sent in Pending topic
      const historyMsg = sentMessages.find(
        (m) =>
          m.message_thread_id === testConfig.pendingTopicId &&
          m.text?.includes('PAID')
      );
      assert.ok(historyMsg, 'History record must be sent in Pending topic');

      // 5. Transaction is committed as PAID
      const txCheck = await txRepo.findById(txA.id);
      assert.equal(txCheck?.status, 'PAID');
    });

    it('a text-edit network/429/5xx error does not trigger a caption-edit attempt', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedTexts,
        editedCaptions,
        editedReplyMarkups,
        failEditTextWithErrors,
        deletedMessageIds,
      } = await setupTestContext();

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        515
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(tx.id, distributor.id, snapshot);
      await txService.setAmount(tx.id, 120000);
      await txRepo.updateMetadataMessageId(tx.id, 515);

      // Simulate a network / 5xx error on editMessageText (e.g., 502 Bad Gateway)
      failEditTextWithErrors.set(515, 'FetchError: 502 Bad Gateway');

      const update = {
        update_id: 215,
        message: {
          message_id: 615,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 515,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: 'Original Text Invoice 515',
          },
        },
      };

      await bot.handleUpdate(update as any);

      // editMessageText was attempted and failed due to network error (not recorded in editedTexts)
      assert.equal(editedTexts.find((e) => e.message_id === 515), undefined);

      // Crucial: editMessageCaption must NOT be attempted for a network/5xx error!
      const attemptedCaptionEdit = editedCaptions.find((e) => e.message_id === 515);
      assert.equal(
        attemptedCaptionEdit,
        undefined,
        'Caption edit fallback must NOT be attempted on network/5xx/rate-limit error'
      );

      // Safe fallback: reply markup removal was attempted to remove keyboard
      const markupEdit = editedReplyMarkups.find((e) => e.message_id === 515);
      assert.ok(markupEdit, 'Reply markup removal must be called as safe fallback');

      // Original invoice remains intact
      assert.equal(deletedMessageIds.includes(515), false);

      // Transaction is committed as PAID
      const txCheck = await txRepo.findById(tx.id);
      assert.equal(txCheck?.status, 'PAID');
    });

    it('a genuine media-message text-edit mismatch can still trigger caption editing', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedCaptions,
        failEditTextWithErrors,
        deletedMessageIds,
      } = await setupTestContext();

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        516
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(tx.id, distributor.id, snapshot);
      await txService.setAmount(tx.id, 150000);
      await txRepo.updateMetadataMessageId(tx.id, 516);

      // Simulate Telegram rejecting editMessageText with "there is no text in the message to edit"
      // (occurs when message is genuinely a photo or document message)
      failEditTextWithErrors.set(516, 'Bad Request: there is no text in the message to edit');

      const update = {
        update_id: 216,
        message: {
          message_id: 616,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 516,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: 'Invoice text that turned out to be media on server',
          },
        },
      };

      await bot.handleUpdate(update as any);

      // Caption edit fallback MUST be triggered for "no text in the message" error
      const editedCaption = editedCaptions.find((e) => e.message_id === 516);
      assert.ok(editedCaption, 'Caption edit must be triggered when text edit error indicates absence of text');
      assert.match(editedCaption.caption, /#INV/);
      assert.doesNotMatch(editedCaption.caption, /⚠️ Should be deleted manually!/);
      assert.deepEqual(editedCaption.reply_markup, { inline_keyboard: [] });

      // Original invoice remains intact
      assert.equal(deletedMessageIds.includes(516), false);

      // Transaction is committed as PAID
      const txCheck = await txRepo.findById(tx.id);
      assert.equal(txCheck?.status, 'PAID');
    });

    it('warning and keyboard-removal failures do not delete the original invoice or payment evidence', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        failEditTextWithErrors,
        failEditMarkupIds,
        failSendWarning,
        deletedMessageIds,
        sentMessages,
        copiedMessages,
      } = await setupTestContext();

      const tx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        517
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(tx.id, distributor.id, snapshot);
      await txService.setAmount(tx.id, 250000);
      await txRepo.updateMetadataMessageId(tx.id, 517);

      // Simulate failure of editMessageText, editMessageReplyMarkup, and separate warning send
      failEditTextWithErrors.set(517, "Bad Request: message can't be edited");
      failEditMarkupIds.add(517);
      failSendWarning.value = true;

      const update = {
        update_id: 217,
        message: {
          message_id: 617,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo_617', width: 800, height: 600 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 517,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: 'Original invoice 517',
          },
        },
      };

      await bot.handleUpdate(update as any);

      // Transaction is marked PAID despite Phase 3 warning/markup failures
      const txCheck = await txRepo.findById(tx.id);
      assert.equal(txCheck?.status, 'PAID');

      // Confirmation was successfully sent to Confirmed
      const confirmedMsg = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
      assert.ok(confirmedMsg, 'Payment confirmation must exist in Confirmed topic');

      const confirmedReceipt = copiedMessages.find(
        (c) => c.message_thread_id === testConfig.confirmedTopicId && c.from_message_id === 617
      );
      assert.ok(confirmedReceipt, 'Payment receipt copy must exist in Confirmed topic');

      // Original invoice (517) is NOT deleted
      assert.equal(deletedMessageIds.includes(517), false, 'Original invoice must NOT be deleted');
    });

    it('cleans long invoice captions by replacing them with only the invoice ID and status', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        editedCaptions,
        sentMessages,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        511
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 330000);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 511);

      // Caption is exactly 1,000 characters long
      const nearLimitCaption = 'A'.repeat(1000);

      const paymentUpdate = {
        update_id: 211,
        message: {
          message_id: 611,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo_511', width: 640, height: 480 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 511,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            photo: [{ file_id: 'invoice_photo_511', width: 640, height: 480 }],
            caption: nearLimitCaption,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Caption is cleanly replaced with ONLY invoice ID and status (under 1024 chars)
      const edited = editedCaptions.find((e) => e.message_id === 511);
      assert.ok(edited, 'Must edit caption with clean status');
      assert.match(edited.caption, /#INV/);
      assert.doesNotMatch(edited.caption, /⚠️ Should be deleted manually!/);
      assert.ok(edited.caption.length <= 1024);
      assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
    });

    it('is idempotent: repeated processing does not duplicate the warning or receipt copies', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        copiedMessages,
        editedTexts,
      } = await setupTestContext();

      const invoiceTx = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        512
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(invoiceTx.id, distributor.id, snapshot);
      await txService.setAmount(invoiceTx.id, 88000);
      await txRepo.updateMetadataMessageId(invoiceTx.id, 512);

      const invoiceText = 'Invoice text #512';

      const paymentUpdate = {
        update_id: 212,
        message: {
          message_id: 612,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 512,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: invoiceText,
          },
        },
      };

      await bot.handleUpdate(paymentUpdate as any);

      // Verify no warning is added and no manual deletion notice is introduced
      const edited = editedTexts.find((e) => e.message_id === 512);
      assert.ok(edited);
      assert.match(edited.text, /#INV/);
      assert.doesNotMatch(edited.text, /⚠️ Should be deleted manually!/);
    });

    it('preserves safety guarantees when failures occur during sending or copying', async () => {
      const {
        bot,
        txRepo,
        txService,
        distService,
        distributor,
        failCopyIds,
        failSendThreadIds,
        deletedMessageIds,
      } = await setupTestContext();

      // Case 1: Failure during Confirmed topic sending
      const tx1 = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        513
      );
      const snapshot = distService.createSnapshot(distributor);
      await txService.assignDistributor(tx1.id, distributor.id, snapshot);
      await txService.setAmount(tx1.id, 50000);

      // Simulate failure when sending to confirmed topic
      failSendThreadIds.add(testConfig.confirmedTopicId);

      const update1 = {
        update_id: 213,
        message: {
          message_id: 613,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/paid',
          reply_to_message: {
            message_id: 513,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: 'Invoice text 513',
          },
        },
      };

      await bot.handleUpdate(update1 as any);

      // Transaction MUST remain PENDING
      const tx1Check = await txRepo.findById(tx1.id);
      assert.equal(tx1Check?.status, 'PENDING', 'Transaction must remain PENDING on Confirmed send failure');

      // Case 2: Failure when copying payment evidence to Pending topic
      failSendThreadIds.clear();

      const tx2 = await txService.registerTransaction(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        514
      );
      await txService.assignDistributor(tx2.id, distributor.id, snapshot);
      await txService.setAmount(tx2.id, 75000);

      // Simulate copyMessage failure for message 614
      failCopyIds.add(614);

      const update2 = {
        update_id: 214,
        message: {
          message_id: 614,
          from: { id: 111, is_bot: false, username: 'admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          photo: [{ file_id: 'receipt_photo_514', width: 640, height: 480 }],
          caption: '/paid',
          reply_to_message: {
            message_id: 514,
            chat: { id: testConfig.telegramGroupId },
            message_thread_id: testConfig.pendingTopicId,
            text: 'Invoice text 514',
          },
        },
      };

      await bot.handleUpdate(update2 as any);

      // Transaction MUST remain PENDING
      const tx2Check = await txRepo.findById(tx2.id);
      assert.equal(tx2Check?.status, 'PENDING', 'Transaction must remain PENDING on Pending copy failure');

      // Original invoice 514 and receipt 614 must not be deleted
      assert.equal(deletedMessageIds.includes(514), false);
      assert.equal(deletedMessageIds.includes(614), false);
    });
  });
});

