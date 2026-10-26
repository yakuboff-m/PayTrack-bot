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

interface TestContextOptions {
  failTelegramSend?: boolean;
}

async function setupTestContext(options: TestContextOptions = {}) {
  const db = createInMemoryDb();
  const distRepo = new DistributorRepository(db);
  const distService = new DistributorService(distRepo);
  const txRepo = new TransactionRepository(db);
  const txService = new TransactionService(txRepo, testConfig);

  const distributor = await distService.create({
    name: 'Meat Wholesaler Co',
    alias: 'supplier',
    bankName: 'Shinhan Bank',
    accountNumber: '110-123-456789',
    accountHolder: 'Kim Chul-soo',
  });

  const apiCalls: Array<{ method: string; payload: any }> = [];
  const sentMessages: any[] = [];
  const sentMediaGroups: any[] = [];
  const editedCaptions: any[] = [];
  const editedTexts: any[] = [];
  const copiedMessages: any[] = [];
  const deletedMessageIds: number[] = [];

  const { bot } = createBot({
    config: testConfig,
    db,
    executionContext: { waitUntil: () => {} } as any,
  });

  bot.api.config.use(async (prev, method, payload: any) => {
    apiCalls.push({ method, payload });

    if (options.failTelegramSend && (method === 'sendMessage' || method === 'copyMessage' || method === 'sendMediaGroup')) {
      if (payload?.message_thread_id === testConfig.confirmedTopicId) {
        throw new Error('Telegram API 500: Internal Server Error');
      }
    }

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

    if (method === 'sendPhoto' || method === 'sendDocument') {
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
      const baseId = 8000 + sentMediaGroups.length * 10;
      sentMediaGroups.push(payload);
      const results = payload.media.map((m: any, idx: number) => ({
        message_id: baseId + idx,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
        ...m,
      }));
      return { ok: true, result: results as any };
    }

    if (method === 'copyMessage') {
      const id = 9000 + copiedMessages.length;
      copiedMessages.push({ ...payload, from_message_id: payload.message_id, message_id: id });
      return {
        ok: true,
        result: {
          message_id: id,
          chat: { id: payload.chat_id },
        } as any,
      };
    }

    if (method === 'editMessageText') {
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
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          chat: { id: payload.chat_id },
        } as any,
      };
    }

    if (method === 'deleteMessage') {
      deletedMessageIds.push(payload.message_id);
      return { ok: true, result: true as any };
    }

    return prev(method, payload);
  });

  async function createInvoice(msgId: number, amount: number) {
    const tx = await txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      msgId
    );
    const snapshot = distService.createSnapshot(distributor);
    await txService.assignDistributor(tx.id, distributor.id, snapshot);
    await txService.setAmount(tx.id, amount);
    await txRepo.updateMetadataMessageId(tx.id, msgId);
    return tx;
  }

  return {
    db,
    txRepo,
    txService,
    distService,
    distributor,
    createInvoice,
    bot,
    apiCalls,
    sentMessages,
    sentMediaGroups,
    editedCaptions,
    editedTexts,
    copiedMessages,
    deletedMessageIds,
  };
}

