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

    // Assert: Primary caption has approved structure, NO raw bank details, NO bank note
    assert.match(invoiceMsg.caption, /🧾 INVOICE • #INV0001/);
    assert.match(invoiceMsg.caption, /🏢 Koreta Meat Co/);
    assert.doesNotMatch(invoiceMsg.caption, /012-345678-2341/, 'Bank account number must NOT appear in primary caption');
    assert.doesNotMatch(invoiceMsg.caption, /Hana Bank/, 'Bank name must NOT appear in primary caption');
    assert.doesNotMatch(invoiceMsg.caption, /Koreta CoLtd/, 'Account holder must NOT appear in primary caption');
    assert.match(invoiceMsg.caption, /📜 ACTION HISTORY/);
    assert.match(invoiceMsg.caption, /📥 Original Registration:/);
    assert.match(invoiceMsg.caption, /💵 Registered Amount:\n└─> 💰 ₩350,000/);
    assert.match(invoiceMsg.caption, /📊 FINANCIAL SUMMARY/);
    assert.match(invoiceMsg.caption, /💰 Invoice Total: ₩350,000/);
    assert.match(invoiceMsg.caption, /💵 Total Paid: ₩0/);
    assert.match(invoiceMsg.caption, /⚖️ Need to Pay: ₩350,000/);
    assert.match(invoiceMsg.caption, /📊 Status: ⏳ PENDING/);

    // Primary message HAS the inline keyboard attached directly
    assert.ok(invoiceMsg.reply_markup?.inline_keyboard, 'Primary media message must have inline keyboard');
    assert.equal(invoiceMsg.reply_markup.inline_keyboard[0][0].text, 'Copy Account Number');
    assert.equal(invoiceMsg.reply_markup.inline_keyboard[0][0].copy_text?.text, '012-345678-2341');

    // Total sent messages to chat: exactly 1 (invoice media message with attached button, NO separate control message)
    assert.equal(ctx.sentMessages.length, 1, 'Total bot messages sent must be exactly 1');
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

  it('6. Full sequence: Register photo invoice → /add amount only → /note → /add with media → /add media again → /paid', async () => {
    const ctx = await setupTestContext();

    // ----------------------------------------------------
    // Step 1: Register photo invoice → button attached to invoice, no separate control message
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
    assert.match(origInvoiceMsg.caption, /🏢 Koreta Meat Co/);
    assert.doesNotMatch(origInvoiceMsg.caption, /012-345678-2341/, 'No account number in caption');
    assert.doesNotMatch(origInvoiceMsg.caption, /Hana Bank/, 'No bank name in caption');
    assert.doesNotMatch(origInvoiceMsg.caption, /Koreta CoLtd/, 'No account holder in caption');
    assert.match(origInvoiceMsg.caption, /💰 Invoice Total: ₩300,000/);
    assert.match(origInvoiceMsg.caption, /⚖️ Need to Pay: ₩300,000/);

    // Copy Account Number button is attached directly to the invoice message
    assert.ok(origInvoiceMsg.reply_markup?.inline_keyboard, 'Inline keyboard must be attached directly to invoice');
    assert.equal(origInvoiceMsg.reply_markup.inline_keyboard[0][0].text, 'Copy Account Number');
    assert.equal(origInvoiceMsg.reply_markup.inline_keyboard[0][0].copy_text?.text, '012-345678-2341');

    // Exactly 1 message sent; no separate account-control message
    assert.equal(ctx.sentMessages.length, 1, 'Total bot messages sent must be exactly 1');

    // Verify DB state
    let tx = (await ctx.txRepo.findById(1))!;
    assert.ok(tx);
    assert.equal(tx.media_file_id, 'seq_original_photo');
    assert.equal(tx.amount, 300000);
    assert.equal(tx.metadata_message_id, origInvoiceMsgId);
    assert.equal(tx.account_control_message_id, null, 'No separate account control message during initial registration');

    // ----------------------------------------------------
    // Step 2: /add amount only → same invoice message and button remain
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 1002,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/add 50000 Extra cuts',
        reply_to_message: {
          message_id: origInvoiceMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: origInvoiceMsg.caption,
        },
      },
    } as any);

    // Verify caption was edited in place
    const step2Edit = ctx.editedCaptions.filter((e) => e.message_id === origInvoiceMsgId).pop()!;
    assert.ok(step2Edit, 'Invoice caption must be edited in place');
    assert.match(step2Edit.caption, /➕ Invoice Addition/);
    assert.match(step2Edit.caption, /💵 Amount Added:\n└─> 💰 ₩50,000/);
    assert.match(step2Edit.caption, /📝 Note: Extra cuts/);
    assert.match(step2Edit.caption, /💰 Invoice Total: ₩350,000/);

    // Inline button remains attached directly to the invoice message
    assert.equal(step2Edit.reply_markup?.inline_keyboard?.[0]?.[0]?.text, 'Copy Account Number');

    // No new messages sent to chat
    assert.equal(ctx.sentMessages.length, 1, 'No new messages created during amount-only /add');
    tx = (await ctx.txRepo.findById(1))!;
    assert.equal(tx.account_control_message_id, null, 'account_control_message_id remains null');

    // ----------------------------------------------------
    // Step 3: /note → same invoice message and button remain
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
          message_id: origInvoiceMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: step2Edit.caption,
        },
      },
    } as any);

    const step3Edit = ctx.editedCaptions.filter((e) => e.message_id === origInvoiceMsgId).pop()!;
    assert.ok(step3Edit, 'Invoice caption must be edited in place for note');
    assert.match(step3Edit.caption, /📝 Note: Quality checked by supervisor/);
    assert.equal(step3Edit.reply_markup?.inline_keyboard?.[0]?.[0]?.text, 'Copy Account Number');
    assert.equal(ctx.sentMessages.length, 1, 'No new messages created during /note');

    // ----------------------------------------------------
    // Step 4: /add with media → replacement media group with all media, exactly one separate account-control message
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 14,
      message: {
        message_id: 1004,
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
          caption: step3Edit.caption,
        },
      },
    } as any);

    // Replacement media group contains original photo and added photo
    const origInAlbum = ctx.sentMessages
      .filter((m) => m.photo === 'seq_original_photo')
      .pop()!;
    const addInAlbum = ctx.sentMessages.find((m) => m.photo === 'seq_added_photo');
    assert.ok(origInAlbum, 'Original photo must be present in replacement media group');
    assert.ok(addInAlbum, 'Added photo must be present in replacement media group');
    const albumMsgId = origInAlbum.message_id;

    assert.match(origInAlbum.caption, /🧾 INVOICE • #INV0001/);
    assert.match(origInAlbum.caption, /💳 Bank\/account details are shown only in the separate account-control message\./);
    assert.match(origInAlbum.caption, /💰 Invoice Total: ₩450,000/);

    // Exactly one separate account-control message exists
    const controlMsgsStep4 = ctx.sentMessages.filter(
      (m) => m.text && /Account details for #INV0001/.test(m.text)
    );
    assert.equal(controlMsgsStep4.length, 1, 'Exactly one separate account-control message must be created');
    const controlMsg1 = controlMsgsStep4[0];
    assert.equal(controlMsg1.reply_markup?.inline_keyboard?.[0]?.[0]?.text, 'Copy Account Number');

    // Old invoice message edited into superseded notice and keyboard removed
    const origSuperseded = ctx.editedCaptions.filter((e) => e.message_id === origInvoiceMsgId).pop()!;
    assert.ok(origSuperseded);
    assert.match(origSuperseded.caption, /⚠️ Invoice #INV0001 was updated/);
    assert.deepEqual(origSuperseded.reply_markup?.inline_keyboard, [], 'Inline keyboard must be removed from superseded message');

    tx = (await ctx.txRepo.findById(1))!;
    assert.equal(tx.account_control_message_id, controlMsg1.message_id);
    assert.equal(tx.metadata_message_id, albumMsgId);

    // ----------------------------------------------------
    // Step 5: /add with media again → all media remain in order, no duplicate account-control message
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 15,
      message: {
        message_id: 1005,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_second_added_photo', width: 800, height: 600 }],
        caption: '/add 50000 Packaging fee',
        reply_to_message: {
          message_id: albumMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: origInAlbum.caption,
        },
      },
    } as any);

    // All 3 media items present in order
    const thirdAlbumPrimary = ctx.sentMessages
      .filter((m) => m.photo === 'seq_original_photo')
      .pop()!;
    assert.ok(thirdAlbumPrimary);
    const newActiveMsgId = thirdAlbumPrimary.message_id;

    assert.match(thirdAlbumPrimary.caption, /💰 Invoice Total: ₩500,000/);

    // Old account-control message was deleted
    assert.ok(ctx.deletedMessageIds.includes(controlMsg1.message_id), 'Previous control message must be deleted');

    // Exactly one current account-control message in DB
    tx = (await ctx.txRepo.findById(1))!;
    assert.ok(tx.account_control_message_id, 'Must have active account control message ID');
    assert.notEqual(tx.account_control_message_id, controlMsg1.message_id, 'Must point to new account control message');
    const currentControlId = tx.account_control_message_id;

    // ----------------------------------------------------
    // Step 6: /paid → Confirmed record created, separate control message removed, required evidence preserved
    // ----------------------------------------------------
    await ctx.bot.handleUpdate({
      update_id: 16,
      message: {
        message_id: 1006,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'seq_receipt_photo_full', width: 600, height: 800 }],
        caption: '/paid 500000 Full settlement',
        reply_to_message: {
          message_id: newActiveMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'seq_original_photo' }],
          caption: thirdAlbumPrimary.caption,
        },
      },
    } as any);

    // The separate account-control message is deleted upon full payment
    assert.ok(
      ctx.deletedMessageIds.includes(currentControlId),
      'Active account control message must be deleted upon full payment'
    );

    // Confirmed topic receives text confirmation and receipt copy
    const fullConfirmedText = ctx.sentMessages.find(
      (m) =>
        m.message_thread_id === testConfig.confirmedTopicId &&
        typeof m.text === 'string' &&
        m.text.includes('PAID')
    );
    assert.ok(fullConfirmedText, 'Full payment confirmation must be sent to Confirmed');
    assert.match(fullConfirmedText.text, /#INV0001/);
    assert.match(fullConfirmedText.text, /₩500,000/);

    const receiptCopy = ctx.sentMessages.find(
      (m) => m.message_thread_id === testConfig.confirmedTopicId && m.from_chat_id !== undefined
    );
    assert.ok(receiptCopy, 'Receipt media must be copied to Confirmed topic');

    // DB checks: status PAID, original media permanently preserved, accountControlMessageId is null
    tx = (await ctx.txRepo.findById(1))!;
    assert.equal(tx.status, 'PAID');
    assert.equal(tx.amount, 500000);
    assert.equal(tx.media_file_id, 'seq_original_photo', 'Original media identity remains permanently untouched');
    assert.equal(tx.account_control_message_id, null, 'Account control message ID is cleared');
  });

  it('7. Single-document invoice registration attaches button directly to document message', async () => {
    const ctx = await setupTestContext();

    // User sends document invoice
    await ctx.bot.handleUpdate({
      update_id: 20,
      message: {
        message_id: 2000,
        from: { id: 999, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        document: { file_id: 'doc_invoice_contract', file_name: 'invoice_2026.pdf', mime_type: 'application/pdf' },
        caption: 'Meat Wholesale Supply Agreement',
      },
    } as any);

    // Admin registers via /koreta 420000
    await ctx.bot.handleUpdate({
      update_id: 21,
      message: {
        message_id: 2001,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/koreta 420000',
        reply_to_message: {
          message_id: 2000,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          document: { file_id: 'doc_invoice_contract', file_name: 'invoice_2026.pdf' },
          caption: 'Meat Wholesale Supply Agreement',
        },
      },
    } as any);

    const docInvoiceMsg = ctx.sentMessages.find(
      (m) => m.document === 'doc_invoice_contract' || m.document?.file_id === 'doc_invoice_contract'
    );
    assert.ok(docInvoiceMsg, 'Document invoice message must be sent');
    assert.match(docInvoiceMsg.caption, /🧾 INVOICE • #INV0001/);
    assert.match(docInvoiceMsg.caption, /🏢 Koreta Meat Co/);
    assert.doesNotMatch(docInvoiceMsg.caption, /012-345678-2341/, 'Bank account number must not appear in caption');

    // Inline button attached directly to document message
    assert.ok(docInvoiceMsg.reply_markup?.inline_keyboard, 'Inline keyboard must be attached directly to document');
    assert.equal(docInvoiceMsg.reply_markup.inline_keyboard[0][0].text, 'Copy Account Number');
    assert.equal(docInvoiceMsg.reply_markup.inline_keyboard[0][0].copy_text?.text, '012-345678-2341');

    // Total sent messages is exactly 1 (no separate account message)
    assert.equal(ctx.sentMessages.length, 1, 'Exactly one message must be sent for single-document registration');

    const tx = (await ctx.txRepo.findById(1))!;
    assert.equal(tx.media_file_id, 'doc_invoice_contract');
    assert.equal(tx.media_type, 'document');
    assert.equal(tx.account_control_message_id, null, 'No separate account control message created');
  });
});
