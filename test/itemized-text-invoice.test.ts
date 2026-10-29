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
import { isItemizedInvoiceText } from '../src/bot/helpers/format.helpers';

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
    name: 'Halal Meat Wholesale',
    alias: 'halalmeat',
    bankName: 'Shinhan Bank',
    accountNumber: '110-123-456789',
    accountHolder: 'Kim Min-su',
  });

  const apiCalls: Array<{ method: string; payload: any }> = [];
  const sentMessages: any[] = [];
  const editedTexts: any[] = [];
  const editedCaptions: any[] = [];
  const sentMediaGroups: any[] = [];

  const { bot } = createBot({
    config: testConfig,
    db,
    executionContext: { waitUntil: () => {} } as any,
  });

  bot.api.config.use(async (_prev, method, payload: any) => {
    apiCalls.push({ method, payload });

    if (method === 'sendMessage') {
      const id = 7000 + sentMessages.length;
      const msg = {
        message_id: id,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
        ...payload,
      };
      sentMessages.push(msg);
      return { ok: true, result: msg as any };
    }

    if (method === 'sendPhoto' || method === 'sendDocument') {
      const id = 7500 + sentMessages.length;
      const msg = {
        message_id: id,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
        ...payload,
      };
      sentMessages.push(msg);
      return { ok: true, result: msg as any };
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

    if (method === 'editMessageText') {
      editedTexts.push(payload);
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          chat: { id: payload.chat_id },
          text: payload.text,
          date: Math.floor(Date.now() / 1000),
        } as any,
      };
    }

    if (method === 'editMessageCaption') {
      editedCaptions.push(payload);
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          chat: { id: payload.chat_id },
          caption: payload.caption,
          date: Math.floor(Date.now() / 1000),
        } as any,
      };
    }

    if (method === 'deleteMessage') {
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
    apiCalls,
    sentMessages,
    editedTexts,
    editedCaptions,
    sentMediaGroups,
  };
}

