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
  telegramGroupId: -1004463761895,
  pendingTopicId: 2,
  confirmedTopicId: 3,
  adminUserIds: [111],
};

async function setupTestHarness() {
  const db = createInMemoryDb();
  const distRepo = new DistributorRepository(db);
  const distService = new DistributorService(distRepo);
  const txRepo = new TransactionRepository(db);
  const txService = new TransactionService(txRepo, testConfig);

  const distributor = await distService.create({
    name: 'Koreta',
    alias: 'koreta',
    bankName: 'Hana Bank',
    accountNumber: '012-345678-2341',
    accountHolder: 'Koreta CoLtd',
  });

  const apiCalls: Array<{ method: string; payload: any }> = [];
  const sentMessages: any[] = [];
  const editedCaptions: any[] = [];
  const editedTexts: any[] = [];
  const deletedMessageIds: number[] = [];
  const copiedMessages: any[] = [];
  const sentMediaGroups: any[] = [];

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

    if (method === 'copyMessage') {
      const id = 9000 + copiedMessages.length;
      copiedMessages.push({ ...payload, message_id: id });
      return {
        ok: true,
        result: {
          message_id: id,
          chat: { id: payload.chat_id },
        } as any,
      };
    }

    if (method === 'sendMediaGroup') {
      const baseId = 8000 + sentMediaGroups.length * 10;
      const results = payload.media.map((m: any, idx: number) => ({
        message_id: baseId + idx,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
        photo: m.type === 'photo' ? m.media : undefined,
        document: m.type === 'document' ? m.media : undefined,
        caption: m.caption,
        ...m,
      }));
      sentMediaGroups.push({ ...payload, media: results, results });
      sentMessages.push(...results);
      return { ok: true, result: results as any };
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
    deletedMessageIds,
    copiedMessages,
  };
}

