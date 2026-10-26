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
  botToken: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ',
  telegramGroupId: -100123456,
  pendingTopicId: 2,
  confirmedTopicId: 3,
  adminUserIds: [111],
};

async function setupTestContext() {
  const db = createInMemoryDb();

  const distRepo = new DistributorRepository(db);
  const distService = new DistributorService(distRepo);
  const txRepo = new TransactionRepository(db);
  const txService = new TransactionService(txRepo, testConfig);

  const distributor = await distService.create({
    name: 'Koreta Meat Co',
    alias: 'koreta',
    bankName: 'Hana Bank',
    accountNumber: '012-345678-2341',
    accountHolder: 'Koreta CoLtd',
  });

  const apiCalls: Array<{ method: string; payload: any }> = [];
  const sentMessages: any[] = [];
  const editedTexts: any[] = [];
  const editedCaptions: any[] = [];
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
      const msg = {
        ...payload,
        message_id: id,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
      };
      sentMessages.push(msg);
      return { ok: true, result: msg as any };
    }

    if (method === 'sendPhoto' || method === 'sendDocument') {
      const id = 7500 + sentMessages.length;
      const msg = {
        ...payload,
        message_id: id,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
      };
      sentMessages.push(msg);
      return { ok: true, result: msg as any };
    }

    if (method === 'copyMessage') {
      const id = 8500 + sentMessages.length;
      const msg = {
        ...payload,
        message_id: id,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
      };
      sentMessages.push(msg);
      return { ok: true, result: { message_id: id } as any };
    }

    if (method === 'editMessageText') {
      editedTexts.push(payload);
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          text: payload.text,
          chat: { id: payload.chat_id },
          reply_markup: payload.reply_markup,
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
          reply_markup: payload.reply_markup,
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
    txRepo,
    txService,
    distService,
    distributor,
    bot,
    apiCalls,
    sentMessages,
    editedTexts,
    editedCaptions,
    deletedMessageIds,
  };
}