describe('Itemized Text Invoice Preservation and Type Separation Test Suite', () => {
  const realisticItemizedInvoice = [
    '🥩 MEAT INVOICE',
    '━━━━━━━━━━━━━━━━',
    '1. Mol go\'shti (lahm) — 45.5 kg',
    '　45.5 kg × ₩14,500',
    '　= ₩659,750',
    '',
    '2. Qovurg\'a (ribs) — 32.0 kg',
    '　32.0 kg × ₩13,000',
    '　= ₩416,000',
    '',
    '3. Qo\'y go\'shti — 28.4 kg',
    '　28.4 kg × ₩15,200',
    '　= ₩431,680',
    '',
    '4. Qiyma (minced) — 50.0 kg',
    '　50.0 kg × ₩11,843',
    '　= ₩592,150',
    '',
    '💰 Total: ₩2,099,580',
  ].join('\n');

  it('1. Itemized Text Invoice: registers, preserves all items upon /add, updates history and totals', async () => {
    const ctx = await setupTestContext();

    // 1. Auto-register realistic itemized text invoice
    await ctx.bot.handleUpdate({
      update_id: 100,
      message: {
        message_id: 1001,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: realisticItemizedInvoice,
      },
    } as any);

    const tx = await ctx.txService.findByAnyMessageId(String(testConfig.telegramGroupId), 1001);
    assert.ok(tx, 'Transaction must be registered');
    assert.equal(tx.invoiceType, 'ITEMIZED_TEXT', 'Invoice type must be ITEMIZED_TEXT');
    assert.ok(tx.originalText, 'originalText must be stored');
    assert.equal(tx.originalText, realisticItemizedInvoice.trim());

    // Assign distributor and initial amount
    const snap = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snap);
    await ctx.txService.setAmount(tx.id, 2099580);

    // 2. Run /add 200,000 with note
    await ctx.bot.handleUpdate({
      update_id: 101,
      message: {
        message_id: 1002,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/add 200,000 òtgan safargi ostatka',
        reply_to_message: {
          message_id: 1001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: realisticItemizedInvoice,
        },
      },
    } as any);

    // Verify DB state
    const txAfterFirstAdd = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterFirstAdd.invoice_type, 'ITEMIZED_TEXT');
    assert.equal(txAfterFirstAdd.original_text, realisticItemizedInvoice.trim());
    assert.equal(txAfterFirstAdd.amount, 2099580 + 200000);

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].amount, 200000);
    assert.equal(additions[0].note, 'òtgan safargi ostatka');

    // Verify edited text in Telegram preserves ALL items and details
    assert.ok(ctx.editedTexts.length >= 1, 'Message must be edited in place');
    const lastEditedText = ctx.editedTexts[ctx.editedTexts.length - 1].text;

    // Every item and line total must be present
    assert.ok(lastEditedText.includes('1. Mol go\'shti (lahm) — 45.5 kg'));
    assert.ok(lastEditedText.includes('45.5 kg × ₩14,500'));
    assert.ok(lastEditedText.includes('= ₩659,750'));
    assert.ok(lastEditedText.includes('2. Qovurg\'a (ribs) — 32.0 kg'));
    assert.ok(lastEditedText.includes('32.0 kg × ₩13,000'));
    assert.ok(lastEditedText.includes('= ₩416,000'));
    assert.ok(lastEditedText.includes('3. Qo\'y go\'shti — 28.4 kg'));
    assert.ok(lastEditedText.includes('28.4 kg × ₩15,200'));
    assert.ok(lastEditedText.includes('= ₩431,680'));
    assert.ok(lastEditedText.includes('4. Qiyma (minced) — 50.0 kg'));
    assert.ok(lastEditedText.includes('50.0 kg × ₩11,843'));
    assert.ok(lastEditedText.includes('= ₩592,150'));

    // Check Action History contains addition exactly once
    assert.ok(lastEditedText.includes('➕➕➕'));
    assert.ok(lastEditedText.includes('₩200,000'));
    assert.ok(lastEditedText.includes('📝 Note: òtgan safargi ostatka'));

    // Check Financial Summary
    assert.ok(lastEditedText.includes('💰 Invoice Total: ₩2,299,580'));
    assert.ok(lastEditedText.includes('💵 Total Paid: ₩0'));
    assert.ok(lastEditedText.includes('<b>⚖️ Need to Pay: ₩2,299,580</b>'));

    // 3. Run /add 50,000 second addition with note
    await ctx.bot.handleUpdate({
      update_id: 102,
      message: {
        message_id: 1003,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/add 50,000 delivery fee',
        reply_to_message: {
          message_id: 1001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: lastEditedText,
        },
      },
    } as any);

    const txAfterSecondAdd = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterSecondAdd.amount, 2099580 + 200000 + 50000);
    const additions2 = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions2.length, 2);

    const textAfterSecondAdd = ctx.editedTexts[ctx.editedTexts.length - 1].text;
    // Confirm ALL original items remain
    assert.ok(textAfterSecondAdd.includes('1. Mol go\'shti (lahm) — 45.5 kg'));
    assert.ok(textAfterSecondAdd.includes('4. Qiyma (minced) — 50.0 kg'));
    // Both additions present
    assert.ok(textAfterSecondAdd.includes('₩200,000'));
    assert.ok(textAfterSecondAdd.includes('òtgan safargi ostatka'));
    assert.ok(textAfterSecondAdd.includes('₩50,000'));
    assert.ok(textAfterSecondAdd.includes('delivery fee'));
    // Updated total
    assert.ok(textAfterSecondAdd.includes('💰 Invoice Total: ₩2,349,580'));

    // 4. Run /note command on this invoice
    await ctx.bot.handleUpdate({
      update_id: 103,
      message: {
        message_id: 1004,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/note Verified by store manager',
        reply_to_message: {
          message_id: 1001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: textAfterSecondAdd,
        },
      },
    } as any);

    const textAfterNote = ctx.editedTexts[ctx.editedTexts.length - 1].text;
    assert.ok(textAfterNote.includes('1. Mol go\'shti (lahm) — 45.5 kg'));
    assert.ok(textAfterNote.includes('4. Qiyma (minced) — 50.0 kg'));
    assert.ok(textAfterNote.includes('Verified by store manager'));

    // 5. Simulate restart / reload persisted transaction from DB
    const freshTxRepo = new TransactionRepository(ctx.db);
    const freshTxService = new TransactionService(freshTxRepo, testConfig);
    const reloadedTx = await freshTxService.findByAnyMessageId(String(testConfig.telegramGroupId), 1001);
    assert.ok(reloadedTx);
    assert.equal(reloadedTx.invoiceType, 'ITEMIZED_TEXT');
    assert.equal(reloadedTx.originalText, realisticItemizedInvoice.trim());
    assert.equal(reloadedTx.amount, 2349580);
  });

  it('2. Media-based invoice workflow regression: preserves photo/document and media caption rules', async () => {
    const ctx = await setupTestContext();

    // 1. Initial photo registration
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      2001,
      undefined,
      'photo_initial_123',
      'photo',
      'MEDIA'
    );
    await ctx.txService.setAmount(tx.id, 500000);
    const snap = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snap);

    // 2. Amount-only addition
    await ctx.bot.handleUpdate({
      update_id: 201,
      message: {
        message_id: 2002,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/add 100,000 extra items',
        reply_to_message: {
          message_id: 2001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_initial_123' }],
          caption: '🧾 INVOICE',
        },
      },
    } as any);

    assert.ok(ctx.editedCaptions.length >= 1, 'Media caption must be edited');
    const caption1 = ctx.editedCaptions[ctx.editedCaptions.length - 1].caption;
    assert.ok(caption1.includes('💰 Invoice Total: ₩600,000'));
    assert.ok(caption1.includes('➕➕➕'));
    assert.ok(caption1.includes('₩100,000'));

    // 3. /add with new photo (cumulative media group)
    await ctx.bot.handleUpdate({
      update_id: 202,
      message: {
        message_id: 2003,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/add 50,000 second receipt',
        photo: [{ file_id: 'photo_second_456' }],
        reply_to_message: {
          message_id: 2001,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_initial_123' }],
          caption: caption1,
        },
      },
    } as any);

    assert.ok(ctx.sentMediaGroups.length >= 1, 'Media group must be sent for combined media');
    const sentGroup = ctx.sentMediaGroups[0];
    assert.equal(sentGroup.media.length, 2);
    assert.equal(sentGroup.media[0].media, 'photo_initial_123');
    assert.equal(sentGroup.media[1].media, 'photo_second_456');

    // 4. Partial payment with receipt photo
    const activeMsgId = 8000; // First photo of sent media group
    await ctx.bot.handleUpdate({
      update_id: 203,
      message: {
        message_id: 2004,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/paid 200,000',
        photo: [{ file_id: 'photo_bank_receipt_789' }],
        reply_to_message: {
          message_id: activeMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_initial_123' }],
        },
      },
    } as any);

    const txAfterPay = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterPay.status, 'PARTIALLY_PAID');
    assert.equal(txAfterPay.amount, 650000);
    const totalPaid = await ctx.txRepo.getTotalPaid(tx.id);
    assert.equal(totalPaid, 200000);
  });

  it('3. Other text-only records (Type C): standard summary without item list preserved', async () => {
    const ctx = await setupTestContext();

    const simpleNoteText = 'Monthly cleaning service fee for store front';
    assert.equal(isItemizedInvoiceText(simpleNoteText), false);

    // Register simple text invoice
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      3001,
      undefined,
      null,
      null,
      'TEXT_STANDARD'
    );
    await ctx.txService.setAmount(tx.id, 80000);

    const caption = await ctx.txService.renderInvoiceCaptionForTransaction(tx.id, simpleNoteText);
    assert.ok(caption.includes('🆔 <b>#INV'));
    assert.ok(caption.includes('💰 Invoice Total: ₩80,000'));
    assert.ok(caption.includes('Monthly cleaning service fee for store front'));
  });

  it('4. Production safety & Idempotency: legacy records and retry protection', async () => {
    const ctx = await setupTestContext();

    // Insert legacy record where invoice_type and original_text are null
    const legacyTx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      4001
    );
    await ctx.txService.setAmount(legacyTx.id, 150000);

    const row = await ctx.txRepo.findById(legacyTx.id);
    assert.equal(row?.invoice_type, null);
    assert.equal(row?.original_text, null);

    // Running findByAnyMessageId does not alter existing records
    const found = await ctx.txService.findByAnyMessageId(String(testConfig.telegramGroupId), 4001);
    assert.ok(found);
    assert.equal(found.id, legacyTx.id);

    const rowUnchanged = await ctx.txRepo.findById(legacyTx.id);
    assert.equal(rowUnchanged?.amount, 150000);
    assert.equal(rowUnchanged?.invoice_type, null);
  });
});
