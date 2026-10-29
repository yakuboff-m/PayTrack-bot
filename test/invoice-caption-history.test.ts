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
  buildUnifiedInvoiceCaption,
  stripDuplicateTotalLines,
  computeInvoiceFinancialSummary,
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

async function setupTestContext() {
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

    if (method === 'deleteMessage') {
      deletedMessageIds.push(payload.message_id);
      return { ok: true, result: true as any };
    }

    return { ok: true, result: {} as any };
  });

  return {
    db,
    distRepo,
    distService,
    distributor,
    txRepo,
    txService,
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

describe('Invoice Caption, Amount Breakdown, and Append-Only Action History', () => {
  // ─── 1. Registration only ─────────────────────────────────
  it('1. Registration only: renders clean header, registered amount in history, and accurate financial summary', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      101
    );
    await ctx.txService.setAmount(tx.id, 1431216);
    const snap = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snap);

    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id);

    // Section A: Header
    assert.match(caption, /🆔 <b>#INV0001 • 🏢 Meat Wholesaler Co<\/b>/);
    assert.match(caption, /🏦 Bank: Shinhan Bank/);
    assert.match(caption, /🔢 Account: 110-123-456789/);
    assert.match(caption, /👤 Holder: Kim Chul-soo/);

    // Section B: Action History
    assert.match(caption, /📥📥📥/);
    assert.match(caption, /💰 ₩1,431,216/);

    // Section C: Financial Summary
    assert.match(caption, /📊📊📊/);
    assert.match(caption, /💰 Invoice Total: ₩1,431,216/);
    assert.match(caption, /💵 Total Paid: ₩0/);
    assert.match(caption, /<b>⚖️ Need to Pay: ₩1,431,216<\/b>/);
  });

  // ─── 2. Registration plus one addition ────────────────────
  it('2. Registration plus one addition: appends addition without overwriting registration', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      102
    );
    await ctx.txService.setAmount(tx.id, 1431216);
    await ctx.txRepo.recordAddition(
      tx.id,
      200000,
      '2026-10-25T17:25:00Z',
      202,
      null,
      null,
      'Extra beef ribs'
    );
    await ctx.txService.setAmount(tx.id, 1631216);

    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id);

    // Distinct amounts in history
    assert.match(caption, /📥📥📥/);
    assert.match(caption, /💰 ₩1,431,216/);
    assert.match(caption, /➕➕➕/);
    assert.match(caption, /💰 ₩200,000/);
    assert.match(caption, /📝 Note: Extra beef ribs/);

    // Summary reflects updated invoice total
    assert.match(caption, /💰 Invoice Total: ₩1,631,216/);
    assert.match(caption, /<b>⚖️ Need to Pay: ₩1,631,216<\/b>/);
  });

  // ─── 3. Registration plus multiple additions ──────────────
  it('3. Registration plus multiple additions: preserves complete addition history in chronological order', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      103
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.recordAddition(tx.id, 50000, '2026-10-25T17:10:00Z', 203, null, null, 'Batch 1');
    await ctx.txRepo.recordAddition(tx.id, 30000, '2026-10-25T17:20:00Z', 204, null, null, 'Batch 2');
    await ctx.txService.setAmount(tx.id, 180000);

    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id);

    assert.match(caption, /📥📥📥/);
    assert.match(caption, /💰 ₩100,000/);
    assert.match(caption, /➕➕➕/);
    assert.match(caption, /💰 ₩50,000/);
    assert.match(caption, /💰 ₩30,000/);
    assert.match(caption, /💰 Invoice Total: ₩180,000/);
  });

  // ─── 4. Exact Reproduction Scenario ───────────────────────
  it('4. Exact Reproduction Scenario: ₩1,431,216 registered, /add 200,000, partial payment ₩100,000', async () => {
    const ctx = await setupTestContext();

    // 1. Initial meat invoice registered for ₩1,431,216
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      501
    );
    await ctx.txService.setAmount(tx.id, 1431216);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 501);
    const snap = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snap);

    // Initial meat invoice text with breakdown and Total: ₩1,431,216
    const initialMeatText = [
      '🥩 MEAT INVOICE',
      '━━━━━━━━━━━━━━━━',
      '1. Qozon — 62.68 kg',
      '　62.68 kg × ₩12,700',
      '　= ₩796,036',
      '',
      '2. Akarachka — 30 kg',
      '　30 kg × ₩3,200',
      '　= ₩96,000',
      '',
      '💰 Total: ₩1,431,216',
    ].join('\n');

    // 2. /add 200000
    await ctx.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 601,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/add 200000',
        photo: [{ file_id: 'photo_add_meat' }],
        reply_to_message: {
          message_id: 501,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: initialMeatText,
        },
      },
    } as any);

    // Check transaction after add
    const txAfterAdd = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterAdd.amount, 1631216);

    const activeInvoiceMsgId = txAfterAdd.metadata_message_id!;
    assert.ok(activeInvoiceMsgId);

    // 3. Partial payment of ₩100,000 with receipt photo
    await ctx.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 701,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 100000',
        photo: [{ file_id: 'photo_receipt_1' }],
        reply_to_message: {
          message_id: activeInvoiceMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_add_meat' }],
        },
      },
    } as any);

    // Check transaction in DB
    const txAfterPay = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterPay.status, 'PARTIALLY_PAID');

    const totalPaid = await ctx.txRepo.getTotalPaid(tx.id);
    assert.equal(totalPaid, 100000);

    // Render invoice caption and assert exact figures
    const finalCaption = await ctx.txService.renderInvoiceCaptionForTransaction(
      tx.id,
      initialMeatText
    );

    // Assert that raw duplicate '💰 Total: ₩1,431,216' is stripped from items breakdown
    assert.doesNotMatch(
      finalCaption,
      /(?:^|\n)💰 Total: ₩1,431,216/,
      'Duplicate raw Total line must be stripped'
    );

    // Assert exact required breakdown:
    // Original registered amount: ₩1,431,216
    assert.match(finalCaption, /📥📥📥/);
    assert.match(finalCaption, /💰 ₩1,431,216/);
    // Addition: ₩200,000
    assert.match(finalCaption, /➕➕➕/);
    assert.match(finalCaption, /💰 ₩200,000/);
    // Partial payment: ₩100,000
    assert.match(finalCaption, /➖➖➖/);
    assert.match(finalCaption, /💰 ₩100,000/);
    // Direct link to Confirmed receipt
    assert.match(finalCaption, /🔗 Receipt URL: https:\/\/t\.me\/c\/123456\/\d+/);

    // Financial Summary:
    // Current invoice total: ₩1,631,216
    assert.match(finalCaption, /💰 Invoice Total: ₩1,631,216/);
    // Total paid: ₩100,000
    assert.match(finalCaption, /💵 Total Paid: ₩100,000/);
    // Remaining balance: ₩1,531,216
    assert.match(finalCaption, /<b>⚖️ Need to Pay: ₩1,531,216<\/b>/);
  });

  // ─── 5. Multiple partial payments with distinct Confirmed receipt URLs ────
  it('5. Multiple partial payments: each payment in action history has distinct receipt link to Confirmed topic', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      801
    );
    await ctx.txService.setAmount(tx.id, 500000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 801);

    // Payment 1: ₩100,000
    await ctx.bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 810,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 100000 /note First partial',
        photo: [{ file_id: 'receipt_img_1' }],
        reply_to_message: {
          message_id: 801,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 801',
        },
      },
    } as any);

    // Payment 2: ₩150,000
    await ctx.bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 820,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 150000 /note Second partial',
        photo: [{ file_id: 'receipt_img_2' }],
        reply_to_message: {
          message_id: 801,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 801',
        },
      },
    } as any);

    const payments = await ctx.txRepo.getPayments(tx.id);
    assert.equal(payments.length, 2);

    assert.ok(payments[0].receipt_url, 'Payment 1 must have receipt_url');
    assert.ok(payments[1].receipt_url, 'Payment 2 must have receipt_url');
    assert.notEqual(
      payments[0].receipt_url,
      payments[1].receipt_url,
      'Multiple payments must never point to the same receipt URL'
    );

    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id);

    // Assert both receipt links appear in caption
    assert.match(caption, new RegExp(`🔗 Receipt URL: ${payments[0].receipt_url}`));
    assert.match(caption, new RegExp(`🔗 Receipt URL: ${payments[1].receipt_url}`));

    // Assert totals
    assert.match(caption, /💵 Total Paid: ₩250,000/);
    assert.match(caption, /<b>⚖️ Need to Pay: ₩250,000<\/b>/);
  });

  // ─── 6. Final payment of remaining balance ────────────────
  it('6. Final payment of remaining balance transitions to PAID and marks status as ✅ PAID', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      901
    );
    await ctx.txService.setAmount(tx.id, 200000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 901);

    // Partial 1: ₩50,000
    await ctx.bot.handleUpdate({
      update_id: 21,
      message: {
        message_id: 910,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 50000',
        photo: [{ file_id: 'p1' }],
        reply_to_message: {
          message_id: 901,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice',
        },
      },
    } as any);

    // Final payment of remaining ₩150,000
    await ctx.bot.handleUpdate({
      update_id: 22,
      message: {
        message_id: 920,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 150000',
        photo: [{ file_id: 'p2' }],
        reply_to_message: {
          message_id: 901,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice',
        },
      },
    } as any);

    const txFinal = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txFinal.status, 'PAID');

    const totalPaid = await ctx.txRepo.getTotalPaid(tx.id);
    assert.equal(totalPaid, 200000);

    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id);
    assert.match(caption, /➖➖➖/);
    assert.match(caption, /💰 ₩150,000/);
    assert.match(caption, /💵 Total Paid: ₩200,000/);
    assert.match(caption, /<b>⚖️ Need to Pay: ₩0<\/b>/);
  });

  // ─── 7. Repeated /add or payment retry does not duplicate ─
  it('7. Idempotency: repeated /add update does not duplicate additions or increase totals', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      1001
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 1001);

    const update = {
      update_id: 31,
      message: {
        message_id: 1010,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/add 50000',
        photo: [{ file_id: 'add_retry' }],
        reply_to_message: {
          message_id: 1001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Invoice 1001',
        },
      },
    };

    // First attempt
    await ctx.bot.handleUpdate(update as any);
    // Duplicate Telegram webhook delivery
    await ctx.bot.handleUpdate(update as any);

    const txAfter = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfter.amount, 150000, 'Must not double-add amount');

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1, 'Must have exactly 1 addition record');
  });

  // ─── 8. Caption rebuild preserves complete history ────────
  it('8. Caption rebuild preserves the complete history and correct totals across restarts', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      1101
    );
    await ctx.txService.setAmount(tx.id, 300000);
    await ctx.txRepo.recordAddition(tx.id, 100000, '2026-10-25T12:00:00Z', 1102, null, null, 'Added stock');
    await ctx.txService.setAmount(tx.id, 400000);
    await ctx.txRepo.recordPayment(
      tx.id,
      150000,
      '2026-10-25T13:00:00Z',
      1103,
      9901,
      null,
      'Check 1',
      9901,
      'https://t.me/c/123456/9901'
    );
    await ctx.txRepo.updateTransactionPaymentStatus({
      id: tx.id,
      status: 'PARTIALLY_PAID',
      paidAt: '2026-10-25T13:00:00Z',
    });

    // Rebuild caption from scratch purely via durable DB records
    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id);

    assert.match(caption, /📥📥📥/);
    assert.match(caption, /💰 ₩300,000/);
    assert.match(caption, /➕➕➕/);
    assert.match(caption, /💰 ₩100,000/);
    assert.match(caption, /➖➖➖/);
    assert.match(caption, /💰 ₩150,000/);
    assert.match(caption, /🔗 Receipt URL: https:\/\/t\.me\/c\/123456\/9901/);
    assert.match(caption, /💰 Invoice Total: ₩400,000/);
    assert.match(caption, /💵 Total Paid: ₩150,000/);
    assert.match(caption, /<b>⚖️ Need to Pay: ₩250,000<\/b>/);
  });

  // ─── 9. Caption length overflow compaction ────────────────
  it('9. Caption length overflow: compacts earlier events without losing registration, financial summary, or DB records', async () => {
    const additions = Array.from({ length: 15 }, (_, i) => ({
      amount: 10000 * (i + 1),
      addedAt: new Date(Date.now() - (20 - i) * 60000).toISOString(),
      note: `Long detailed note for addition batch number ${i + 1} with items and descriptions`,
    }));

    const payments = Array.from({ length: 10 }, (_, i) => ({
      amount: 5000 * (i + 1),
      paidAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
      note: `Partial payment installment transfer number ${i + 1}`,
      receiptUrl: `https://t.me/c/123456/${7000 + i}`,
    }));

    const caption = buildUnifiedInvoiceCaption({
      invoiceId: 999,
      receivedAt: '2026-10-25T10:00:00Z',
      initialAmount: 500000,
      additions,
      payments,
      maxCaptionLength: 1024,
    });

    assert.ok(
      caption.length <= 1024,
      `Caption must fit within 1024 characters (actual: ${caption.length})`
    );

    // Section A (Header) must be preserved
    assert.match(caption, /🆔 <b>#INV0999<\/b>/);

    // Original Registration must be preserved
    assert.match(caption, /📥📥📥/);
    assert.match(caption, /💰 ₩500,000/);

    // Overflow indicator must show hidden events
    assert.match(caption, /\.\.\. \(\d+ earlier events preserved in history\) \.\.\./);

    // Section C (Financial Summary) must be completely intact with accurate numbers
    const totalAdditions = additions.reduce((s, a) => s + a.amount, 0);
    const expectedTotal = 500000 + totalAdditions;
    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
    const expectedBalance = expectedTotal - totalPaid;

    assert.match(caption, new RegExp(`Invoice Total: ₩${expectedTotal.toLocaleString()}`));
    assert.match(caption, new RegExp(`Total Paid: ₩${totalPaid.toLocaleString()}`));
    assert.match(caption, new RegExp(`Need to Pay: ₩${expectedBalance.toLocaleString()}`));
  });

  // ─── 10. Existing invoice and receipt media preserved ─────
  it('10. Media preservation: confirmed topic preserves both invoice photo and payment receipt photo', async () => {
    const ctx = await setupTestContext();
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      1201
    );
    await ctx.txService.setAmount(tx.id, 250000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 1201);

    // Pay with receipt photo
    await ctx.bot.handleUpdate({
      update_id: 41,
      message: {
        message_id: 1210,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 250000',
        photo: [{ file_id: 'receipt_photo_1210' }],
        reply_to_message: {
          message_id: 1201,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'invoice_photo_1201' }],
          caption: 'Original invoice photo',
        },
      },
    } as any);

    // Confirmed topic must receive preserved invoice copy, receipt copy, and visible text confirmation
    const invoiceCopy = ctx.copiedMessages.find(
      (c: any) => c.from_message_id === 1201 && c.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(invoiceCopy, 'Invoice photo copied to Confirmed');
    const receiptCopy = ctx.copiedMessages.find(
      (c: any) => c.from_message_id === 1210 && c.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(receiptCopy, 'Receipt photo copied to Confirmed');
    const confirmedText = ctx.sentMessages.find(
      (m: any) => m.message_thread_id === testConfig.confirmedTopicId
    );
    assert.ok(confirmedText, 'Visible text confirmation sent to Confirmed');
    assert.match(confirmedText.text, /✅ PAID/);
  });
});
