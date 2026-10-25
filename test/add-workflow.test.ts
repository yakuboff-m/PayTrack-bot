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
  it('1. Photo invoice + photo /add: creates media group album, breakdown caption, edits old invoice with warning, deletes admin message', async () => {
    const ctx = await setupTestContext();

    // 1. Initial photo invoice
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      501
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

    // Assert media group was sent combining both photos
    assert.equal(ctx.sentMediaGroups.length, 1, 'Must send media group');
    const mg = ctx.sentMediaGroups[0];
    assert.equal(mg.media.length, 2);
    assert.equal(mg.media[0].type, 'photo');
    assert.equal(mg.media[0].media, 'photo_initial_1');
    assert.equal(mg.media[1].type, 'photo');
    assert.equal(mg.media[1].media, 'photo_add_1');

    // Assert caption breakdown on first photo of media group
    const caption = mg.media[0].caption;
    assert.ok(caption);
    assert.match(caption, /Registered Amount: ₩240,000/);
    assert.match(caption, /Amount Added: ₩230,000/);
    assert.match(caption, /Updated Invoice Total: ₩470,000/);

    // Assert follow-up copy account keyboard message sent
    const keyboardMsg = ctx.sentMessages.find(
      (m) => m.reply_markup && m.reply_markup.inline_keyboard?.length > 0
    );
    assert.ok(keyboardMsg, 'Copy account button must be sent');
    assert.equal(keyboardMsg.reply_to_message_id, 8000, 'Must reply to first message of media group');

    // Assert DB total updated and addition recorded
    const updatedTx = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(updatedTx.amount, 470000);
    assert.equal(updatedTx.metadata_message_id, 8000);

    const additions = await ctx.txRepo.getAdditions(tx.id);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].amount, 230000);
    assert.equal(additions[0].media_file_id, 'photo_add_1');
    assert.equal(additions[0].media_type, 'photo');

    // Assert original invoice was edited with manual deletion warning and keyboard cleared
    const editedOld = ctx.editedCaptions.find((e) => e.message_id === 501);
    assert.ok(editedOld, 'Original invoice must be edited');
    assert.match(editedOld.caption, /🆔 #INV0001 • 🔄 UPDATED/);
    assert.match(editedOld.caption, /🔗 Updated Invoice: https:\/\/t\.me\/c\/123456\/8000/);
    assert.match(editedOld.caption, /⚠️ Should be deleted manually!/);
    assert.deepEqual(editedOld.reply_markup, { inline_keyboard: [] }, 'Keyboard must be removed');

    // Assert admin /add message was deleted
    assert.ok(ctx.deletedMessageIds.includes(601), 'Admin /add message must be deleted');

    // Assert API call order
    const callNames = ctx.apiCalls.map((c) => c.method);
    const mediaGroupIdx = callNames.indexOf('sendMediaGroup');
    const editIdx = callNames.indexOf('editMessageCaption');
    const deleteIdx = callNames.indexOf('deleteMessage');
    assert.ok(mediaGroupIdx < editIdx, 'sendMediaGroup must happen before editing original message');
    assert.ok(editIdx < deleteIdx, 'editMessageCaption must happen before deleting admin message');
  });

  it('2. Document invoice + document /add: creates media group album of documents', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      502
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

    assert.equal(ctx.sentMediaGroups.length, 1);
    const mg = ctx.sentMediaGroups[0];
    assert.equal(mg.media.length, 2);
    assert.equal(mg.media[0].type, 'document');
    assert.equal(mg.media[0].media, 'doc_initial_1');
    assert.equal(mg.media[1].type, 'document');
    assert.equal(mg.media[1].media, 'doc_add_2');
    assert.match(mg.media[0].caption, /Updated Invoice Total: ₩150,000/);

    assert.ok(ctx.deletedMessageIds.includes(602));
  });

  it('3. Mixed media: photo invoice + document /add sends updated document cleanly (Telegram forbids mixed media groups)', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      503
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

    // Must NOT call sendMediaGroup because Telegram rejects mixed photo+document
    assert.equal(ctx.sentMediaGroups.length, 0);

    // Must send updated document
    const sentDoc = ctx.sentMessages.find(
      (m) => m.document === 'doc_supplementary' || m.document?.file_id === 'doc_supplementary'
    );
    assert.ok(sentDoc, 'Must send updated document');
    assert.match(sentDoc.caption, /Updated Invoice Total: ₩180,000/);

    // Original invoice edited and admin message deleted
    assert.ok(ctx.editedCaptions.find((e) => e.message_id === 503));
    assert.ok(ctx.deletedMessageIds.includes(603));
  });

  it('4. Duplicate update retry idempotency: Telegram retrying the update does not duplicate messages or amounts', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      504
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
    assert.equal(ctx.sentMediaGroups.length, 1);

    const txAfterFirst = (await ctx.txRepo.findById(tx.id))!;
    assert.equal(txAfterFirst.amount, 300000);

    // Telegram retries the exact same update
    await ctx.bot.handleUpdate(update as any);

    // Assert no second media group sent
    assert.equal(ctx.sentMediaGroups.length, 1, 'Must not duplicate media group on retry');

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
      505
    );
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

    // Assert new invoice caption includes partial payment progress
    const mg = ctx.sentMediaGroups[0];
    assert.ok(mg);
    const caption = mg.media[0].caption;
    assert.match(caption, /Updated Invoice Total: ₩350,000/);
    assert.match(caption, /Total Paid: ₩100,000/);
    assert.match(caption, /⚖️ Balance Due: ₩250,000/);
  });

  it('6. Failure safety: Telegram failure preserves source media and reports exact failure step', async () => {
    const ctx = await setupTestContext();

    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      506
    );
    await ctx.txService.setAmount(tx.id, 100000);
    await ctx.txRepo.updateMetadataMessageId(tx.id, 506);

    // Simulate sendMediaGroup failure
    ctx.failMethods.add('sendMediaGroup');

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
      (m) => typeof m.text === 'string' && m.text.includes('Failed to create updated invoice message')
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
});
