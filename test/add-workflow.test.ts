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
    name: 'Meat Supplier',
    alias: 'supplier',
    bankName: 'Shinhan',
    accountNumber: '110-123-456789',
    accountHolder: 'Meat Boss',
  });

  const apiCalls: Array<{ method: string; payload: any }> = [];
  const sentMessages: any[] = [];
  const sentMediaGroups: any[] = [];
  const editedTexts: any[] = [];
  const editedCaptions: any[] = [];
  const deletedMessageIds: number[] = [];

  const failMethods = new Set<string>();

  const { bot } = createBot({
    config: testConfig,
    db,
    executionContext: { waitUntil: () => {} } as any,
  });

  bot.api.config.use(async (prev, method, payload: any) => {
    apiCalls.push({ method, payload });

    if (failMethods.has(method)) {
      throw new Error(`Simulated API failure on ${method}`);
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
    txRepo,
    txService,
    distService,
    distributor,
    bot,
    apiCalls,
    sentMessages,
    sentMediaGroups,
    editedTexts,
    editedCaptions,
    deletedMessageIds,
    failMethods,
  };
}

describe('/add Workflow Regression Suite', () => {
  it('1. Photo invoice + photo /add: edits primary invoice in place, preserves original media, stores addition separately, deletes admin message', async () => {
    const ctx = await setupTestContext();

    // 1. Initial photo invoice
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      501,
      undefined,
      'photo_initial_1',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snapshot);
    await ctx.txService.setAmount(tx.id, 240000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 501);

    // 2. Admin replies with photo and /add 230000
    await ctx.bot.handleUpdate({
      update_id: 101,
      message: {
        message_id: 601,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_add_1', width: 800, height: 600 }],
        caption: '/add 230000 Additional ribs',
        reply_to_message: {
          message_id: 501,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_initial_1', width: 800, height: 600 }],
          caption: 'Original meat delivery',
        },
      },
    } as any);

    // Assert primary invoice message was edited in place via editMessageCaption
    const editedPrimary = ctx.editedCaptions.find((e) => e.message_id === 501);
    assert.ok(editedPrimary, 'Primary invoice message (501) must be edited in place');

    // Assert no new photo message was sent (original media preserved in place)
    const newSentPhotos = ctx.sentMessages.filter((m) => m.photo || m.caption);
    assert.equal(newSentPhotos.length, 0, 'No replacement photo message must be sent when editing in place succeeds');

    const caption = editedPrimary.caption;
    assert.ok(caption);
    assert.match(caption, /🧾 INVOICE • #INV0001/);
    assert.match(caption, /🏢 Meat Supplier/);
    assert.match(caption, /📥 Original Registration:/);
    assert.match(caption, /💵 Registered Amount:\n└─> 💰 ₩240,000/);
    assert.match(caption, /➕ Invoice Addition/);
    assert.match(caption, /💵 Amount Added:\n└─> 💰 ₩230,000/);
    assert.match(caption, /📝 Note: Additional ribs/);
    assert.match(caption, /💰 Invoice Total: ₩470,000/);
    assert.match(caption, /⚖️ Need to Pay: ₩470,000/);
    assert.match(caption, /📊 Status: ⏳ PENDING/);

    // Assert Copy Account Number keyboard belongs directly to primary invoice message
    assert.ok(editedPrimary.reply_markup?.inline_keyboard?.length > 0, 'Keyboard must remain on primary message');
    assert.equal(editedPrimary.reply_markup.inline_keyboard[0][0].text, 'Copy Account Number');

    // Assert DB total updated and addition recorded separately
    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.amount, 470000);
    assert.equal(updatedTx.metadata_message_id, 501);
    // Original media is preserved permanently on transaction
    assert.equal(updatedTx.media_file_id, 'photo_initial_1');
    assert.equal(updatedTx.media_type, 'photo');

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].amount, 230000);
    assert.equal(additions[0].media_file_id, 'photo_add_1');
    assert.equal(additions[0].media_type, 'photo');

    // Assert admin /add message was deleted
    assert.ok(ctx.deletedMessageIds.includes(601), 'Admin /add message must be deleted');
  });

  it('2. Document invoice + document /add: edits primary document in place and preserves original document', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      502,
      undefined,
      'doc_initial_1',
      'document'
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 502);

    await ctx.bot.handleUpdate({
      update_id: 102,
      message: {
        message_id: 602,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        document: { file_id: 'doc_add_2', file_name: 'invoice_part2.pdf' },
        caption: '/add 50000',
        reply_to_message: {
          message_id: 502,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          document: { file_id: 'doc_initial_1', file_name: 'invoice_part1.pdf' },
          caption: 'Invoice part 1',
        },
      },
    } as any);

    const editedPrimary = ctx.editedCaptions.find((e) => e.message_id === 502);
    assert.ok(editedPrimary, 'Primary document message must be edited in place');
    assert.match(editedPrimary.caption, /💰 Invoice Total: ₩150,000/);

    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.media_file_id, 'doc_initial_1');
    assert.equal(updatedTx.media_type, 'document');

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].media_file_id, 'doc_add_2');

    assert.ok(ctx.deletedMessageIds.includes(602));
  });

  it('3. Mixed media: photo invoice + document /add preserves original photo and stores addition document', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      503,
      undefined,
      'photo_init',
      'photo'
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 503);

    // Initial photo + addition document
    await ctx.bot.handleUpdate({
      update_id: 103,
      message: {
        message_id: 603,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        document: { file_id: 'doc_supplementary', file_name: 'supplement.pdf' },
        caption: '/add 80000',
        reply_to_message: {
          message_id: 503,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_init' }],
          caption: 'Initial photo invoice',
        },
      },
    } as any);

    // Primary photo invoice is edited in place
    const editedPrimary = ctx.editedCaptions.find((e) => e.message_id === 503);
    assert.ok(editedPrimary, 'Photo invoice message must be edited in place');
    assert.match(editedPrimary.caption, /💰 Invoice Total: ₩180,000/);

    // Original media is preserved as photo
    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.media_file_id, 'photo_init');
    assert.equal(updatedTx.media_type, 'photo');

    // Addition document stored in additions table
    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].media_file_id, 'doc_supplementary');
    assert.equal(additions[0].media_type, 'document');

    assert.ok(ctx.deletedMessageIds.includes(603));
  });

  it('4. Duplicate update retry idempotency: Telegram retrying the update does not duplicate messages or amounts', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      504,
      undefined,
      'photo_orig',
      'photo'
    );
    await ctx.txService.setAmount(tx.id, 200000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 504);

    const update = {
      update_id: 104,
      message: {
        message_id: 604,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_retry_test' }],
        caption: '/add 100000',
        reply_to_message: {
          message_id: 504,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_orig' }],
        },
      },
    };

    // First attempt
    await ctx.bot.handleUpdate(update as any);

    const txAfterFirst = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterFirst.amount, 300000);

    // Telegram retries the exact same update
    await ctx.bot.handleUpdate(update as any);

    // Assert DB total unchanged
    const txAfterRetry = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterRetry.amount, 300000, 'Must not double-add amount on retry');

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1, 'Must have exactly 1 addition record');
  });

  it('5. Partial payment preservation: /add on PARTIALLY_PAID invoice retains payment ledger and updates balance due', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      505,
      undefined,
      'photo_orig',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(ctx.distributor);
    await ctx.txService.assignDistributor(tx.id, ctx.distributor.id, snapshot);
    await ctx.txService.setAmount(tx.id, 300000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 505);

    // Record partial payment of ₩100,000
    await ctx.txRepo.recordPayment(tx.id, 100000, '2026-10-25T10:00:00Z', 701, 702, null, 'Deposit');
    await ctx.txRepo.updateTransactionPaymentStatus({
      id: tx.id,
      status: 'PARTIALLY_PAID',
      paidAt: '2026-10-25T10:00:00Z',
    });

    const txBefore = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txBefore.status, 'PARTIALLY_PAID');

    // Admin replies with photo and /add 50000
    await ctx.bot.handleUpdate({
      update_id: 105,
      message: {
        message_id: 605,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_partial_add' }],
        caption: '/add 50000',
        reply_to_message: {
          message_id: 505,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_orig' }],
        },
      },
    } as any);

    // Assert status remains PARTIALLY_PAID
    const txAfter = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfter.status, 'PARTIALLY_PAID', 'Status must remain PARTIALLY_PAID');
    assert.equal(txAfter.amount, 350000, 'Grand total must be 300k + 50k = 350k');

    // Assert payments ledger preserved
    const totalPaid = await ctx.txRepo.getTotalPaid(tx.id);
    assert.equal(totalPaid, 100000, 'Total paid must remain 100k');

    // Assert edited invoice caption includes partial payment progress
    const edited = ctx.editedCaptions.find((e) => e.message_id === 505);
    assert.ok(edited);
    const caption = edited.caption;
    assert.match(caption, /💰 Invoice Total: ₩350,000/);
    assert.match(caption, /💵 Total Paid: ₩100,000/);
    assert.match(caption, /⚖️ Need to Pay: ₩250,000/);
    assert.ok(edited.reply_markup?.inline_keyboard?.length > 0, 'Keyboard attached directly');
  });

  it('6. Failure safety: Telegram failure preserves source media and reports exact failure step', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      506,
      undefined,
      'photo_orig',
      'photo'
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 506);

    // Simulate editMessageCaption and sendPhoto failure
    ctx.failMethods.add('editMessageCaption');
    ctx.failMethods.add('sendPhoto');

    await ctx.bot.handleUpdate({
      update_id: 106,
      message: {
        message_id: 606,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_fail_test' }],
        caption: '/add 50000',
        reply_to_message: {
          message_id: 506,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_orig' }],
        },
      },
    } as any);

    // Admin message 606 must NOT be deleted
    assert.equal(ctx.deletedMessageIds.includes(606), false, 'Source media must be preserved');

    // DB amount must not be altered
    const txAfter = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfter.amount, 100000);

    // Error reported to chat
    const errorMsg = ctx.sentMessages.find(
      (m) => typeof m.text === 'string' && m.text.includes('Failed to update invoice message')
    );
    assert.ok(errorMsg, 'Error reporting exact failed step must be sent');
  });

  it('7. Rejects /add on fully PAID invoice', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      507
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.markPaid(tx.id, '2026-10-25T10:00:00Z', 701, 702, 'https://t.me/c/123/702');

    await ctx.bot.handleUpdate({
      update_id: 107,
      message: {
        message_id: 607,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        caption: '/add 50000',
        reply_to_message: {
          message_id: 507,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
        },
      },
    } as any);

    const rejectMsg = ctx.sentMessages.find(
      (m) => typeof m.text === 'string' && m.text.includes('already been paid in full')
    );
    assert.ok(rejectMsg, 'Must reject /add on PAID invoice');
    assert.equal(ctx.deletedMessageIds.includes(607), false);
  });

  it('8. Exact #INV0015 scenario: Registration ₩450,000 + /add ₩200,000 preserves original media, updates in place, keyboard attached', async () => {
    const ctx = await setupTestContext();

    // Create Koreta distributor as in production #INV0015
    const koreta = await ctx.distService.create({
      name: 'Koreta',
      alias: 'koreta',
      bankName: 'Hana Bank',
      accountNumber: '012-345678-2341',
      accountHolder: 'Koreta CoLtd',
    });

    // Step 1: Initial invoice registration for ₩450,000 with photo
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      901,
      undefined,
      'photo_invoice_12345_inv0015',
      'photo'
    );
    const snapshot = ctx.distService.createSnapshot(koreta);
    await ctx.txService.assignDistributor(tx.id, koreta.id, snapshot);
    await ctx.txService.setAmount(tx.id, 450000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 901);

    // Step 2: Admin replies with second photo and /add 200000
    await ctx.bot.handleUpdate({
      update_id: 201,
      message: {
        message_id: 902,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_book_cover_inv0015', width: 800, height: 600 }],
        caption: '/add 200000',
        reply_to_message: {
          message_id: 901,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_invoice_12345_inv0015', width: 800, height: 600 }],
          caption: 'Invoice 12345',
        },
      },
    } as any);

    // 1. Primary invoice message edited in place
    const editedPrimary = ctx.editedCaptions.find((e) => e.message_id === 901);
    assert.ok(editedPrimary, 'Primary invoice message must be edited in place');

    // 2. Caption includes invoice identity, distributor, action history, and financial summary
    assert.match(editedPrimary.caption, /🧾 INVOICE • #INV0001/);
    assert.match(editedPrimary.caption, /🏢 Koreta/);
    assert.match(editedPrimary.caption, /💳 Hana Bank 012-345678-2341/);
    assert.match(editedPrimary.caption, /👤 Koreta CoLtd/);
    assert.match(editedPrimary.caption, /Original Registration:/);
    assert.match(editedPrimary.caption, /Registered Amount:\n└─> 💰 ₩450,000/);
    assert.match(editedPrimary.caption, /Invoice Addition/);
    assert.match(editedPrimary.caption, /Amount Added:\n└─> 💰 ₩200,000/);
    assert.match(editedPrimary.caption, /📊 FINANCIAL SUMMARY/);
    assert.match(editedPrimary.caption, /💰 Invoice Total: ₩650,000/);
    assert.match(editedPrimary.caption, /💵 Total Paid: ₩0/);
    assert.match(editedPrimary.caption, /⚖️ Need to Pay: ₩650,000/);
    assert.match(editedPrimary.caption, /📊 Status: ⏳ PENDING/);

    // 3. Inline keyboard includes the Copy Account Number button directly on the primary message
    assert.ok(editedPrimary.reply_markup?.inline_keyboard?.length > 0, 'Keyboard must be directly on primary message');
    assert.equal(editedPrimary.reply_markup.inline_keyboard[0][0].text, 'Copy Account Number');

    // 4. No second invoice preview or duplicate bank-information message is sent
    const textMessages = ctx.sentMessages.filter((m) => m.text && !m.photo && !m.document);
    assert.equal(textMessages.length, 0, 'No second invoice preview or duplicate bank-info message sent');

    // 5. Database records the invoice correctly
    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.amount, 650000, 'DB invoice total must be 650,000');
    assert.equal(updatedTx.status, 'PENDING');
    assert.equal(updatedTx.media_file_id, 'photo_invoice_12345_inv0015', 'Original media preserved in DB');
    assert.equal(updatedTx.media_type, 'photo');

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].amount, 200000);
    assert.equal(additions[0].media_file_id, 'photo_book_cover_inv0015', 'Addition media preserved in additions table');
  });
});
