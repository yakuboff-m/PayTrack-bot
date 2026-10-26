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
import { globalMessageTracker } from '../src/bot/helpers/message-tracker';
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
  globalMessageTracker.clear();

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
  const editedMedias: any[] = [];
  const deletedMessageIds: number[] = [];

  // Configurable failure triggers for testing error handling
  let failNextEdit = false;
  let failNextDelete = false;

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

    if (method === 'editMessageText') {
      if (failNextEdit) {
        failNextEdit = false;
        throw new Error("Bad Request: message can't be edited");
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
      if (failNextEdit) {
        failNextEdit = false;
        throw new Error("Bad Request: message can't be edited");
      }
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

    if (method === 'editMessageMedia') {
      if (failNextEdit) {
        failNextEdit = false;
        throw new Error("Bad Request: message can't be edited");
      }
      editedMedias.push(payload);
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          chat: { id: payload.chat_id },
          media: payload.media,
        } as any,
      };
    }

    if (method === 'deleteMessage') {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error('Bad Request: message to delete not found');
      }
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
    editedMedias,
    deletedMessageIds,
    setFailNextEdit: (val: boolean) => {
      failNextEdit = val;
    },
    setFailNextDelete: (val: boolean) => {
      failNextDelete = val;
    },
  };
}

describe('PayTrack Bot: /edit Command Workflow & Safety Suite', () => {
  it('1. /edit without replying to a message shows usage instructions', async () => {
    const ctx = await setupTestContext();

    await ctx.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 101,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
      },
    } as any);

    const replyMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Usage: Reply to the message you want to edit with `/edit`')
    );
    assert.ok(replyMsg, 'Bot must reply with clear usage instruction');
    assert.equal(ctx.editedTexts.length, 0, 'No edit should occur');
    assert.equal(ctx.deletedMessageIds.length, 0, 'No delete should occur');
  });

  it('2. /edit with missing replacement content returns clear error without modifying target', async () => {
    const ctx = await setupTestContext();

    await ctx.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 105,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        reply_to_message: {
          message_id: 100,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Distributor payment is ₩300,000',
        },
      },
    } as any);

    const replyMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Missing replacement content')
    );
    assert.ok(replyMsg, 'Bot must explain that replacement content is missing');
    assert.equal(ctx.editedTexts.length, 0, 'Target message must not be edited');
    assert.equal(ctx.deletedMessageIds.length, 0, 'No messages should be deleted');
  });

  it('3. /edit by unauthorized user is rejected without modifications', async () => {
    const ctx = await setupTestContext();

    // Non-admin user (ID 999)
    await ctx.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 110,
        from: { id: 999, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit Replacement text',
        reply_to_message: {
          message_id: 100,
          chat: { id: testConfig.telegramGroupId },
          text: 'Original text',
        },
      },
    } as any);

    assert.equal(ctx.editedTexts.length, 0, 'Unauthorized user cannot edit text');
    assert.equal(ctx.deletedMessageIds.length, 0, 'No delete should occur');
  });

  it('4. /edit in wrong group or unauthorized topic is rejected', async () => {
    const ctx = await setupTestContext();

    // 4a. Wrong group
    await ctx.bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 120,
        from: { id: 111, is_bot: false },
        chat: { id: -999888777, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit Replacement text',
        reply_to_message: {
          message_id: 100,
          chat: { id: -999888777 },
          text: 'Original text',
        },
      },
    } as any);

    const groupErr = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('authorized group')
    );
    assert.ok(groupErr, 'Must reject command in unauthorized group');
    assert.equal(ctx.editedTexts.length, 0);

    // 4b. Unauthorized topic
    await ctx.bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 125,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: 9999, // Unknown topic
        text: '/edit Replacement text',
        reply_to_message: {
          message_id: 100,
          chat: { id: testConfig.telegramGroupId },
          text: 'Original text',
        },
      },
    } as any);

    const topicErr = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('authorized topics')
    );
    assert.ok(topicErr, 'Must reject command in unauthorized topic');
    assert.equal(ctx.editedTexts.length, 0);
  });

  it('5. Successful text replacement: edits target text, cleans up replacement message, and confirms', async () => {
    const ctx = await setupTestContext();

    // 1. Send replacement message (id: 201)
    await ctx.bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 201,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'Distributor payment is ₩350,000',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to original target message (id: 200) with /edit
    await ctx.bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 202,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 200,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Distributor payment is ₩300,000',
        },
      },
    } as any);

    // Target message edited
    const editCall = ctx.editedTexts.find((e) => e.message_id === 200);
    assert.ok(editCall, 'Target message 200 must be edited');
    assert.equal(editCall.text, 'Distributor payment is ₩350,000');

    // Replacement message 201 deleted
    assert.ok(ctx.deletedMessageIds.includes(201), 'Replacement message 201 must be deleted');

    // Success confirmation sent
    const confirmMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Message edited successfully')
    );
    assert.ok(confirmMsg, 'Success confirmation must be sent');
  });

  it('6. Successful caption replacement while preserving photo media', async () => {
    const ctx = await setupTestContext();

    // 1. Send replacement text message (id: 301)
    await ctx.bot.handleUpdate({
      update_id: 20,
      message: {
        message_id: 301,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'Meat Delivery 12kg - Verified',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to photo message (id: 300) with /edit
    await ctx.bot.handleUpdate({
      update_id: 21,
      message: {
        message_id: 302,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 300,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_ribs_123' }],
          caption: 'Meat Delivery 10kg',
        },
      },
    } as any);

    // Photo caption edited
    const editCaptionCall = ctx.editedCaptions.find((e) => e.message_id === 300);
    assert.ok(editCaptionCall, 'Photo caption must be edited via editMessageCaption');
    assert.equal(editCaptionCall.caption, 'Meat Delivery 12kg - Verified');

    // Replacement message deleted
    assert.ok(ctx.deletedMessageIds.includes(301));
  });

  it('7. Successful caption replacement while preserving document media', async () => {
    const ctx = await setupTestContext();

    // 1. Send replacement text message (id: 401)
    await ctx.bot.handleUpdate({
      update_id: 30,
      message: {
        message_id: 401,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'March Meat Invoice PDF (Corrected)',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to document message (id: 400) with /edit
    await ctx.bot.handleUpdate({
      update_id: 31,
      message: {
        message_id: 402,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 400,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          document: { file_id: 'doc_invoice_pdf' },
          caption: 'March Meat Invoice PDF',
        },
      },
    } as any);

    // Document caption edited
    const editCaptionCall = ctx.editedCaptions.find((e) => e.message_id === 400);
    assert.ok(editCaptionCall, 'Document caption must be edited via editMessageCaption');
    assert.equal(editCaptionCall.caption, 'March Meat Invoice PDF (Corrected)');

    // Replacement message deleted
    assert.ok(ctx.deletedMessageIds.includes(401));
  });

  it('8. Supported media replacement: updates media and caption using editMessageMedia', async () => {
    const ctx = await setupTestContext();

    // 1. Send replacement photo message (id: 501)
    await ctx.bot.handleUpdate({
      update_id: 40,
      message: {
        message_id: 501,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_updated_meat_999' }],
        caption: 'High resolution updated receipt',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to photo message (id: 500) with /edit
    await ctx.bot.handleUpdate({
      update_id: 41,
      message: {
        message_id: 502,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 500,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          photo: [{ file_id: 'photo_blurry_meat_111' }],
          caption: 'Blurry receipt',
        },
      },
    } as any);

    // editMessageMedia called
    const editMediaCall = ctx.editedMedias.find((e) => e.message_id === 500);
    assert.ok(editMediaCall, 'Photo media must be replaced via editMessageMedia');
    assert.equal(editMediaCall.media.media, 'photo_updated_meat_999');
    assert.equal(editMediaCall.media.caption, 'High resolution updated receipt');

    // Replacement message deleted
    assert.ok(ctx.deletedMessageIds.includes(501));
  });

  it('9. Unsupported media combinations: rejects text to media replacement', async () => {
    const ctx = await setupTestContext();

    // 1. Send replacement photo message (id: 601)
    await ctx.bot.handleUpdate({
      update_id: 50,
      message: {
        message_id: 601,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        photo: [{ file_id: 'photo_new_123' }],
        caption: 'Photo replacement',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to text message (id: 600) with /edit
    await ctx.bot.handleUpdate({
      update_id: 51,
      message: {
        message_id: 602,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 600,
          chat: { id: testConfig.telegramGroupId },
          message_thread_id: testConfig.pendingTopicId,
          text: 'Original plain text message',
        },
      },
    } as any);

    const errorMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Cannot replace a text message with media')
    );
    assert.ok(errorMsg, 'Must return error explaining unsupported combination');
    assert.equal(ctx.editedTexts.length, 0, 'Target text message must NOT be modified');
    assert.equal(ctx.editedMedias.length, 0);
    assert.equal(ctx.deletedMessageIds.includes(601), false, 'Replacement message must NOT be deleted on error');
  });

  it('10. Telegram edit failure preserves both target and replacement messages', async () => {
    const ctx = await setupTestContext();
    ctx.setFailNextEdit(true);

    // 1. Send replacement message (id: 701)
    await ctx.bot.handleUpdate({
      update_id: 60,
      message: {
        message_id: 701,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'New text',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to target (id: 700) with /edit
    await ctx.bot.handleUpdate({
      update_id: 61,
      message: {
        message_id: 702,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 700,
          chat: { id: testConfig.telegramGroupId },
          text: 'Old text',
        },
      },
    } as any);

    const errorMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Failed to edit message')
    );
    assert.ok(errorMsg, 'Error message must be returned to user');
    assert.equal(ctx.deletedMessageIds.includes(701), false, 'Replacement message must be preserved on edit failure');
  });

  it('11. Replacement-message deletion failure does not fail successful edit', async () => {
    const ctx = await setupTestContext();
    ctx.setFailNextDelete(true);

    // 1. Send replacement message (id: 801)
    await ctx.bot.handleUpdate({
      update_id: 70,
      message: {
        message_id: 801,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'New text version',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Reply to target (id: 800) with /edit
    await ctx.bot.handleUpdate({
      update_id: 71,
      message: {
        message_id: 802,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 800,
          chat: { id: testConfig.telegramGroupId },
          text: 'Old text version',
        },
      },
    } as any);

    // Edit still succeeded
    const editCall = ctx.editedTexts.find((e) => e.message_id === 800);
    assert.ok(editCall, 'Target message 800 was successfully edited');

    // Success confirmation sent despite delete failure
    const confirmMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Message edited successfully')
    );
    assert.ok(confirmMsg, 'Success confirmation must still be delivered');
  });

  it('12. Protected invoice message rejection: prevents /edit on primary or original invoice message', async () => {
    const ctx = await setupTestContext();

    // Register invoice with ID 900
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      900,
      undefined,
      'photo_invoice_id',
      'photo'
    );
    await ctx.txRepo.updateMetadataMessageId(tx.id, 900);

    // Send replacement message (id: 905)
    await ctx.bot.handleUpdate({
      update_id: 80,
      message: {
        message_id: 905,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'Tampered invoice amount ₩9,999,999',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // Attempt /edit on protected invoice message 900
    await ctx.bot.handleUpdate({
      update_id: 81,
      message: {
        message_id: 906,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 900,
          chat: { id: testConfig.telegramGroupId },
          photo: [{ file_id: 'photo_invoice_id' }],
          caption: 'Original Invoice #INV0001',
        },
      },
    } as any);

    const errorMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Cannot edit protected invoice messages with /edit')
    );
    assert.ok(errorMsg, 'Must reject /edit on protected invoice message');
    assert.equal(ctx.editedCaptions.length, 0, 'Protected invoice caption must NOT be edited');
    assert.equal(ctx.deletedMessageIds.includes(905), false, 'Replacement message must be preserved');
  });

  it('13. Protected account-control message rejection', async () => {
    const ctx = await setupTestContext();

    // Register invoice and set account control message ID 950
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      940
    );
    await ctx.txRepo.updateAccountControlMessageId(tx.id, 950);

    // Send replacement message (id: 951)
    await ctx.bot.handleUpdate({
      update_id: 90,
      message: {
        message_id: 951,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'Fake bank: 999-999-999',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // Attempt /edit on account-control message 950
    await ctx.bot.handleUpdate({
      update_id: 91,
      message: {
        message_id: 952,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 950,
          chat: { id: testConfig.telegramGroupId },
          text: '💳 Account details for #INV0001:',
        },
      },
    } as any);

    const errorMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Cannot edit account-control messages with /edit')
    );
    assert.ok(errorMsg, 'Must reject /edit on account-control message');
    assert.equal(ctx.editedTexts.length, 0, 'Account-control text must NOT be edited');
    assert.equal(ctx.deletedMessageIds.includes(951), false);
  });

  it('14. Protected Confirmed/payment-history message rejection', async () => {
    const ctx = await setupTestContext();

    // Register invoice and set confirmation message ID 980
    const tx = await ctx.txService.registerTransaction(
      String(testConfig.telegramGroupId),
      testConfig.pendingTopicId,
      970
    );
    await ctx.txRepo.markPaid(tx.id, new Date().toISOString(), 975, 980, 'https://t.me/c/123/980');

    // Send replacement message (id: 981)
    await ctx.bot.handleUpdate({
      update_id: 100,
      message: {
        message_id: 981,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.confirmedTopicId,
        text: 'Tampered payment confirmation',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // Attempt /edit on confirmed summary message 980
    await ctx.bot.handleUpdate({
      update_id: 101,
      message: {
        message_id: 982,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.confirmedTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 980,
          chat: { id: testConfig.telegramGroupId },
          text: 'PAID: #INV0001',
        },
      },
    } as any);

    const errorMsg = ctx.sentMessages.find((m) =>
      typeof m.text === 'string' && m.text.includes('Cannot edit confirmed payment records with /edit')
    );
    assert.ok(errorMsg, 'Must reject /edit on confirmed payment record');
    assert.equal(ctx.editedTexts.length, 0);
    assert.equal(ctx.deletedMessageIds.includes(981), false);
  });

  it('15. Duplicate command delivery and retry behavior is idempotent', async () => {
    const ctx = await setupTestContext();

    // 1. Send replacement message (id: 1101)
    await ctx.bot.handleUpdate({
      update_id: 110,
      message: {
        message_id: 1101,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: 'Announcement update: closed on Tuesday',
        date: Math.floor(Date.now() / 1000),
      },
    } as any);

    // 2. Command delivery 1
    const commandUpdate = {
      update_id: 111,
      message: {
        message_id: 1102,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit',
        date: Math.floor(Date.now() / 1000) + 1,
        reply_to_message: {
          message_id: 1100,
          chat: { id: testConfig.telegramGroupId },
          text: 'Announcement: closed on Monday',
        },
      },
    };

    await ctx.bot.handleUpdate(commandUpdate as any);
    assert.equal(ctx.editedTexts.length, 1);
    const firstSentCount = ctx.sentMessages.length;

    // 3. Command delivery 2 (retry of same message)
    await ctx.bot.handleUpdate(commandUpdate as any);

    // Idempotent: no duplicate edit attempts or errors
    assert.equal(ctx.editedTexts.length, 1, 'Duplicate command must not perform duplicate edit');
  });

  it('16. Direct text and media in command message works seamlessly', async () => {
    const ctx = await setupTestContext();

    // Direct /edit with text
    await ctx.bot.handleUpdate({
      update_id: 120,
      message: {
        message_id: 1201,
        from: { id: 111, is_bot: false },
        chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
        message_thread_id: testConfig.pendingTopicId,
        text: '/edit Quick inline edit text',
        reply_to_message: {
          message_id: 1200,
          chat: { id: testConfig.telegramGroupId },
          text: 'Old inline text',
        },
      },
    } as any);

    const editCall = ctx.editedTexts.find((e) => e.message_id === 1200);
    assert.ok(editCall, 'Target 1200 edited with inline text');
    assert.equal(editCall.text, 'Quick inline edit text');
  });
});
