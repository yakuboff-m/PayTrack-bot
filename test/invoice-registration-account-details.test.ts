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

    if (method === 'sendMediaGroup') {
      const baseId = 8000 + sentMessages.length * 10;
      const results = payload.media.map((m: any, idx: number) => {
        const msg = {
          message_id: baseId + idx,
          chat: { id: payload.chat_id },
          message_thread_id: payload.message_thread_id,
          date: Math.floor(Date.now() / 1000),
          photo: m.type === 'photo' ? m.media : undefined,
          document: m.type === 'document' ? { file_id: m.media } : undefined,
          caption: m.caption,
        };
        sentMessages.push(msg);
        return msg;
      });
      return { ok: true, result: results as any };
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

describe('Invoice Workflow: Primary Message & Account-Control Message Lifecycle', () => {
  it('1. New invoice registration creates primary invoice message and exactly one account-control message', async () => {
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

    // Assert: Exactly ONE invoice media message created for the invoice
    const invoiceMediaMessages = ctx.sentMessages.filter((m) => m.photo === 'photo_initial_inv0020');
    assert.equal(invoiceMediaMessages.length, 1, 'Must create exactly one invoice media message');

    const invoiceMsg = invoiceMediaMessages[0];

    // Assert: Primary caption has approved structure, bank note, NO raw bank details
    assert.match(invoiceMsg.caption, /🧾 INVOICE • #INV0001/);
    assert.match(invoiceMsg.caption, /🏢 Koreta Meat Co/);
    assert.match(invoiceMsg.caption, /💳 Bank\/account details are shown only in the separate account-control message\./);
    assert.doesNotMatch(invoiceMsg.caption, /012-345678-2341/, 'Bank account number must NOT appear in primary caption');
    assert.match(invoiceMsg.caption, /👤 Koreta CoLtd/);
    assert.match(invoiceMsg.caption, /📜 ACTION HISTORY/);
    assert.match(invoiceMsg.caption, /📥 Original Registration:/);
    assert.match(invoiceMsg.caption, /💵 Registered Amount:\n└─> 💰 ₩350,000/);
    assert.match(invoiceMsg.caption, /📊 FINANCIAL SUMMARY/);
    assert.match(invoiceMsg.caption, /💰 Invoice Total: ₩350,000/);
    assert.match(invoiceMsg.caption, /💵 Total Paid: ₩0/);
    assert.match(invoiceMsg.caption, /⚖️ Need to Pay: ₩350,000/);
    assert.match(invoiceMsg.caption, /📊 Status: ⏳ PENDING/);

    // Primary message has NO inline keyboard
    assert.equal(invoiceMsg.reply_markup, undefined, 'Primary media message must not have inline keyboard');

    // Assert: Exactly ONE separate account-control message was sent
    const controlMsgs = ctx.sentMessages.filter(
      (m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Copy Account Number'
    );
    assert.equal(controlMsgs.length, 1, 'Must send exactly one account-control message');

    const controlMsg = controlMsgs[0];
    assert.match(controlMsg.text, /Account details for #INV0001/);
    assert.match(controlMsg.text, /Hana Bank/);
    assert.match(controlMsg.text, /012-345678-2341/);
    assert.match(controlMsg.text, /Koreta CoLtd/);
    assert.equal(controlMsg.reply_markup.inline_keyboard[0][0].copy_text?.text, '012-345678-2341');

    // Total sent messages to chat: exactly 2 (primary invoice + account-control message)
    assert.equal(ctx.sentMessages.length, 2, 'Total bot messages sent must be exactly 2');
  });

  it('2. /add with media preserves original media, updates superseded notice on old primary, replaces account-control message', async () => {
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

    // Initial account-control message
    const initialControlMsg = {
      message_id: 250,
      chat_id: testConfig.telegramGroupId,
      text: '💳 Account details for #INV0001:',
      reply_markup: {
        inline_keyboard: [[{ text: 'Copy Account Number', copy_text: { text: '012-345678-2341' } }]],
      },
    };
    ctx.sentMessages.push(initialControlMsg);
    await ctx.txRepo.updateAccountControlMessageId(tx.id, 250);

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

    // Assert: Media group was sent containing both the original photo and the added photo
    const origInAlbum = ctx.sentMessages.find((m) => m.photo === 'photo_original_media');
    const addInAlbum = ctx.sentMessages.find((m) => m.photo === 'photo_addition_media');
    assert.ok(origInAlbum, 'Original photo must be present in media group');
    assert.ok(addInAlbum, 'Added photo must be present in media group');

    // Caption is on the primary message (the first message in the album)
    const albumCaption = origInAlbum.caption;
    assert.ok(albumCaption);
    assert.match(albumCaption, /🧾 INVOICE • #INV0001/);
    assert.match(albumCaption, /📥 Original Registration:/);
    assert.match(albumCaption, /💵 Registered Amount:\n└─> 💰 ₩300,000/);
    assert.match(albumCaption, /➕ Invoice Addition/);
    assert.match(albumCaption, /💵 Amount Added:\n└─> 💰 ₩150,000/);
    assert.match(albumCaption, /📝 Note: Special marinade/);
    assert.match(albumCaption, /💰 Invoice Total: ₩450,000/);
    assert.match(albumCaption, /⚖️ Need to Pay: ₩450,000/);

    // Replacement account-control message exists
    const controlMsgs = ctx.sentMessages.filter(
      (m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Copy Account Number'
    );
    assert.equal(controlMsgs.length, 2, 'Must have initial + replacement account-control messages');

    // Old account-control message was deleted
    assert.ok(ctx.deletedMessageIds.includes(250), 'Old account-control message must be deleted');

    // Assert: Original invoice message 200 was updated with clear notice and direct link
    const origEdited = ctx.editedCaptions.find((e) => e.message_id === 200);
    assert.ok(origEdited, 'Original invoice message 200 must have update notice');
    assert.match(
      origEdited.caption,
      /⚠️ Invoice #INV0001 was updated\.\n\n🔗 Updated invoice: <a href=".*?">View updated invoice<\/a>\n\n🗑 Please delete this original message manually if no longer needed\./
    );
    assert.deepEqual(origEdited.reply_markup?.inline_keyboard, [], 'Keyboard must be removed from original message');

    // Assert: Original media identity is preserved in DB
    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.media_file_id, 'photo_original_media', 'Original media must be preserved');
    assert.equal(updatedTx.media_type, 'photo');
    assert.equal(updatedTx.amount, 450000, 'Amount must be updated to 450,000');
    assert.equal(updatedTx.metadata_message_id, origInAlbum.message_id);

    // Admin /add message was deleted
    assert.ok(ctx.deletedMessageIds.includes(201));
  });

  it('3. /note preserves invoice history, totals, and does not send extra messages', async () => {
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
    await ctx.txRepo.updateAccountControlMessageId(tx.id, 350);

    const initialSentCount = ctx.sentMessages.length;

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

    // No new messages sent
    assert.equal(ctx.sentMessages.length, initialSentCount, 'No new messages must be created for /note');
  });

  it('4. Partial payment preserves invoice history, updates balance due, and sends visible text in Confirmed', async () => {
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
    await ctx.txRepo.updateAccountControlMessageId(tx.id, 450);

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

    // Account control message is NOT deleted during partial payment
    assert.equal(ctx.deletedMessageIds.includes(450), false, 'Account-control message must not be deleted on partial payment');
  });

  it('5. Full payment confirms invoice: ordinary visible text summary in Confirmed, media copied separately, cleans up account-control message', async () => {
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
    await ctx.txRepo.updateAccountControlMessageId(tx.id, 550);

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

    // Account-control message must be cleaned up (deleted) upon full payment
    assert.ok(ctx.deletedMessageIds.includes(550), 'Account control message 550 must be deleted upon full payment');
    assert.equal(txFinal.account_control_message_id, null);
  });

  it('6. Full sequence: Register invoice → /add with new media → /add second media → /note → partial payment → full payment', async () => {
    const ctx = await setupTestContext();

    // ----------------------------------------------------
    // Step 1: Register invoice with photo
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 1000,
        from: { id: 999, is_bot: false, first_name: 'Staff' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_original_photo', width: 800, height: 600 }],
        caption: 'Initial Invoice Delivery',
      },
    } as any);

    // Admin replies: /koreta 300000
    await ctx.bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 1001,
        from: { id: 111, is_bot: false, first_name: 'Admin' },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/koreta 300000',
        reply_to_message: {
          message_id: 1000,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo', width: 800, height: 600 }],
          caption: 'Initial Invoice Delivery',
        },
      },
    } as any);

    const origInvoiceMsg = ctx.sentMessages.find((m) => m.photo === 'seq_original_photo');
    assert.ok(origInvoiceMsg, 'Original invoice message must be sent');
    const origInvoiceMsgId = origInvoiceMsg.message_id;

    assert.match(origInvoiceMsg.caption, /🧾 INVOICE • #INV0001/);
    assert.match(origInvoiceMsg.caption, /💰 Invoice Total: ₩300,000/);
    assert.match(origInvoiceMsg.caption, /⚖️ Need to Pay: ₩300,000/);

    // Account control message exists with button
    const controlMsg1 = ctx.sentMessages.find(
      (m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Copy Account Number'
    );
    assert.ok(controlMsg1, 'Account control message must exist');

    // Verify DB
    let tx = (await ctx.txRepo.findById(1))!;
    assert.ok(tx);
    assert.equal(tx.media_file_id, 'seq_original_photo');
    assert.equal(tx.amount, 300000);
    assert.equal(tx.metadata_message_id, origInvoiceMsgId);
    assert.equal(tx.account_control_message_id, controlMsg1.message_id);

    // ----------------------------------------------------
    // Step 2: /add 100000 with new invoice media
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 1002,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_added_photo', width: 800, height: 600 }],
        caption: '/add 100000 Delivery charge',
        reply_to_message: {
          message_id: origInvoiceMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: origInvoiceMsg.caption,
        },
      },
    } as any);

    // Assert: Media group sent containing both original photo and added photo
    const origInAlbum = ctx.sentMessages
      .filter((m) => m.photo === 'seq_original_photo')
      .pop()!;
    const addInAlbum = ctx.sentMessages.find((m) => m.photo === 'seq_added_photo');
    assert.ok(origInAlbum, 'Original photo must be present in media group');
    assert.ok(addInAlbum, 'Added photo must be present in media group');
    const activeMsgId = origInAlbum.message_id;

    assert.match(origInAlbum.caption, /🧾 INVOICE • #INV0001/);
    assert.match(origInAlbum.caption, /📥 Original Registration:/);
    assert.match(origInAlbum.caption, /💵 Registered Amount:\n└─> 💰 ₩300,000/);
    assert.match(origInAlbum.caption, /➕ Invoice Addition/);
    assert.match(origInAlbum.caption, /💵 Amount Added:\n└─> 💰 ₩100,000/);
    assert.match(origInAlbum.caption, /📝 Note: Delivery charge/);
    assert.match(origInAlbum.caption, /💰 Invoice Total: ₩400,000/);
    assert.match(origInAlbum.caption, /⚖️ Need to Pay: ₩400,000/);

    // Old account control message was deleted
    assert.ok(ctx.deletedMessageIds.includes(controlMsg1.message_id), 'Old control message must be deleted');

    // Assert: Original message was edited with notice & link, and keyboard was removed
    const origEdited = ctx.editedCaptions.find((e) => e.message_id === origInvoiceMsgId);
    assert.ok(origEdited, 'Original invoice message must have notice edited');
    assert.match(
      origEdited.caption,
      /⚠️ Invoice #INV0001 was updated\.\n\n🔗 Updated invoice: <a href=".*?">View updated invoice<\/a>\n\n🗑 Please delete this original message manually if no longer needed\./
    );
    assert.deepEqual(origEdited.reply_markup?.inline_keyboard, [], 'Keyboard must be cleared from original message');

    // Assert: Original media identity is preserved in DB
    tx = (await ctx.txRepo.findById(1))!;
    assert.equal(tx.media_file_id, 'seq_original_photo', 'Original media must be permanently preserved');
    assert.equal(tx.amount, 400000);
    assert.equal(tx.metadata_message_id, activeMsgId, 'Metadata message id points to active message');

    // ----------------------------------------------------
    // Step 2b: another /add 50000 with additional media (cumulative media check)
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 122,
      message: {
        message_id: 10022,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_second_added_photo', width: 800, height: 600 }],
        caption: '/add 50000 Packing fee',
        reply_to_message: {
          message_id: activeMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: origInAlbum.caption,
        },
      },
    } as any);

    // Verify 3-item media group sent containing original photo, 1st added photo, and 2nd added photo
    const secondAlbumPrimary = ctx.sentMessages
      .filter((m) => m.photo === 'seq_original_photo')
      .pop()!;
    assert.ok(secondAlbumPrimary, 'New album message must be sent with all media');
    const newActiveMsgId = secondAlbumPrimary.message_id;

    assert.match(secondAlbumPrimary.caption, /🧾 INVOICE • #INV0001/);
    assert.match(secondAlbumPrimary.caption, /💵 Registered Amount:\n└─> 💰 ₩300,000/);
    assert.match(secondAlbumPrimary.caption, /💵 Amount Added:\n└─> 💰 ₩100,000/);
    assert.match(secondAlbumPrimary.caption, /💵 Amount Added:\n└─> 💰 ₩50,000/);
    assert.match(secondAlbumPrimary.caption, /📝 Note: Packing fee/);
    assert.match(secondAlbumPrimary.caption, /💰 Invoice Total: ₩450,000/);
    assert.match(secondAlbumPrimary.caption, /⚖️ Need to Pay: ₩450,000/);

    // Also assert 2nd added photo is present in sent messages
    const secondAddedInAlbum = ctx.sentMessages.find((m) => m.photo === 'seq_second_added_photo');
    assert.ok(secondAddedInAlbum, 'Second added photo must be present in media group');

    // ----------------------------------------------------
    // Step 3: /note on the active invoice message
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 1003,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/note Quality checked by supervisor',
        reply_to_message: {
          message_id: newActiveMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: secondAlbumPrimary.caption,
        },
      },
    } as any);

    const noteEdited = ctx.editedCaptions.find((e) => e.message_id === newActiveMsgId);
    assert.ok(noteEdited, 'Active invoice message must be edited with note');
    assert.match(noteEdited.caption, /📝 Note: Quality checked by supervisor/);
    assert.match(noteEdited.caption, /💰 Invoice Total: ₩450,000/);

    // ----------------------------------------------------
    // Step 4: Partial payment (/paid 150000)
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 14,
      message: {
        message_id: 1004,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_receipt_photo_1', width: 600, height: 800 }],
        caption: '/paid 150000 Deposit 1',
        reply_to_message: {
          message_id: newActiveMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: noteEdited.caption,
        },
      },
    } as any);

    // Active message in Pending is edited with partial payment info
    const partialEdited = ctx.editedCaptions.filter((e) => e.message_id === newActiveMsgId).pop()!;
    assert.ok(partialEdited);
    assert.match(partialEdited.caption, /💵 Total Paid: ₩150,000/);
    assert.match(partialEdited.caption, /⚖️ Need to Pay: ₩300,000/);
    assert.match(partialEdited.caption, /📊 Status: ⏳ PARTIALLY PAID/);

    // Confirmed topic receives ordinary visible text message
    const partialConfirmedText = ctx.sentMessages.find(
      (m) =>
        m.message_thread_id === testConfig.confirmedTopicId &&
        typeof m.text === 'string' &&
        m.text.includes('PARTIALLY PAID')
    );
    assert.ok(partialConfirmedText, 'Confirmed topic must receive ordinary visible text confirmation');
    assert.match(partialConfirmedText.text, /#INV0001/);
    assert.match(partialConfirmedText.text, /₩150,000/);

    // Receipt media copied to Confirmed
    const partialReceiptCopy = ctx.sentMessages.find(
      (m) => m.message_thread_id === testConfig.confirmedTopicId && m.from_chat_id !== undefined
    );
    assert.ok(partialReceiptCopy, 'Receipt media must be copied into Confirmed topic');

    // ----------------------------------------------------
    // Step 5: Full payment (/paid 300000)
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 15,
      message: {
        message_id: 1005,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_receipt_photo_2', width: 600, height: 800 }],
        caption: '/paid 300000 Final settlement',
        reply_to_message: {
          message_id: newActiveMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: partialEdited.caption,
        },
      },
    } as any);

    // Pending active message is updated to PAID, keyboard removed
    const fullEdited = ctx.editedCaptions.filter((e) => e.message_id === newActiveMsgId).pop()!;
    assert.ok(fullEdited);
    assert.match(fullEdited.caption, /✅ PAID/);
    assert.deepEqual(fullEdited.reply_markup?.inline_keyboard, [], 'Keyboard must be removed upon full payment');

    // Confirmed topic receives ordinary visible text message for full payment
    const fullConfirmedText = ctx.sentMessages.find(
      (m) =>
        m.message_thread_id === testConfig.confirmedTopicId &&
        typeof m.text === 'string' &&
        m.text.includes('PAID') &&
        !m.text.includes('PARTIALLY')
    );
    assert.ok(fullConfirmedText, 'Full payment confirmation must be ordinary visible text message');
    assert.match(fullConfirmedText.text, /#INV0001/);
    assert.match(fullConfirmedText.text, /₩300,000/);
    assert.match(fullConfirmedText.text, /₩450,000/);

    // Final DB state checks
    tx = (await ctx.txRepo.findById(1))!;
    assert.equal(tx.status, 'PAID');
    assert.equal(tx.amount, 450000);
    const payments = await ctx.txRepo.getPayments(1);
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    assert.equal(totalPaid, 450000);
    assert.equal(tx.media_file_id, 'seq_original_photo', 'Original media identity remains permanently untouched');

    // Account control message is cleaned up upon full payment
    assert.equal(tx.account_control_message_id, null, 'Account-control message id must be null in DB after full payment');
  });
});