describe('Regression: Integrated Account Details in Invoice Caption & Keyboard', () => {
  it('1. New invoice registration creates exactly one invoice media message with integrated caption and account button, and NO separate account-details message', async () => {
    const ctx = await setupTestContext();

    // User sends photo invoice
    await ctx.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, is_bot: false, first_name: 'Staff' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_initial_inv0020', width: 800, height: 600 }],
        caption: 'Beef Ribs 20kg',
      },
    } as any);

    // Admin replies: /koreta 350000
    await ctx.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 111, is_bot: false, first_name: 'Admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/koreta 350000',
        reply_to_message: {
          message_id: 100,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_initial_inv0020', width: 800, height: 600 }],
          caption: 'Beef Ribs 20kg',
        },
      },
    } as any);

    // Assert: Exactly ONE bot message created for the invoice
    const invoiceMediaMessages = ctx.sentMessages.filter((m) => m.photo === 'photo_initial_inv0020');
    assert.equal(invoiceMediaMessages.length, 1, 'Must create exactly one invoice media message');

    const invoiceMsg = invoiceMediaMessages[0];

    // Assert: Caption integrates distributor, bank, account number, account holder, action history, and financial summary
    assert.match(invoiceMsg.caption, /🧾 INVOICE • #INV0001/);
    assert.match(invoiceMsg.caption, /🏢 Koreta Meat Co/);
    assert.match(invoiceMsg.caption, /💳 Hana Bank 012-345678-2341/);
    assert.match(invoiceMsg.caption, /👤 Koreta CoLtd/);
    assert.match(invoiceMsg.caption, /📜 ACTION HISTORY/);
    assert.match(invoiceMsg.caption, /📥 Original Registration:/);
    assert.match(invoiceMsg.caption, /💵 Registered Amount:\n└─> 💰 ₩350,000/);
    assert.match(invoiceMsg.caption, /📊 FINANCIAL SUMMARY/);
    assert.match(invoiceMsg.caption, /💰 Invoice Total: ₩350,000/);
    assert.match(invoiceMsg.caption, /💵 Total Paid: ₩0/);
    assert.match(invoiceMsg.caption, /⚖️ Need to Pay: ₩350,000/);
    assert.match(invoiceMsg.caption, /📊 Status: ⏳ PENDING/);

    // Assert: Copy Account Number button is attached directly to the invoice media message
    assert.ok(invoiceMsg.reply_markup?.inline_keyboard, 'Inline keyboard must exist on invoice message');
    assert.equal(
      invoiceMsg.reply_markup.inline_keyboard[0][0].text,
      'Copy Account Number',
      'Button must be attached directly to invoice media message'
    );
    assert.equal(
      invoiceMsg.reply_markup.inline_keyboard[0][0].copy_text?.text,
      '012-345678-2341'
    );

    // Assert: NO separate "Account details for #INVxxxx" message was sent
    const separateAccountMessages = ctx.sentMessages.filter(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(
      separateAccountMessages.length,
      0,
      'Must NOT send a separate Account details for message'
    );

    // Total sent messages to chat: exactly 1 (the invoice itself)
    assert.equal(ctx.sentMessages.length, 1, 'Total bot messages sent must be exactly 1');
  });

  it('2. /add preserves original invoice media, updates invoice in place with account button, and sends NO separate account message', async () => {
    const ctx = await setupTestContext();

    // Register invoice
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      200,
      undefined,
      'photo_original_media',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snapshot);
    await ctx.txService.setAmount(tx.id, 300000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 200);

    // Issue /add 150000 with a second photo
    await ctx.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 201,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_addition_media', width: 800, height: 600 }],
        caption: '/add 150000 Special marinade',
        reply_to_message: {
          message_id: 200,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_original_media', width: 800, height: 600 }],
          caption: 'Original Invoice',
        },
      },
    } as any);

    // Assert: Original media identity is preserved
    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.media_file_id, 'photo_original_media', 'Original media must be preserved');
    assert.equal(updatedTx.media_type, 'photo');
    assert.equal(updatedTx.amount, 450000, 'Amount must be updated to 450,000');

    // Assert: Primary invoice message was edited in place
    const edited = ctx.editedCaptions.find((e) => e.message_id === 200);
    assert.ok(edited, 'Original invoice message 200 must be edited in place');

    // Caption contains updated action history and new financial summary
    assert.match(edited.caption, /📥 Original Registration:/);
    assert.match(edited.caption, /💵 Registered Amount:\n└─> 💰 ₩300,000/);
    assert.match(edited.caption, /➕ Invoice Addition/);
    assert.match(edited.caption, /💵 Amount Added:\n└─> 💰 ₩150,000/);
    assert.match(edited.caption, /📝 Note: Special marinade/);
    assert.match(edited.caption, /💰 Invoice Total: ₩450,000/);
    assert.match(edited.caption, /⚖️ Need to Pay: ₩450,000/);

    // Copy Account Number button remains attached to the invoice message
    assert.equal(
      edited.reply_markup?.inline_keyboard?.[0]?.[0]?.text,
      'Copy Account Number',
      'Button must remain attached to invoice message'
    );

    // Assert: NO separate account details message was sent
    const separateAccountMessages = ctx.sentMessages.filter(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(separateAccountMessages.length, 0, 'Must NOT send separate account details message');

    // Companion photo sent for the addition
    const companionPhoto = ctx.sentMessages.find((m) => m.photo === 'photo_addition_media');
    assert.ok(companionPhoto, 'Companion photo must be sent');
    assert.equal(companionPhoto.reply_to_message_id, 200);

    // Admin /add message was deleted
    assert.ok(ctx.deletedMessageIds.includes(201));
  });

  it('3. /note preserves invoice history, totals, and attached Copy Account Number button', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      300,
      undefined,
      'photo_note_test',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snapshot);
    await ctx.txService.setAmount(tx.id, 250000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 300);

    // Issue /note
    await ctx.bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 301,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/note Delivery by 2 PM',
        reply_to_message: {
          message_id: 300,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_note_test' }],
          caption: 'Invoice 300',
        },
      },
    } as any);

    // Assert: Invoice message caption was edited in place
    const edited = ctx.editedCaptions.find((e) => e.message_id === 300);
    assert.ok(edited);
    assert.match(edited.caption, /📝 Note: Delivery by 2 PM/);
    assert.match(edited.caption, /💰 Invoice Total: ₩250,000/);

    // Button remains attached
    assert.equal(
      edited.reply_markup?.inline_keyboard?.[0]?.[0]?.text,
      'Copy Account Number'
    );

    // No separate account details message
    const separateAccountMessages = ctx.sentMessages.filter(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(separateAccountMessages.length, 0);
  });

  it('4. Partial payment preserves invoice history, updates balance due, keeps button, and sends visible text in Confirmed', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      400,
      undefined,
      'photo_partial_test',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snapshot);
    await ctx.txService.setAmount(tx.id, 500000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 400);

    // User replies with receipt photo and /paid 200000
    await ctx.bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 401,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'receipt_partial_photo', width: 600, height: 800 }],
        caption: '/paid 200000 First deposit',
        reply_to_message: {
          message_id: 400,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_partial_test' }],
          caption: 'Invoice 400',
        },
      },
    } as any);

    // Assert: In Pending, invoice 400 is edited with partial payment progress
    const editedPending = ctx.editedCaptions.find((e) => e.message_id === 400);
    assert.ok(editedPending);
    assert.match(editedPending.caption, /💵 Total Paid: ₩200,000/);
    assert.match(editedPending.caption, /⚖️ Need to Pay: ₩300,000/);
    assert.match(editedPending.caption, /📊 Status: ⏳ PARTIALLY PAID/);

    // Copy Account Number button remains attached to Pending invoice
    assert.equal(
      editedPending.reply_markup?.inline_keyboard?.[0]?.[0]?.text,
      'Copy Account Number'
    );

    // Assert: In Confirmed topic, payment summary is an ordinary visible text message
    const confirmedTextMsg = ctx.sentMessages.find(
      (m) =>
        m.message_thread_id === testConfig.confirmedTopicId &&
        typeof m.text === 'string' &&
        m.text.includes('PARTIALLY PAID')
    );
    assert.ok(confirmedTextMsg, 'Confirmed topic must receive ordinary visible text confirmation');
    assert.match(confirmedTextMsg.text, /#INV0001/);
    assert.match(confirmedTextMsg.text, /₩200,000/);

    // Receipt media copied separately
    const copiedReceipt = ctx.sentMessages.find(
      (m) => m.message_thread_id === testConfig.confirmedTopicId && m.from_chat_id !== undefined
    );
    assert.ok(copiedReceipt, 'Receipt media must be copied separately into Confirmed');

    // No separate account details message
    const separateAccountMessages = ctx.sentMessages.filter(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(separateAccountMessages.length, 0);
  });

  it('5. Full payment confirms invoice: ordinary visible text summary in Confirmed, media copied separately', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      500,
      undefined,
      'photo_full_test',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snapshot);
    await ctx.txService.setAmount(tx.id, 300000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 500);

    // Full payment: /paid with receipt photo
    await ctx.bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 501,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'receipt_full_photo', width: 600, height: 800 }],
        caption: '/paid Full settlement',
        reply_to_message: {
          message_id: 500,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_full_test' }],
          caption: 'Invoice 500',
        },
      },
    } as any);

    // Assert: Confirmed payment summary is an ordinary visible text message
    const confirmedTextMsg = ctx.sentMessages.find(
      (m) =>
        m.message_thread_id === testConfig.confirmedTopicId &&
        typeof m.text === 'string' &&
        m.text.includes('PAID') &&
        !m.text.includes('PARTIALLY')
    );
    assert.ok(confirmedTextMsg, 'Confirmed payment summary must be an ordinary visible text message');
    assert.match(confirmedTextMsg.text, /#INV0001/);
    assert.match(confirmedTextMsg.text, /₩300,000/);

    // Media copied into Confirmed topic
    const confirmedCopies = ctx.sentMessages.filter(
      (m) => m.message_thread_id === testConfig.confirmedTopicId && m.from_chat_id !== undefined
    );
    assert.ok(confirmedCopies.length >= 1, 'Invoice/receipt media copied to Confirmed');

    // DB state is PAID
    const txFinal = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txFinal.status, 'PAID');

    // No separate account details message
    const separateAccountMessages = ctx.sentMessages.filter(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(separateAccountMessages.length, 0);
  });
});
