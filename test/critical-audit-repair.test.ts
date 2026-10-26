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

describe('Critical Transaction Workflow Audit & Repair Regression Suite', () => {
  async function setupTestContext() {
    const db = createInMemoryDb();
    const distRepo = new DistributorRepository(db);
    const distService = new DistributorService(distRepo);
    const txRepo = new TransactionRepository(db);
    const txService = new TransactionService(txRepo, testConfig);

    const distributor = await distService.create({
      name: 'Meat Wholesaler Co',
      alias: 'meat',
      bankName: 'Shinhan Bank',
      accountNumber: '110-123-456789',
      accountHolder: 'Kim Chul-soo',
    });

    const sentMessages: any[] = [];
    const sentMediaGroups: any[] = [];
    const copiedMessages: any[] = [];
    const deletedMessageIds: number[] = [];
    const editedCaptions: any[] = [];
    const editedTexts: any[] = [];
    const editedReplyMarkups: any[] = [];
    const failDeleteIds = new Set<number>();
    const failSendThreadIds = new Set<number>();
    const failEditErrors = new Map<number, string>();

    const { bot } = createBot({
      config: testConfig,
      db,
      executionContext: { waitUntil: () => {} } as any,
    });

    bot.api.config.use(async (prev, method, payload: any) => {
      if (method === 'sendMessage') {
        if (failSendThreadIds.has(payload.message_thread_id)) {
          throw new Error(`Telegram API Error: Failed to send to thread ${payload.message_thread_id}`);
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

      if (method === 'sendPhoto' || method === 'sendDocument') {
        if (failSendThreadIds.has(payload.message_thread_id)) {
          throw new Error(`Telegram API Error: Failed to send ${method} to thread ${payload.message_thread_id}`);
        }
        const id = 7500 + sentMessages.length;
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

      if (method === 'sendMediaGroup') {
        if (failSendThreadIds.has(payload.message_thread_id)) {
          throw new Error('Telegram API Error: sendMediaGroup failed');
        }
        const baseId = 8000 + sentMediaGroups.length * 10;
        const results = payload.media.map((m: any, idx: number) => ({
          message_id: baseId + idx,
          chat: { id: payload.chat_id },
          date: Math.floor(Date.now() / 1000),
          photo: m.type === 'photo' ? m.media : undefined,
          document: m.type === 'document' ? { file_id: m.media } : undefined,
          caption: m.caption,
          ...m,
        }));
        sentMediaGroups.push({ ...payload, results });
        sentMessages.push(...results);
        return { ok: true, result: results as any };
      }

      if (method === 'copyMessage') {
        if (failSendThreadIds.has(payload.message_thread_id)) {
          throw new Error('Telegram API Error: copyMessage failed');
        }
        const id = 9000 + copiedMessages.length;
        copiedMessages.push({ ...payload, from_message_id: payload.message_id, message_id: id });
        return { ok: true, result: { message_id: id } as any };
      }

      if (method === 'editMessageText') {
        if (failEditErrors.has(payload.message_id)) {
          throw new Error(failEditErrors.get(payload.message_id)!);
        }
        editedTexts.push(payload);
        return {
          ok: true,
          result: {
            message_id: payload.message_id,
            text: payload.text,
            chat: { id: payload.chat_id },
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
            chat: { id: payload.chat_id },
          } as any,
        };
      }

      if (method === 'editMessageReplyMarkup') {
        editedReplyMarkups.push(payload);
        return { ok: true, result: true as any };
      }

      if (method === 'deleteMessage') {
        if (failDeleteIds.has(payload.message_id)) {
          throw new Error('Bad Request: message can\'t be deleted');
        }
        deletedMessageIds.push(payload.message_id);
        return { ok: true, result: true as any };
      }

      return { ok: true, result: {} as any };
    });

    return {
      db,
      distRepo,
      distService,
      txRepo,
      txService,
      distributor,
      bot,
      sentMessages,
      sentMediaGroups,
      copiedMessages,
      deletedMessageIds,
      editedCaptions,
      editedTexts,
      editedReplyMarkups,
      failDeleteIds,
      failSendThreadIds,
      failEditErrors,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Partial payment leaves invoice PARTIALLY_PAID with correct balance
  // ─────────────────────────────────────────────────────────────
  it('Scenario 1: Partial payment leaves invoice PARTIALLY_PAID with correct balance and records payment', async () => {
    const { bot, txRepo, txService, distService, distributor, editedTexts } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      101
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 100000);
    await txRepo.updateMetadataMessageId(tx.id, 101);

    // Pay 40,000 out of 100,000
    const paymentUpdate = {
      update_id: 1,
      message: {
        message_id: 201,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid 40000 Deposit paid',
        reply_to_message: {
          message_id: 101,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 101 for beef: ₩100,000',
        },
      },
    };

    await bot.handleUpdate(paymentUpdate as any);

    const updatedTx = await txRepo.findById(tx.id);
    assert.ok(updatedTx);
    assert.equal(updatedTx.status, 'PARTIALLY_PAID');

    const payments = await txRepo.getPayments(tx.id);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amount, 40000);
    assert.equal(payments[0].note, 'Deposit paid');

    const totalPaid = await txRepo.getTotalPaid(tx.id);
    assert.equal(totalPaid, 40000);

    // Pending invoice message edited to reflect partial progress
    const edited = editedTexts.find((e) => e.message_id === 101);
    assert.ok(edited);
    assert.match(edited.text, /Total Paid: ₩40,000/);
    assert.match(edited.text, /⚖️ Need to Pay: ₩60,000/);
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Subsequent payment transitions PARTIALLY_PAID to PAID
  // ─────────────────────────────────────────────────────────────
  it('Scenario 2: Subsequent payment transitions PARTIALLY_PAID to PAID', async () => {
    const { bot, txRepo, txService, distService, distributor, editedTexts } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      102
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 100000);
    await txRepo.updateMetadataMessageId(tx.id, 102);

    // First payment: 40,000
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 202,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid 40000',
        reply_to_message: {
          message_id: 102,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 102: ₩100,000',
        },
      },
    } as any);

    // Second payment: 60,000 (covers remaining balance)
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 203,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid 60000',
        reply_to_message: {
          message_id: 102,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 102: ₩100,000',
        },
      },
    } as any);

    const finalTx = await txRepo.findById(tx.id);
    assert.ok(finalTx);
    assert.equal(finalTx.status, 'PAID');

    const payments = await txRepo.getPayments(tx.id);
    assert.equal(payments.length, 2);
    assert.equal(payments[0].amount, 40000);
    assert.equal(payments[1].amount, 60000);

    const totalPaid = await txRepo.getTotalPaid(tx.id);
    assert.equal(totalPaid, 100000);

    // Final pending invoice edit removes details and leaves clean ID + status
    const edited = editedTexts.filter((e) => e.message_id === 102);
    const lastEdit = edited[edited.length - 1];
    assert.ok(lastEdit);
    assert.match(lastEdit.text, /#INV/);
    assert.match(lastEdit.text, /✅ PAID/);
    assert.doesNotMatch(lastEdit.text, /Should be deleted manually/);
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Retrying same payment update is idempotent and does not count twice
  // ─────────────────────────────────────────────────────────────
  it('Scenario 3: Retrying the same payment update is idempotent and does not count twice', async () => {
    const { bot, txRepo, txService, distService, distributor, copiedMessages } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      103
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 50000);
    await txRepo.updateMetadataMessageId(tx.id, 103);

    const update = {
      update_id: 4,
      message: {
        message_id: 204,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_204', width: 640, height: 480 }],
        caption: '/paid 25000',
        reply_to_message: {
          message_id: 103,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 103: ₩50,000',
        },
      },
    };

    // First attempt
    await bot.handleUpdate(update as any);
    const paymentsFirst = await txRepo.getPayments(tx.id);
    assert.equal(paymentsFirst.length, 1);
    assert.equal(paymentsFirst[0].amount, 25000);
    const copiedCountFirst = copiedMessages.length;

    // Retry of the same update
    await bot.handleUpdate(update as any);
    const paymentsSecond = await txRepo.getPayments(tx.id);
    assert.equal(paymentsSecond.length, 1, 'Retry must not record duplicate payment');
    assert.equal(await txRepo.getTotalPaid(tx.id), 25000);
    assert.equal(copiedMessages.length, copiedCountFirst, 'Retry must not send duplicate copies');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Full payment produces correct final status
  // ─────────────────────────────────────────────────────────────
  it('Scenario 4: Full payment produces correct final status PAID', async () => {
    const { bot, txRepo, txService, distService, distributor } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      104
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 75000);
    await txRepo.updateMetadataMessageId(tx.id, 104);

    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 205,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid',
        reply_to_message: {
          message_id: 104,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 104: ₩75,000',
        },
      },
    } as any);

    const paidTx = await txRepo.findById(tx.id);
    assert.ok(paidTx);
    assert.equal(paidTx.status, 'PAID');
    assert.equal(await txRepo.getTotalPaid(tx.id), 75000);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Receipt with /paid in caption is not duplicated & cleaned from Pending
  // ─────────────────────────────────────────────────────────────
  it('Scenario 5: Receipt with /paid in caption is copied once to Confirmed and cleaned up from Pending', async () => {
    const { bot, txRepo, txService, distService, distributor, copiedMessages, sentMessages, deletedMessageIds } =
      await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      105
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 80000);
    await txRepo.updateMetadataMessageId(tx.id, 105);

    await bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 206,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_206', width: 640, height: 480 }],
        caption: '/paid KakaoPay transfer receipt',
        reply_to_message: {
          message_id: 105,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 105: ₩80,000',
        },
      },
    } as any);

    // Copied to Confirmed topic exactly once
    assert.equal(copiedMessages.length, 1);
    assert.equal(copiedMessages[0].message_thread_id, testConfig.confirmedTopicId);
    assert.equal(copiedMessages[0].from_message_id, 206);

    // Visible text confirmation message in Confirmed topic contains note
    const confirmedText = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
    assert.ok(confirmedText, 'Visible text confirmation message sent to Confirmed topic');
    assert.match(confirmedText.text, /KakaoPay transfer receipt/);

    // Original receipt in Pending (206) was deleted
    assert.equal(deletedMessageIds.includes(206), true);
    // Original invoice in Pending (105) was NOT deleted
    assert.equal(deletedMessageIds.includes(105), false);
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Original invoice caption cleanup preserves only ID + status text
  // ─────────────────────────────────────────────────────────────
  it('Scenario 6: Original invoice caption cleanup preserves only ID and status text without unwanted notice', async () => {
    const { bot, txRepo, txService, distService, distributor, editedCaptions } = await setupTestContext();

    const originalDetailedCaption = [
      '🧾 DETAILED MEAT INVOICE #106',
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      '1. Beef Ribs — 50 kg @ ₩15,000 = ₩750,000',
      '2. Lamb Chops — 20 kg @ ₩12,000 = ₩240,000',
      '💰 Total: ₩990,000',
      '🏦 Bank: Hana Bank 123-456-7890',
    ].join('\n');

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      106
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 990000);
    await txRepo.updateMetadataMessageId(tx.id, 106);

    await bot.handleUpdate({
      update_id: 7,
      message: {
        message_id: 207,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid',
        reply_to_message: {
          message_id: 106,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_106', width: 640, height: 480 }],
          caption: originalDetailedCaption,
        },
      },
    } as any);

    const edited = editedCaptions.find((e) => e.message_id === 106);
    assert.ok(edited, 'Caption must be edited');
    assert.match(edited.caption, /#INV/);
    assert.match(edited.caption, /✅ PAID/);
    assert.match(edited.caption, /🔗 Confirmation:/);
    // Detail breakdown and unwanted manual deletion text must be removed
    assert.doesNotMatch(edited.caption, /Beef Ribs/);
    assert.doesNotMatch(edited.caption, /Lamb Chops/);
    assert.doesNotMatch(edited.caption, /Should be deleted manually/);
    assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. /add does not trigger receipt confirmation
  // ─────────────────────────────────────────────────────────────
  it('Scenario 7: /add updates invoice amount and does NOT trigger receipt confirmation', async () => {
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

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      107
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 100000);
    await txRepo.updateMetadataMessageId(tx.id, 107);

    // User replies with photo + /add 50000 in caption
    await bot.handleUpdate({
      update_id: 8,
      message: {
        message_id: 208,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'extra_delivery_photo', width: 640, height: 480 }],
        caption: '/add 50000 Additional delivery batch',
        reply_to_message: {
          message_id: 107,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Initial delivery: ₩100,000',
        },
      },
    } as any);

    // Must NOT reply with "Receipt received!"
    const receiptReceivedMsg = sentMessages.find(
      (m) => typeof m.text === 'string' && m.text.includes('Receipt received')
    );
    assert.equal(receiptReceivedMsg, undefined, '/add must not trigger receipt confirmation');

    // Transaction amount must be updated to 100,000 + 50,000 = 150,000
    const updatedTx = await txRepo.findById(tx.id);
    assert.ok(updatedTx);
    assert.equal(updatedTx.amount, 150000);
    assert.equal(updatedTx.status, 'PENDING');

    // Original pending invoice message updated with notice and direct link
    const edited = editedTexts.find((e) => e.message_id === 107);
    assert.ok(edited, 'Pending invoice message must have update notice');
    assert.match(edited.text, /⚠️ Invoice #INV0001 was updated/);
    assert.match(edited.text, /View updated invoice/);

    // New photo message sent with updated total and addition details
    const newPhotoMsg = sentMessages.find((m) => m.photo === 'extra_delivery_photo');
    assert.ok(newPhotoMsg, 'New invoice photo message must be sent');
    assert.match(newPhotoMsg.caption, /Invoice Total: ₩150,000/);
    assert.match(newPhotoMsg.caption, /Amount Added:\n└─> 💰 ₩50,000/);
    assert.match(newPhotoMsg.caption, /Need to Pay: ₩150,000/);

    // Assert replacement account control message was sent
    const accountDetailsMsgs = sentMessages.filter(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(accountDetailsMsgs.length, 1, 'Must have replacement account-control message');

    // Admin /add message was deleted
    assert.ok(deletedMessageIds.includes(208), 'Admin /add message must be deleted');
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Confirmed layout preservation (album for photo+photo)
  // ─────────────────────────────────────────────────────────────
  it('Scenario 8: Confirmed layout sends separate text message and preserved media copies', async () => {
    const { bot, txRepo, txService, distService, distributor, sentMessages, copiedMessages } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      108
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 200000);
    await txRepo.updateMetadataMessageId(tx.id, 108);

    await bot.handleUpdate({
      update_id: 9,
      message: {
        message_id: 209,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_209', width: 640, height: 480 }],
        caption: '/paid Paid in full via bank transfer',
        reply_to_message: {
          message_id: 108,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_108', width: 640, height: 480 }],
          caption: 'Meat invoice #108 delivery',
        },
      },
    } as any);

    const confirmedText = sentMessages.find((m) => m.message_thread_id === testConfig.confirmedTopicId);
    assert.ok(confirmedText, 'Visible text confirmation message sent to Confirmed topic');
    assert.match(confirmedText.text, /✅ PAID/);

    const copiedInvoice = copiedMessages.find((c) => c.from_message_id === 108 && c.message_thread_id === testConfig.confirmedTopicId);
    assert.ok(copiedInvoice, 'Original invoice media copied to Confirmed');
    assert.equal(copiedInvoice.caption, undefined, 'Preserves original media without overwriting caption');

    const copiedReceipt = copiedMessages.find((c) => c.from_message_id === 209 && c.message_thread_id === testConfig.confirmedTopicId);
    assert.ok(copiedReceipt, 'Receipt media copied to Confirmed');
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Original Pending messages only cleaned up after confirmed copies succeed
  // ─────────────────────────────────────────────────────────────
  it('Scenario 9: Pending receipt is only cleaned up after Confirmed copy and DB commit succeed', async () => {
    const { bot, txRepo, txService, distService, distributor, failSendThreadIds, deletedMessageIds } =
      await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      109
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 65000);
    await txRepo.updateMetadataMessageId(tx.id, 109);

    // Simulate failure in sending to Confirmed topic
    failSendThreadIds.add(testConfig.confirmedTopicId);

    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 210,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_210', width: 640, height: 480 }],
        caption: '/paid',
        reply_to_message: {
          message_id: 109,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 109',
        },
      },
    } as any);

    // Receipt in Pending MUST NOT be deleted because confirmation copy failed
    assert.equal(deletedMessageIds.includes(210), false);
    // Transaction status MUST remain PENDING
    const checkTx = await txRepo.findById(tx.id);
    assert.equal(checkTx?.status, 'PENDING');
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Failed Telegram API call does not silently produce falsely paid transaction
  // ─────────────────────────────────────────────────────────────
  it('Scenario 10: Failed Telegram API call does not produce falsely paid transaction', async () => {
    const { txRepo, txService, distService, distributor } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      110
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 45000);

    const fakeApi = {
      sendMediaGroup: async () => {
        throw new Error('Telegram API Network Timeout');
      },
      sendMessage: async () => {
        throw new Error('Telegram API Network Timeout');
      },
      copyMessage: async () => {
        throw new Error('Telegram API Network Timeout');
      },
    } as any;

    const result = await txService.executeConfirmation(
      fakeApi,
      tx,
      211,
      { message_id: 110, text: 'Invoice 110' } as any,
      { message_id: 211, text: '/paid' } as any
    );

    assert.equal(result.success, false);
    const checkTx = await txRepo.findById(tx.id);
    assert.equal(checkTx?.status, 'PENDING');
  });

  // ─────────────────────────────────────────────────────────────
  // 11. Repeated commands do not create duplicate history or payments
  // ─────────────────────────────────────────────────────────────
  it('Scenario 11: Repeated /paid commands on already paid invoice do not create duplicate payments or messages', async () => {
    const { bot, txRepo, txService, distService, distributor, sentMessages } = await setupTestContext();

    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      111
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, 50000);
    await txRepo.updateMetadataMessageId(tx.id, 111);

    const update1 = {
      update_id: 11,
      message: {
        message_id: 212,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid',
        reply_to_message: {
          message_id: 111,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 111: ₩50,000',
        },
      },
    };

    await bot.handleUpdate(update1 as any);
    const confirmedCount1 = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId).length;
    assert.equal(confirmedCount1, 1);

    // User or admin sends another /paid on the same invoice
    const update2 = {
      update_id: 12,
      message: {
        message_id: 213,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/paid',
        reply_to_message: {
          message_id: 111,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 111: ₩50,000',
        },
      },
    };

    await bot.handleUpdate(update2 as any);
    const confirmedCount2 = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId).length;
    assert.equal(confirmedCount2, 1, 'Must not duplicate confirmed message');

    const payments = await txRepo.getPayments(tx.id);
    assert.equal(payments.length, 1, 'Must not create duplicate payment record');
  });

  // ─────────────────────────────────────────────────────────────
  // 12. Existing /confirmed, /amount, /note, and alias workflows still work
  // ─────────────────────────────────────────────────────────────
  it('Scenario 12: Existing /confirmed, /amount, /note, and distributor alias workflows work without interference', async () => {
    const { bot, txRepo, txService, distService, distributor, editedTexts } = await setupTestContext();

    // 1. Auto-register invoice via text
    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      112
    );
    await txRepo.updateMetadataMessageId(tx.id, 112);

    // 2. Assign distributor via alias /meat
    await bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 214,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/meat',
        reply_to_message: {
          message_id: 112,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'New order text',
        },
      },
    } as any);

    let check = await txRepo.findById(tx.id);
    assert.equal(check?.distributor_id, distributor.id);

    // 3. Set amount via /amount 300,000
    await bot.handleUpdate({
      update_id: 14,
      message: {
        message_id: 215,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/amount 300000',
        reply_to_message: {
          message_id: 112,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'New order text',
        },
      },
    } as any);

    check = await txRepo.findById(tx.id);
    assert.equal(check?.amount, 300000);

    // 4. Add note via /note
    await bot.handleUpdate({
      update_id: 15,
      message: {
        message_id: 216,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/note Quality approved by chef',
        reply_to_message: {
          message_id: 112,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'New order text',
        },
      },
    } as any);

    check = await txRepo.findById(tx.id);
    const notes = JSON.parse(check?.notes ?? '[]');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, 'Quality approved by chef');

    // 5. Confirm via legacy /confirmed command
    await bot.handleUpdate({
      update_id: 16,
      message: {
        message_id: 217,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        text: '/confirmed',
        reply_to_message: {
          message_id: 112,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'New order text',
        },
      },
    } as any);

    check = await txRepo.findById(tx.id);
    assert.equal(check?.status, 'PAID');
  });

  // ─────────────────────────────────────────────────────────────
  // 13. Old invoices and forum topic service messages remain correctly handled
  // ─────────────────────────────────────────────────────────────
  it('Scenario 13: Old invoices (> 48h) and forum topic service messages are handled safely', async () => {
    const { bot, txRepo, txService, distService, distributor, failDeleteIds, deletedMessageIds, editedCaptions } =
      await setupTestContext();

    // Case A: Forum topic creation service message does NOT register a transaction
    await bot.handleUpdate({
      update_id: 17,
      message: {
        message_id: 999,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        forum_topic_created: {
          name: 'Pending Invoices',
          icon_color: 7322096,
        },
      },
    } as any);

    const checkServiceTx = await txRepo.findByMessageId(String(testConfig.telegramGroupId), 999);
    assert.equal(checkServiceTx, undefined, 'Forum topic service message must not register a transaction');

    // Case B: Invoice older than 48 hours where Telegram rejects deleteMessage
    const txOld = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      113
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(txOld.id, distributor.id, snapshot);
    await txService.setAmount(txOld.id, 120000);
    await txRepo.updateMetadataMessageId(txOld.id, 113);

    failDeleteIds.add(113);

    await bot.handleUpdate({
      update_id: 18,
      message: {
        message_id: 218,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_old', width: 640, height: 480 }],
        caption: '/paid',
        reply_to_message: {
          message_id: 113,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'old_invoice_photo', width: 640, height: 480 }],
          caption: 'Old Invoice 113 photo',
        },
      },
    } as any);

    // Old invoice 113 was NOT deleted
    assert.equal(deletedMessageIds.includes(113), false);
    // Caption was cleanly edited
    const edited = editedCaptions.find((e) => e.message_id === 113);
    assert.ok(edited);
    assert.match(edited.caption, /#INV/);
    assert.match(edited.caption, /✅ PAID/);
    assert.doesNotMatch(edited.caption, /Should be deleted manually/);

    const paidTx = await txRepo.findById(txOld.id);
    assert.equal(paidTx?.status, 'PAID');
  });
});