describe('Regression Repair Sequence Suite', () => {
  it('Complete Sequence: Registration ₩340k -> /add ₩200k with media -> note -> partial payment ₩140k -> full payment', async () => {
    const harness = await setupTestHarness();
    const {
      bot,
      txRepo,
      txService,
      distService,
      distributor,
      sentMessages,
      sentMediaGroups,
      editedCaptions,
    } = harness;

    // ─────────────────────────────────────────────────────────────
    // Step 1: Register invoice with original media and amount ₩340,000
    // ─────────────────────────────────────────────────────────────
    const initialPhotoMsg = {
      message_id: 101,
      from: { id: 222, is_bot: false },
      chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
      message_thread_id: testConfig.pendingTopicId,
      photo: [{ file_id: 'original_invoice_photo_id', width: 800, height: 600 }],
      caption: 'Initial meat batch delivery',
    };

    // Auto-register invoice message
    await bot.handleUpdate({
      update_id: 1,
      message: initialPhotoMsg,
    } as any);

    // Assign distributor and amount via /koreta 340000
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 102,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/koreta 340000',
        reply_to_message: initialPhotoMsg,
      },
    } as any);

    // Verify bot re-sent user message as clean bot-owned message preserving the original photo
    const registeredBotMsg = sentMessages.find((m) => m.photo === 'original_invoice_photo_id');
    assert.ok(registeredBotMsg, 'Bot must send message with original photo');
    const primaryMsgId = registeredBotMsg.message_id;

    const tx1 = (await txService.findByAnyMessageId(String(testConfig.telegramGroupId), primaryMsgId))!;
    assert.ok(tx1, 'Transaction must be registered');
    assert.equal(tx1.amount, 340000);
    assert.equal(tx1.mediaFileId, 'original_invoice_photo_id');
    assert.equal(tx1.mediaType, 'photo');

    // Verify caption and inline keyboard directly on primary photo invoice message
    assert.match(registeredBotMsg.caption, /🧾 INVOICE • #INV0001/);
    assert.match(registeredBotMsg.caption, /🏦 Bank: Hana Bank/);
    assert.match(registeredBotMsg.caption, /🔢 Account: 012-345678-2341/);
    assert.match(registeredBotMsg.caption, /👤 Holder: Koreta CoLtd/);
    assert.match(registeredBotMsg.caption, /🏢 Koreta/);
    assert.match(registeredBotMsg.caption, /📥 Original Registration:/);
    assert.match(registeredBotMsg.caption, /💵 Registered Amount:\n└─> 💰 ₩340,000/);
    assert.match(registeredBotMsg.caption, /💰 Invoice Total: ₩340,000/);
    assert.match(registeredBotMsg.caption, /💵 Total Paid: ₩0/);
    assert.match(registeredBotMsg.caption, /⚖️ Need to Pay: ₩340,000/);
    assert.match(registeredBotMsg.caption, /📊 Status: ⏳ PENDING/);

    // Copy Account Number button is attached directly to the initial invoice message
    assert.equal(
      registeredBotMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.text,
      'Copy Account Number'
    );
    assert.equal(
      registeredBotMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text?.text,
      '012-345678-2341'
    );

    // No separate account-control message during initial registration
    const separateControlMsgs = sentMessages.filter(
      (m) => m.text && /Account details for #INV0001/.test(m.text)
    );
    assert.equal(separateControlMsgs.length, 0, 'Must NOT send a separate account-control message during registration');

    // ─────────────────────────────────────────────────────────────
    // Step 2: /add 200,000 while replying to the invoice with new media
    // ─────────────────────────────────────────────────────────────
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 201,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'addition_invoice_photo_id', width: 800, height: 600 }],
        caption: '/add 200000 what about note',
        reply_to_message: {
          message_id: primaryMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'original_invoice_photo_id' }],
          caption: registeredBotMsg.caption,
        },
      },
    } as any);

    // Verify new media message was sent containing both photos and full caption
    const primaryAlbumMsg = sentMessages.filter((m) => m.photo === 'original_invoice_photo_id').pop()!;
    const addedMediaMsg = sentMessages.find((m) => m.photo === 'addition_invoice_photo_id');
    assert.ok(primaryAlbumMsg, 'Primary album message must be sent with original photo');
    assert.ok(addedMediaMsg, 'New media message must be sent with added photo');

    // Verify companion button message exists
    const buttonMsg = sentMessages.find(
      (m) => typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.ok(buttonMsg, 'Account details control message must be present');
    assert.equal(
      buttonMsg.reply_markup?.inline_keyboard?.[0]?.[0]?.text,
      'Copy Account Number'
    );
    assert.match(buttonMsg.text, /Hana Bank/);
    assert.match(buttonMsg.text, /012-345678-2341/);
    assert.match(buttonMsg.text, /Koreta CoLtd/);

    // Verify caption format on the new media message
    const combinedCaption = primaryAlbumMsg.caption;
    assert.match(combinedCaption, /🧾 INVOICE • #INV0001/);
    assert.doesNotMatch(combinedCaption, /🏦 Bank:/, 'Bank details must not be in album caption');
    assert.doesNotMatch(combinedCaption, /🔢 Account:/, 'Account details must not be in album caption');
    assert.doesNotMatch(combinedCaption, /👤 Holder:/, 'Holder details must not be in album caption');
    assert.doesNotMatch(combinedCaption, /012-345678-2341/, 'Account number must not be in album caption');
    assert.doesNotMatch(combinedCaption, /Hana Bank/, 'Bank name must not be in album caption');
    assert.doesNotMatch(combinedCaption, /Koreta CoLtd/, 'Holder name must not be in album caption');
    assert.match(combinedCaption, /📥 Original Registration:/);
    assert.match(combinedCaption, /💵 Registered Amount:\n└─> 💰 ₩340,000/);
    assert.match(combinedCaption, /➕ Invoice Addition/);
    assert.match(combinedCaption, /💵 Amount Added:\n└─> 💰 ₩200,000/);
    assert.match(combinedCaption, /📝 Note: what about note/);
    assert.match(combinedCaption, /💰 Invoice Total: ₩540,000/);
    assert.match(combinedCaption, /💵 Total Paid: ₩0/);
    assert.match(combinedCaption, /⚖️ Need to Pay: ₩540,000/);
    assert.match(combinedCaption, /📊 Status: ⏳ PENDING/);

    // Heading appears strictly once
    const headingMatches = combinedCaption.match(/🧾 INVOICE • #INV0001/g);
    assert.equal(headingMatches?.length, 1, 'Invoice heading must appear strictly once in final caption');

    // Verify original invoice message was updated with notice and direct link
    const origEdited = editedCaptions.find((e) => e.message_id === primaryMsgId);
    assert.ok(origEdited, 'Original invoice message must have update notice');
    assert.match(
      origEdited.caption,
      /⚠️ Invoice #INV0001 was updated\.\n\n🔗 Updated invoice: <a href=".*?">View updated invoice<\/a>\n\n🗑 Please delete this original message manually if no longer needed\./
    );
    assert.deepEqual(origEdited.reply_markup?.inline_keyboard, [], 'Keyboard must be removed from original message');

    // Verify account control message exists for the new invoice version
    const activeControlMsgs = sentMessages.filter((m) =>
      typeof m.text === 'string' && m.text.includes('Account details for')
    );
    assert.equal(activeControlMsgs.length, 1, 'Must have exactly one account-control message created for the media group');

    // Verify NO generic companion notice message was sent
    const genericCompanionMsgs = sentMessages.filter((m) =>
      typeof m.caption === 'string' && m.caption.includes('Additional invoice media for')
    );
    assert.equal(genericCompanionMsgs.length, 0, 'Must NOT send generic companion caption');

    // Verify database state: total is ₩540,000, active message is the new media message, original media remains intact
    const txAfterAdd = (await txRepo.findById(tx1.id))!;
    assert.equal(txAfterAdd.amount, 540000);
    assert.equal(txAfterAdd.metadata_message_id, primaryAlbumMsg.message_id);
    assert.equal(txAfterAdd.media_file_id, 'original_invoice_photo_id', 'Original media must be preserved');
    assert.equal(txAfterAdd.media_type, 'photo');

    // Verify addition media stored separately in invoice_additions table
    const additions = await txRepo.getAdditions(tx1.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].amount, 200000);
    assert.equal(additions[0].media_file_id, 'addition_invoice_photo_id');
    assert.equal(additions[0].media_type, 'photo');
    assert.equal(additions[0].note, 'what about note');

    // ─────────────────────────────────────────────────────────────
    // Step 3: Record a ₩140,000 partial payment with receipt evidence
    // ─────────────────────────────────────────────────────────────
    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 301,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'receipt_photo_140k', width: 800, height: 600 }],
        caption: '/paid 140000',
        reply_to_message: {
          message_id: primaryMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'original_invoice_photo_id' }],
          caption: combinedCaption,
        },
      },
    } as any);

    // Verify database state: status PARTIALLY_PAID, totalPaid 140000, balance 400000
    const txAfterPay = (await txRepo.findById(tx1.id))!;
    assert.equal(txAfterPay.status, 'PARTIALLY_PAID');
    assert.equal(txAfterPay.amount, 540000);
    assert.equal(txAfterPay.media_file_id, 'original_invoice_photo_id');

    const totalPaid = await txRepo.getTotalPaid(tx1.id);
    assert.equal(totalPaid, 140000);

    const payments = await txRepo.getPayments(tx1.id);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amount, 140000);
    assert.ok(payments[0].receipt_url, 'Receipt URL must be recorded');
    assert.match(payments[0].receipt_url, /https:\/\/t\.me\/c\/4463761895\/\d+/);

    // Verify active invoice message caption was edited in place
    const editsForPrimary = editedCaptions.filter((e) => e.message_id === primaryAlbumMsg.message_id);
    const latestEdit = editsForPrimary[editsForPrimary.length - 1];
    assert.ok(latestEdit);

    const finalCaption = latestEdit.caption;

    // Check divider counts: exactly 6 divider lines
    const dividerMatches = finalCaption.match(/━━━━━━━━━━━━/g);
    assert.equal(dividerMatches?.length, 6, 'Must contain exactly 6 divider lines');

    // Verify all 3 chronological action history blocks are present
    assert.match(finalCaption, /📥 Original Registration:/);
    assert.match(finalCaption, /💵 Registered Amount:\n└─> 💰 ₩340,000/);
    assert.match(finalCaption, /➕ Invoice Addition/);
    assert.match(finalCaption, /💵 Amount Added:\n└─> 💰 ₩200,000/);
    assert.match(finalCaption, /📝 Note: what about note/);
    assert.match(finalCaption, /➖ Partial payment/);
    assert.match(finalCaption, /💵 Amount paid:\n└─> 💰 ₩140,000/);
    assert.match(finalCaption, /🧾 Receipt URL:\n└─> 🔗 https:\/\/t\.me\/c\/4463761895\/\d+/);

    // Verify Financial Summary
    assert.match(finalCaption, /💰 Invoice Total: ₩540,000/);
    assert.match(finalCaption, /💵 Total Paid: ₩140,000/);
    assert.match(finalCaption, /⚖️ Need to Pay: ₩400,000/);
    assert.match(finalCaption, /📊 Status: ⏳ PARTIALLY PAID/);

    // Verify account-control message remains present during partial payment
    const controlMsgDuringPartial = sentMessages.find(
      (m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Copy Account Number'
    );
    assert.ok(controlMsgDuringPartial, 'Account-control message must remain present during partial payment');

    // ─────────────────────────────────────────────────────────────
    // Step 4: Full payment of remaining balance (₩400,000)
    // ─────────────────────────────────────────────────────────────
    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 401,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'receipt_photo_400k' }],
        caption: '/paid 400000',
        reply_to_message: {
          message_id: primaryMsgId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'original_invoice_photo_id' }],
          caption: finalCaption,
        },
      },
    } as any);

    const txFullyPaid = (await txRepo.findById(tx1.id))!;
    assert.equal(txFullyPaid.status, 'PAID');
    const finalTotalPaid = await txRepo.getTotalPaid(tx1.id);
    assert.equal(finalTotalPaid, 540000);

    // Account-control message must be cleaned up (deleted) upon full payment
    assert.equal(txFullyPaid.account_control_message_id, null);

    // Check confirmed topic received confirmation
    assert.ok(txFullyPaid.confirmation_message_id);
    assert.ok(txFullyPaid.confirmation_url);
  });

  it('Document/PDF invoices: preserves document media and edits caption in place', async () => {
    const harness = await setupTestHarness();
    const { bot, txRepo, txService, sentMessages, sentMediaGroups, editedCaptions } = harness;

    // 1. User sends PDF invoice
    const initialDocMsg = {
      message_id: 1101,
      from: { id: 222, is_bot: false },
      chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
      message_thread_id: testConfig.pendingTopicId,
      document: { file_id: 'invoice_pdf_file_id', file_name: 'invoice_001.pdf' },
      caption: 'Meat invoice PDF',
    };

    await bot.handleUpdate({ update_id: 11, message: initialDocMsg } as any);
    await bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 1102,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/koreta 500000',
        reply_to_message: initialDocMsg,
      },
    } as any);

    const docMsg = sentMessages.find((m) => m.document === 'invoice_pdf_file_id');
    assert.ok(docMsg, 'Must send primary document message');
    const primaryId = docMsg.message_id;

    // 2. /add 150000
    await bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 1201,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        document: { file_id: 'addition_pdf_file_id', file_name: 'add.pdf' },
        caption: '/add 150000 Extra cuts',
        reply_to_message: {
          message_id: primaryId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          document: { file_id: 'invoice_pdf_file_id' },
          caption: docMsg.caption,
        },
      },
    } as any);

    const edit = editedCaptions.find((e) => e.message_id === primaryId);
    assert.ok(edit, 'Original document message must have update notice');
    assert.match(
      edit.caption,
      /⚠️ Invoice #INV0001 was updated\.\n\n🔗 Updated invoice: <a href=".*?">View updated invoice<\/a>\n\n🗑 Please delete this original message manually if no longer needed\./
    );

    const primaryDoc = sentMessages.filter((m) => m.document === 'invoice_pdf_file_id').pop()!;
    const addedDoc = sentMessages.find((m) => m.document === 'addition_pdf_file_id');
    assert.ok(primaryDoc, 'Primary document in group must have caption');
    assert.ok(addedDoc, 'Added document in group must be present');
    assert.match(primaryDoc.caption, /💰 Invoice Total: ₩650,000/);
    assert.match(primaryDoc.caption, /⚖️ Need to Pay: ₩650,000/);

    const buttonMsg = sentMessages.find(
      (m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Copy Account Number'
    );
    assert.ok(buttonMsg, 'Copy Account Number button message must be sent');

    const tx = (await txService.findByAnyMessageId(
      String(testConfig.telegramGroupId),
      primaryId
    ))!;
    assert.equal(tx.mediaFileId, 'invoice_pdf_file_id', 'Original document preserved in DB');
    assert.equal(tx.mediaType, 'document');
    assert.equal(tx.amount, 650000, 'Total updated to 650,000');
  });

  it('Text-only invoices: preserves text editing and updates financial ledger', async () => {
    const harness = await setupTestHarness();
    const { bot, txRepo, txService, sentMessages, editedTexts } = harness;

    // 1. Text-only invoice
    const initialTextMsg = {
      message_id: 2101,
      from: { id: 222, is_bot: false },
      chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
      message_thread_id: testConfig.pendingTopicId,
      text: 'Beef items:\n1. 50kg Ribs = ₩300,000',
    };

    await bot.handleUpdate({ update_id: 21, message: initialTextMsg } as any);
    await bot.handleUpdate({
      update_id: 22,
      message: {
        message_id: 2102,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/koreta 300000',
        reply_to_message: initialTextMsg,
      },
    } as any);

    const textMsg = sentMessages.find((m) => m.text && !m.photo && !m.document);
    assert.ok(textMsg);
    const primaryId = textMsg.message_id;

    // 2. /add 100000
    await bot.handleUpdate({
      update_id: 23,
      message: {
        message_id: 2201,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/add 100000',
        reply_to_message: {
          message_id: primaryId,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: textMsg.text,
        },
      },
    } as any);

    const edit = editedTexts.find((e) => e.message_id === primaryId);
    assert.ok(edit, 'Text invoice must be edited via editMessageText');
    assert.match(edit.text, /💰 Invoice Total: ₩400,000/);
    assert.match(edit.text, /⚖️ Need to Pay: ₩400,000/);

    const tx = (await txService.findByAnyMessageId(String(testConfig.telegramGroupId), primaryId))!;
    assert.equal(tx.amount, 400000);
  });
});