describe('Confirmed Topic Payment Records & Audit Trail Integration Tests', () => {
  it('1. First partial payment: creates identifiable confirmation and preserved receipt evidence', async () => {
    const ctx = await setupTestContext();
    const { bot, txRepo, sentMessages, copiedMessages, createInvoice } = ctx;

    // Register invoice for ₩500,000
    await createInvoice(1001, 500000);

    const tx = await txRepo.findById(1);
    assert.ok(tx);
    assert.equal(tx.amount, 500000);

    // First partial payment of ₩150,000 with receipt photo
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 1002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_1002', width: 800, height: 600 }],
        caption: '/paid 150000 first installment',
        reply_to_message: {
          message_id: 1001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_1001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩500,000',
        },
      },
    } as any);

    // Separate visible text message sent to Confirmed topic
    const confirmedTextMsgs = sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    );
    assert.equal(confirmedTextMsgs.length, 1);
    const textMsg = confirmedTextMsgs[0].text;
    assert.match(textMsg, /⏳ PARTIALLY PAID • #INV0001/);
    assert.match(textMsg, /🏢 Meat Wholesaler Co/);
    assert.match(textMsg, /💰 Total: ₩500,000/);
    assert.match(textMsg, /💵 Payment: ₩150,000/);
    assert.match(textMsg, /📊 Total Paid: ₩150,000/);
    assert.match(textMsg, /⚖️ Remaining Balance: ₩350,000/);
    assert.match(textMsg, /📝 Payment Note: first installment/);
    assert.match(textMsg, /🧾 Receipt: \[View payment receipt\]/);

    // Both invoice and receipt media copied into Confirmed as separate media messages
    const invoiceCopy = copiedMessages.find(
      (c) => c.from_message_id === 1001 && c.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(invoiceCopy, 'Invoice media copied to Confirmed');
    const receiptCopy = copiedMessages.find(
      (c) => c.from_message_id === 1002 && c.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(receiptCopy, 'Receipt media copied to Confirmed');

    // Verify DB transaction status
    const updatedTx = await txRepo.findById(1);
    assert.equal(updatedTx?.status, 'PARTIALLY_PAID');

    // Verify payment ledger entry
    const payments = await txRepo.getPayments(1);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amount, 150000);
    assert.equal(payments[0].cumulative_paid, 150000);
    assert.equal(payments[0].balance_due, 350000);
    assert.equal(payments[0].note, 'first installment');
    assert.ok(payments[0].receipt_url);
    assert.equal(payments[0].receipt_message_id, receiptCopy.message_id);
  });

  it('2. Multiple partial payments: each has its own confirmation, no redundant invoice copies', async () => {
    const ctx = await setupTestContext();
    const { bot, txRepo, sentMessages, copiedMessages, createInvoice } = ctx;

    // Register invoice for ₩500,000
    await createInvoice(2001, 500000);

    // First partial payment: ₩150,000
    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 2002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_2002', width: 800, height: 600 }],
        caption: '/paid 150000 p1',
        reply_to_message: {
          message_id: 2001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_2001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩500,000',
        },
      },
    } as any);

    const firstTextMsgs = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
    assert.equal(firstTextMsgs.length, 1, 'First payment sends text confirmation');
    const initialCopiedCount = copiedMessages.length;

    // Second partial payment: ₩200,000 with its own receipt
    await bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 2003,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_2003', width: 800, height: 600 }],
        caption: '/paid 200000 p2',
        reply_to_message: {
          message_id: 2001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_2001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩500,000',
        },
      },
    } as any);

    // CRITICAL REQUIREMENT: No redundant copy of invoice message on second payment!
    assert.equal(copiedMessages.length, initialCopiedCount + 1, 'Second payment copies only the receipt media');
    const secondPaymentReceiptCopy = copiedMessages[copiedMessages.length - 1];
    assert.equal(secondPaymentReceiptCopy.message_thread_id, testConfig.confirmedTopicId);
    assert.equal(secondPaymentReceiptCopy.from_message_id, 2003);

    // Second payment sends separate visible text confirmation message
    const allConfirmedTexts = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
    assert.equal(allConfirmedTexts.length, 2);
    const secondText = allConfirmedTexts[1].text;
    assert.match(secondText, /⏳ PARTIALLY PAID • #INV0001/);
    assert.match(secondText, /🏢 Meat Wholesaler Co/);
    assert.match(secondText, /💰 Total: ₩500,000/);
    assert.match(secondText, /💵 Payment: ₩200,000/);
    assert.match(secondText, /📊 Total Paid: ₩350,000/);
    assert.match(secondText, /⚖️ Remaining Balance: ₩150,000/);
    assert.match(secondText, /📝 Payment Note: p2/);
    assert.match(secondText, /🧾 Receipt: \[View payment receipt\]/);

    // Historical integrity: verify first payment amount in ledger was NOT overwritten
    const payments = await txRepo.getPayments(1);
    assert.equal(payments.length, 2);
    assert.equal(payments[0].amount, 150000, 'Payment 1 amount preserved');
    assert.equal(payments[0].cumulative_paid, 150000);
    assert.equal(payments[0].balance_due, 350000);

    assert.equal(payments[1].amount, 200000, 'Payment 2 amount correct');
    assert.equal(payments[1].cumulative_paid, 350000);
    assert.equal(payments[1].balance_due, 150000);
    assert.notEqual(payments[0].receipt_url, payments[1].receipt_url, 'Each payment has distinct receipt link');
  });

  it('3. Final payment clearing remaining balance: status PAID and balance ₩0', async () => {
    const ctx = await setupTestContext();
    const { bot, txRepo, sentMessages, copiedMessages, createInvoice } = ctx;

    // Register invoice for ₩500,000
    await createInvoice(3001, 500000);

    // Payment 1: ₩350,000
    await bot.handleUpdate({
      update_id: 21,
      message: {
        message_id: 3002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_3002', width: 800, height: 600 }],
        caption: '/paid 350000 installment',
        reply_to_message: {
          message_id: 3001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_3001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩500,000',
        },
      },
    } as any);

    // Payment 2 (Final): Pay remaining balance (no explicit amount given, pays ₩150,000 remaining)
    await bot.handleUpdate({
      update_id: 22,
      message: {
        message_id: 3003,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_3003', width: 800, height: 600 }],
        caption: '/paid final payment in full',
        reply_to_message: {
          message_id: 3001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_3001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩500,000',
        },
      },
    } as any);

    const tx = await txRepo.findById(1);
    assert.equal(tx?.status, 'PAID');

    const allConfirmedTexts = sentMessages.filter((m) => m.message_thread_id === testConfig.confirmedTopicId);
    assert.equal(allConfirmedTexts.length, 2);
    const finalConfirmation = allConfirmedTexts[allConfirmedTexts.length - 1].text;
    assert.match(finalConfirmation, /✅ PAID • #INV0001/);
    assert.match(finalConfirmation, /💵 Payment: ₩150,000/);
    assert.match(finalConfirmation, /📊 Total Paid: ₩500,000/);
    assert.match(finalConfirmation, /⚖️ Remaining Balance: ₩0/);

    const payments = await txRepo.getPayments(1);
    assert.equal(payments.length, 2);
    assert.equal(payments[1].amount, 150000);
    assert.equal(payments[1].cumulative_paid, 500000);
    assert.equal(payments[1].balance_due, 0);
  });

  it('4. Full payment in one operation: complete confirmation and receipt evidence', async () => {
    const ctx = await setupTestContext();
    const { bot, sentMessages, copiedMessages, createInvoice } = ctx;

    // Register invoice for ₩300,000
    await createInvoice(4001, 300000);

    // Full payment in one command
    await bot.handleUpdate({
      update_id: 31,
      message: {
        message_id: 4002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_4002', width: 800, height: 600 }],
        caption: '/paid Paid in full via Shinhan Bank',
        reply_to_message: {
          message_id: 4001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_4001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩300,000',
        },
      },
    } as any);

    const confirmedTextMsgs = sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    );
    assert.equal(confirmedTextMsgs.length, 1);
    const textMsg = confirmedTextMsgs[0].text;

    // Check header & details
    assert.match(textMsg, /✅ PAID • #INV0001/);
    assert.match(textMsg, /🏢 Meat Wholesaler Co/);
    assert.match(textMsg, /💰 Total: ₩300,000/);
    assert.match(textMsg, /💵 Payment: ₩300,000/);
    assert.match(textMsg, /📊 Total Paid: ₩300,000/);
    assert.match(textMsg, /⚖️ Remaining Balance: ₩0/);
    assert.match(textMsg, /🧾 Receipt: \[View payment receipt\]/);

    const invoiceCopy = copiedMessages.find(
      (c) => c.from_message_id === 4001 && c.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(invoiceCopy);
    const receiptCopy = copiedMessages.find(
      (c) => c.from_message_id === 4002 && c.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(receiptCopy);
  });

  it('5. Invoices with /add additions: confirms original amount, total added, and new total accurately', async () => {
    const ctx = await setupTestContext();
    const { bot, txRepo, sentMessages, createInvoice } = ctx;

    // Register original invoice: ₩200,000
    await createInvoice(5001, 200000);

    // Add ₩100,000 to invoice via /add
    await bot.handleUpdate({
      update_id: 41,
      message: {
        message_id: 5002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'invoice_photo_5002', width: 800, height: 600 }],
        caption: '/add 100000 additional cut',
        reply_to_message: {
          message_id: 5001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_5001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩200,000',
        },
      },
    } as any);

    const txAfterAdd = await txRepo.findById(1);
    assert.equal(txAfterAdd?.amount, 300000);
    assert.equal(txAfterAdd?.initial_amount, 200000);

    // Partial payment of ₩120,000
    await bot.handleUpdate({
      update_id: 42,
      message: {
        message_id: 5003,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_5003', width: 800, height: 600 }],
        caption: '/paid 120000',
        reply_to_message: {
          message_id: txAfterAdd?.metadata_message_id ?? 5001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_5001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE',
        },
      },
    } as any);

    // Text confirmation in Confirmed topic verifies breakdown
    const confirmedTextMsgs = sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    );
    assert.equal(confirmedTextMsgs.length, 1);
    const textMsg = confirmedTextMsgs[0].text;
    assert.match(textMsg, /📥 Original Invoice: ₩200,000/);
    assert.match(textMsg, /➕ Total Added: ₩100,000/);
    assert.match(textMsg, /💰 Updated Total: ₩300,000/);
    assert.match(textMsg, /💵 Payment: ₩120,000/);
    assert.match(textMsg, /📊 Total Paid: ₩120,000/);
    assert.match(textMsg, /⚖️ Remaining Balance: ₩180,000/);
    assert.match(textMsg, /🧾 Receipt: \[View payment receipt\]/);
  });

  it('6. Retry / idempotency: duplicated Telegram update does not duplicate payments or corrupt ledger', async () => {
    const ctx = await setupTestContext();
    const { bot, txRepo, sentMessages, createInvoice } = ctx;

    // Register invoice for ₩200,000
    await createInvoice(6001, 200000);

    const paymentUpdate = {
      update_id: 51,
      message: {
        message_id: 6002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_6002', width: 800, height: 600 }],
        caption: '/paid 200000',
        reply_to_message: {
          message_id: 6001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_6001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩200,000',
        },
      },
    };

    // First processing
    await bot.handleUpdate(paymentUpdate as any);
    const confirmedCount1 = sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    ).length;
    assert.equal(confirmedCount1, 1);
    const payments1 = await txRepo.getPayments(1);
    assert.equal(payments1.length, 1);

    // Retried update (Telegram network retry)
    await bot.handleUpdate(paymentUpdate as any);
    const confirmedCount2 = sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    ).length;
    assert.equal(confirmedCount2, 1, 'No duplicate confirmation sent to Telegram');
    const payments2 = await txRepo.getPayments(1);
    assert.equal(payments2.length, 1, 'No duplicate payment row inserted into ledger');
    assert.equal(payments2[0].amount, 200000);
  });

  it('7. Telegram send/copy failure: does not falsely confirm payment and rolls back safely', async () => {
    // Setup context with Telegram API failure simulator
    const ctx = await setupTestContext({ failTelegramSend: true });
    const { bot, txRepo, deletedMessageIds, createInvoice } = ctx;

    // Register invoice for ₩200,000
    await createInvoice(7001, 200000);

    // Attempt payment with Telegram failure
    await bot.handleUpdate({
      update_id: 61,
      message: {
        message_id: 7002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_7002', width: 800, height: 600 }],
        caption: '/paid 200000',
        reply_to_message: {
          message_id: 7001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_7001', width: 800, height: 600 }],
          caption: '🥩 MEAT INVOICE\n💰 Total: ₩200,000',
        },
      },
    } as any);

    // Verify transaction remains PENDING in database
    const tx = await txRepo.findById(1);
    assert.equal(tx?.status, 'PENDING');
    assert.equal(Boolean(tx?.paid_at), false);

    // Verify ledger has zero payments
    const payments = await txRepo.getPayments(1);
    assert.equal(payments.length, 0);

    // Verify original invoice 7001 was NOT deleted
    assert.ok(!deletedMessageIds.includes(7001), 'Original invoice must not be deleted on failure');
  });

  it('8. Plain text invoice with separate receipt: links confirmation record to receipt message and preserves evidence', async () => {
    const ctx = await setupTestContext();
    const { bot, txRepo, sentMessages, copiedMessages, editedTexts, createInvoice } = ctx;

    // Plain text invoice (no photo, no document)
    await createInvoice(8001, 150000);

    // Reply with receipt photo and /paid
    await bot.handleUpdate({
      update_id: 81,
      message: {
        message_id: 8002,
        from: { id: 111, is_bot: false, username: 'admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'receipt_photo_8002', width: 800, height: 600 }],
        caption: '/paid 150000 bank receipt',
        reply_to_message: {
          message_id: 8001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: '🥩 MEAT INVOICE\n💰 Total: ₩150,000',
        },
      },
    } as any);

    // Text confirmation sent to Confirmed topic
    const confirmedTextMsgs = sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    );
    assert.equal(confirmedTextMsgs.length, 1);

    // Receipt copied to Confirmed topic replying to confirmation message
    const receiptCopies = copiedMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId
    );
    assert.equal(receiptCopies.length, 1);
    assert.match(confirmedTextMsgs[0].text, /🧾 Receipt: \[View payment receipt\]/);

    // Payment ledger entry
    const payments = await txRepo.getPayments(1);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].receipt_message_id, receiptCopies[0].message_id);
    assert.ok(payments[0].receipt_url);
  });
});
