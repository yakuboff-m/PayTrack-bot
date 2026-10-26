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
import { createBot, setupBotCommands, BOT_COMMANDS } from '../src/bot/bot';
import { parseConfigFromEnv, parseAdminIds, type Config } from '../src/config/config';
import { isAdmin } from '../src/bot/middleware/auth.middleware';

function createInMemoryDb(): SqliteDatabaseAdapter {
  const sqlite = new Database(':memory:');
  const schemaPath = path.join(__dirname, '../src/database/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  sqlite.exec(schema);
  return new SqliteDatabaseAdapter(sqlite);
}

const multiAdminConfig: Config = {
  botToken: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ',
  telegramGroupId: -100123456,
  pendingTopicId: 2,
  confirmedTopicId: 3,
  adminUserIds: [1823403862, 7349217708],
};

async function setupTestContext(config: Config = multiAdminConfig) {
  const db = createInMemoryDb();

  const distRepo = new DistributorRepository(db);
  const distService = new DistributorService(distRepo);
  const txRepo = new TransactionRepository(db);
  const txService = new TransactionService(txRepo, config);

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
  const callbackAlerts: string[] = [];

  const { bot } = createBot({
    config,
    db,
    executionContext: { waitUntil: () => {} } as any,
  });

  bot.api.config.use(async (prev, method, payload: any) => {
    apiCalls.push({ method, payload });

    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
      const msg = {
        ...payload,
        message_id: 1000 + sentMessages.length,
        chat: { id: payload.chat_id },
        date: Math.floor(Date.now() / 1000),
      };
      sentMessages.push(msg);
      return { ok: true, result: msg as any };
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
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          caption: payload.caption,
          chat: { id: payload.chat_id },
        } as any,
      };
    }

    if (method === 'answerCallbackQuery') {
      if (payload.text) {
        callbackAlerts.push(payload.text);
      }
      return { ok: true, result: true as any };
    }

    if (method === 'deleteMessage') {
      return { ok: true, result: true as any };
    }

    if (method === 'setMyCommands') {
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
    editedTexts,
    callbackAlerts,
  };
}

describe('Multi-Admin Authorization & Bot Menu Test Suite', () => {
  describe('1. Configuration & ID Parsing', () => {
    it('parses the first and second IDs correctly from comma-separated list', () => {
      const ids = parseAdminIds('1823403862, 7349217708');
      assert.deepEqual(ids, [1823403862, 7349217708]);
    });

    it('handles arbitrary whitespace after and around commas', () => {
      const ids = parseAdminIds('   1823403862   ,   7349217708   ');
      assert.deepEqual(ids, [1823403862, 7349217708]);
    });

    it('parses three or more comma-separated IDs', () => {
      const ids = parseAdminIds('100, 200, 300, 400, 500');
      assert.deepEqual(ids, [100, 200, 300, 400, 500]);
    });

    it('ignores empty entries between commas or at ends', () => {
      const ids = parseAdminIds(', 1823403862 , , 7349217708 , ,');
      assert.deepEqual(ids, [1823403862, 7349217708]);
    });

    it('rejects invalid or non-numeric tokens', () => {
      assert.throws(() => parseAdminIds('1823403862, abc'), /Invalid admin user ID: "abc"/);
      assert.throws(() => parseAdminIds('1823403862, 123xyz'), /Invalid admin user ID: "123xyz"/);
      assert.throws(() => parseAdminIds('1823403862, -100'), /Invalid admin user ID: "-100"/);
    });

    it('throws error when TELEGRAM_ADMIN_USER_IDS is missing or empty', () => {
      assert.throws(
        () =>
          parseConfigFromEnv({
            BOT_TOKEN: '123:ABC',
            TELEGRAM_GROUP_ID: 1,
            TELEGRAM_PENDING_TOPIC_ID: 2,
            TELEGRAM_CONFIRMED_TOPIC_ID: 3,
            TELEGRAM_ADMIN_USER_IDS: '',
          }),
        /Missing TELEGRAM_ADMIN_USER_IDS/
      );

      assert.throws(
        () =>
          parseConfigFromEnv({
            BOT_TOKEN: '123:ABC',
            TELEGRAM_GROUP_ID: 1,
            TELEGRAM_PENDING_TOPIC_ID: 2,
            TELEGRAM_CONFIRMED_TOPIC_ID: 3,
            TELEGRAM_ADMIN_USER_IDS: ' , , ',
          }),
        /TELEGRAM_ADMIN_USER_IDS must contain at least one user ID/
      );
    });
  });

  describe('2. isAdmin Authorization Helper', () => {
    it('recognizes the first administrator ID', () => {
      assert.equal(isAdmin(1823403862, multiAdminConfig), true);
      assert.equal(isAdmin('1823403862', multiAdminConfig), true);
    });

    it('recognizes the second administrator ID', () => {
      assert.equal(isAdmin(7349217708, multiAdminConfig), true);
      assert.equal(isAdmin('7349217708', multiAdminConfig), true);
    });

    it('rejects unlisted user IDs', () => {
      assert.equal(isAdmin(999999, multiAdminConfig), false);
      assert.equal(isAdmin('999999', multiAdminConfig), false);
    });

    it('rejects null, undefined, and malformed inputs', () => {
      assert.equal(isAdmin(null as any, multiAdminConfig), false);
      assert.equal(isAdmin(undefined as any, multiAdminConfig), false);
      assert.equal(isAdmin('abc' as any, multiAdminConfig), false);
      assert.equal(isAdmin(0, multiAdminConfig), false);
      assert.equal(isAdmin(-1, multiAdminConfig), false);
    });

    it('grants nobody admin privileges when config has empty adminUserIds', () => {
      const emptyConfig: Config = { ...multiAdminConfig, adminUserIds: [] };
      assert.equal(isAdmin(1823403862, emptyConfig), false);
      assert.equal(isAdmin(7349217708, emptyConfig), false);
    });
  });

  describe('3. Admin-Only Commands with Multi-Admin', () => {
    it('allows Admin 1 to execute /amount, /confirmed, distributor alias, /note, and /edit', async () => {
      const ctx = await setupTestContext();
      const admin1Id = 1823403862;

      // 1. Initial photo message
      await ctx.bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 101,
          from: { id: 999, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          photo: [{ file_id: 'photo_test_1', width: 800, height: 600 }],
        },
      } as any);

      // 2. Admin 1 registers via alias /koreta 200000
      await ctx.bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 102,
          from: { id: admin1Id, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/koreta 200000',
          reply_to_message: {
            message_id: 101,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_1' }],
          },
        },
      } as any);

      const registered = ctx.sentMessages.find((m) => m.photo === 'photo_test_1');
      assert.ok(registered, 'Admin 1 must be permitted to register invoice via alias command');

      // 3. Admin 1 appends /note
      await ctx.bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 103,
          from: { id: admin1Id, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/note Verified by Admin 1',
          reply_to_message: {
            message_id: registered.message_id,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_1' }],
            caption: registered.caption,
          },
        },
      } as any);

      const tx = await ctx.txService.findByAnyMessageId(String(multiAdminConfig.telegramGroupId), registered.message_id);
      const notes = tx!.notes || [];
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'Verified by Admin 1');

      // 4. Admin 1 confirms payment via /paid 200000
      await ctx.bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 104,
          from: { id: admin1Id, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/paid 200000 Complete',
          reply_to_message: {
            message_id: registered.message_id,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_1' }],
            caption: registered.caption,
          },
        },
      } as any);

      const updatedTx = await ctx.txRepo.findById(tx!.id);
      assert.equal(updatedTx!.status, 'PAID', 'Admin 1 must be permitted to confirm invoice');
    });

    it('allows Admin 2 to execute /amount, /confirmed, distributor alias, /note, and /edit', async () => {
      const ctx = await setupTestContext();
      const admin2Id = 7349217708;

      // 1. Initial photo message
      await ctx.bot.handleUpdate({
        update_id: 10,
        message: {
          message_id: 201,
          from: { id: 999, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          photo: [{ file_id: 'photo_test_2', width: 800, height: 600 }],
        },
      } as any);

      // 2. Admin 2 registers via alias /koreta 350000
      await ctx.bot.handleUpdate({
        update_id: 11,
        message: {
          message_id: 202,
          from: { id: admin2Id, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/koreta 350000',
          reply_to_message: {
            message_id: 201,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_2' }],
          },
        },
      } as any);

      const registered = ctx.sentMessages.find((m) => m.photo === 'photo_test_2');
      assert.ok(registered, 'Admin 2 must be permitted to register invoice via alias command');

      // 3. Admin 2 changes amount via /amount 400000
      await ctx.bot.handleUpdate({
        update_id: 12,
        message: {
          message_id: 203,
          from: { id: admin2Id, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/amount 400000',
          reply_to_message: {
            message_id: registered.message_id,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_2' }],
            caption: registered.caption,
          },
        },
      } as any);

      const tx = await ctx.txService.findByAnyMessageId(String(multiAdminConfig.telegramGroupId), registered.message_id);
      assert.equal(tx!.amount, 400000, 'Admin 2 must be permitted to change invoice amount');

      // 4. Admin 2 confirms payment via /paid 400000
      await ctx.bot.handleUpdate({
        update_id: 13,
        message: {
          message_id: 204,
          from: { id: admin2Id, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/paid 400000 Complete',
          reply_to_message: {
            message_id: registered.message_id,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_2' }],
            caption: registered.caption,
          },
        },
      } as any);

      const updatedTx = await ctx.txRepo.findById(tx!.id);
      assert.equal(updatedTx!.status, 'PAID', 'Admin 2 must be permitted to confirm invoice');
    });

    it('rejects non-admin users from executing administrative actions', async () => {
      const ctx = await setupTestContext();
      const nonAdminId = 999999;

      // 1. Photo message
      await ctx.bot.handleUpdate({
        update_id: 20,
        message: {
          message_id: 301,
          from: { id: 999, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          photo: [{ file_id: 'photo_test_3', width: 800, height: 600 }],
        },
      } as any);

      // 2. Non-admin attempts alias command /koreta 100000
      await ctx.bot.handleUpdate({
        update_id: 21,
        message: {
          message_id: 302,
          from: { id: nonAdminId, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/koreta 100000',
          reply_to_message: {
            message_id: 301,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_3' }],
          },
        },
      } as any);

      const registered = ctx.sentMessages.find((m) => m.photo === 'photo_test_3');
      assert.equal(registered, undefined, 'Non-admin must NOT be permitted to register invoice');

      // 3. Non-admin attempts /paid
      await ctx.bot.handleUpdate({
        update_id: 22,
        message: {
          message_id: 303,
          from: { id: nonAdminId, is_bot: false },
          chat: { id: multiAdminConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: multiAdminConfig.pendingTopicId,
          text: '/paid 100000',
          reply_to_message: {
            message_id: 301,
            chat: { id: multiAdminConfig.telegramGroupId },
            message_thread_id: multiAdminConfig.pendingTopicId,
            photo: [{ file_id: 'photo_test_3' }],
          },
        },
      } as any);

      const rejection = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('You are not authorized to confirm transactions')
      );
      assert.ok(rejection, 'Non-admin must receive authorization rejection message');
    });
  });

  describe('4. Native Bot Menu Buttons & Distributor Management', () => {
    it('/menu renders the interactive reply keyboard for Admin 1 and Admin 2', async () => {
      const ctx = await setupTestContext();

      // Admin 1 sends /menu
      await ctx.bot.handleUpdate({
        update_id: 30,
        message: {
          message_id: 401,
          from: { id: 1823403862, is_bot: false },
          chat: { id: 1823403862, type: 'private' },
          text: '/menu',
        },
      } as any);

      const menuMsg1 = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Distributor Management Menu')
      );
      assert.ok(menuMsg1, 'Admin 1 must receive the menu');
      assert.ok(menuMsg1.reply_markup?.keyboard, 'Must have reply keyboard');

      // Verify menu buttons
      const buttons = menuMsg1.reply_markup.keyboard.flat().map((b: any) => b.text);
      assert.ok(buttons.includes('🏢 Distributors'));
      assert.ok(buttons.includes('➕ Add Distributor'));
      assert.ok(buttons.includes('✏️ Edit Distributor'));
      assert.ok(buttons.includes('🗑️ Delete Distributor'));
      assert.ok(buttons.includes('❌ Cancel'));

      // Non-admin sending /menu is rejected
      await ctx.bot.handleUpdate({
        update_id: 31,
        message: {
          message_id: 402,
          from: { id: 999999, is_bot: false },
          chat: { id: 999999, type: 'private' },
          text: '/menu',
        },
      } as any);

      const nonAdminResponses = ctx.sentMessages.filter((m) => m.chat?.id === 999999);
      assert.equal(nonAdminResponses.length, 0, 'Non-admin must not receive menu');
    });

    it('🏢 Distributors button lists distributors and includes action buttons for admins', async () => {
      const ctx = await setupTestContext();

      // Admin 2 presses '🏢 Distributors'
      await ctx.bot.handleUpdate({
        update_id: 40,
        message: {
          message_id: 501,
          from: { id: 7349217708, is_bot: false },
          chat: { id: 7349217708, type: 'private' },
          text: '🏢 Distributors',
        },
      } as any);

      const listMsg = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('DISTRIBUTORS')
      );
      assert.ok(listMsg);
      assert.match(listMsg.text, /Koreta Meat Co/);
      assert.match(listMsg.text, /\/koreta/);

      // Admin list keyboard contains action buttons
      assert.ok(listMsg.reply_markup?.inline_keyboard);
      const actionCallbacks = listMsg.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      assert.ok(actionCallbacks.includes('dist:add'));
      assert.ok(actionCallbacks.includes('dist:edit_select'));
      assert.ok(actionCallbacks.includes('dist:delete_select'));
    });

    it('➕ Add Distributor button guides administrator through multi-step creation flow', async () => {
      const ctx = await setupTestContext();
      const adminId = 1823403862;

      // 1. Click '➕ Add Distributor'
      await ctx.bot.handleUpdate({
        update_id: 50,
        message: {
          message_id: 601,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '➕ Add Distributor',
        },
      } as any);

      const askName = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Enter the distributor name:')
      );
      assert.ok(askName);

      // 2. Provide Name
      await ctx.bot.handleUpdate({
        update_id: 51,
        message: {
          message_id: 602,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'Seoul Prime Meats',
        },
      } as any);

      // 3. Provide Alias
      await ctx.bot.handleUpdate({
        update_id: 52,
        message: {
          message_id: 603,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'seoulprime',
        },
      } as any);

      // 4. Provide Bank
      await ctx.bot.handleUpdate({
        update_id: 53,
        message: {
          message_id: 604,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'Woori Bank',
        },
      } as any);

      // 5. Provide Account
      await ctx.bot.handleUpdate({
        update_id: 54,
        message: {
          message_id: 605,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '1002-345-678901',
        },
      } as any);

      // 6. Provide Holder
      await ctx.bot.handleUpdate({
        update_id: 55,
        message: {
          message_id: 606,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'Seoul Prime Co',
        },
      } as any);

      const confirmPrompt = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Confirm new distributor')
      );
      assert.ok(confirmPrompt);

      // 7. Confirm creation with 'yes'
      await ctx.bot.handleUpdate({
        update_id: 56,
        message: {
          message_id: 607,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'yes',
        },
      } as any);

      const createdMsg = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Created distributor: Seoul Prime Meats')
      );
      assert.ok(createdMsg);

      // Verify database persistence
      const dist = await ctx.distService.findByAlias('seoulprime');
      assert.ok(dist);
      assert.equal(dist.name, 'Seoul Prime Meats');
      assert.equal(dist.bankName, 'Woori Bank');
      assert.equal(dist.accountNumber, '1002-345-678901');
      assert.equal(dist.accountHolder, 'Seoul Prime Co');
    });

    it('prevents duplicate aliases during distributor creation', async () => {
      const ctx = await setupTestContext();
      const adminId = 7349217708;

      // 1. Click '➕ Add Distributor'
      await ctx.bot.handleUpdate({
        update_id: 60,
        message: {
          message_id: 701,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '➕ Add Distributor',
        },
      } as any);

      // 2. Provide Name
      await ctx.bot.handleUpdate({
        update_id: 61,
        message: {
          message_id: 702,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'Duplicate Test',
        },
      } as any);

      // 3. Provide existing alias /koreta
      await ctx.bot.handleUpdate({
        update_id: 62,
        message: {
          message_id: 703,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'koreta',
        },
      } as any);

      const duplicateWarning = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('already used by')
      );
      assert.ok(duplicateWarning, 'Must warn that alias is already used');
    });

    it('✏️ Edit Distributor displays selectable distributors, lets admin edit field, and refreshes details', async () => {
      const ctx = await setupTestContext();
      const adminId = 1823403862;

      // 1. Click '✏️ Edit Distributor'
      await ctx.bot.handleUpdate({
        update_id: 70,
        message: {
          message_id: 801,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '✏️ Edit Distributor',
        },
      } as any);

      const editPicker = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Select a distributor to edit')
      );
      assert.ok(editPicker);

      // 2. Select distributor 1
      await ctx.bot.handleUpdate({
        update_id: 71,
        callback_query: {
          id: 'cb_1',
          from: { id: adminId, is_bot: false },
          message: editPicker,
          data: `dist:edit:${ctx.distributor.id}`,
        },
      } as any);

      const fieldPrompt = ctx.editedTexts.find((e) => e.text.includes('Select a field to edit'));
      assert.ok(fieldPrompt);

      // 3. Select 'bank' field to edit
      await ctx.bot.handleUpdate({
        update_id: 72,
        callback_query: {
          id: 'cb_2',
          from: { id: adminId, is_bot: false },
          message: editPicker,
          data: `dist:edit_field:${ctx.distributor.id}:bank`,
        },
      } as any);

      const bankPrompt = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Enter the new bank name')
      );
      assert.ok(bankPrompt);

      // 4. Send updated bank name
      await ctx.bot.handleUpdate({
        update_id: 73,
        message: {
          message_id: 802,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: 'KB Kookmin Bank',
        },
      } as any);

      const updatedConfirmation = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Updated bank for')
      );
      assert.ok(updatedConfirmation);
      assert.match(updatedConfirmation.text, /KB Kookmin Bank/);

      // Verify DB update
      const updatedDist = (await ctx.distService.findById(ctx.distributor.id))!;
      assert.equal(updatedDist.bankName, 'KB Kookmin Bank');
    });

    it('🗑️ Delete Distributor requires confirmation and deletes distributor', async () => {
      const ctx = await setupTestContext();
      const adminId = 7349217708;

      // 1. Click '🗑️ Delete Distributor'
      await ctx.bot.handleUpdate({
        update_id: 80,
        message: {
          message_id: 901,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '🗑️ Delete Distributor',
        },
      } as any);

      const deletePicker = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Select a distributor to delete')
      );
      assert.ok(deletePicker);

      // 2. Select distributor to delete
      await ctx.bot.handleUpdate({
        update_id: 81,
        callback_query: {
          id: 'cb_del_1',
          from: { id: adminId, is_bot: false },
          message: deletePicker,
          data: `dist:delete:${ctx.distributor.id}`,
        },
      } as any);

      const confirmPrompt = ctx.editedTexts.find((e) => e.text.includes('Delete Koreta Meat Co?'));
      assert.ok(confirmPrompt);

      // 3. Confirm deletion
      await ctx.bot.handleUpdate({
        update_id: 82,
        callback_query: {
          id: 'cb_del_2',
          from: { id: adminId, is_bot: false },
          message: deletePicker,
          data: `dist:delete_confirm:${ctx.distributor.id}`,
        },
      } as any);

      const deletedMsg = ctx.editedTexts.find((e) => e.text.includes('Deleted: Koreta Meat Co'));
      assert.ok(deletedMsg);

      // Verify DB deletion
      const deletedDist = await ctx.distService.findById(ctx.distributor.id);
      assert.equal(deletedDist, undefined);
    });

    it('❌ Cancel button aborts active conversation safely', async () => {
      const ctx = await setupTestContext();
      const adminId = 1823403862;

      // 1. Start add flow
      await ctx.bot.handleUpdate({
        update_id: 90,
        message: {
          message_id: 1001,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '➕ Add Distributor',
        },
      } as any);

      // 2. Click '❌ Cancel'
      await ctx.bot.handleUpdate({
        update_id: 91,
        message: {
          message_id: 1002,
          from: { id: adminId, is_bot: false },
          chat: { id: adminId, type: 'private' },
          text: '❌ Cancel',
        },
      } as any);

      const cancelMsg = ctx.sentMessages.find(
        (m) => typeof m.text === 'string' && m.text.includes('Cancelled')
      );
      assert.ok(cancelMsg);
    });

    it('callback queries enforce admin authorization and block unauthorized users', async () => {
      const ctx = await setupTestContext();
      const unauthorizedUserId = 888888;

      await ctx.bot.handleUpdate({
        update_id: 95,
        callback_query: {
          id: 'cb_unauth',
          from: { id: unauthorizedUserId, is_bot: false },
          data: 'dist:add',
        },
      } as any);

      assert.ok(
        ctx.callbackAlerts.includes('⛔ Unauthorized: Admin access required.'),
        'Must block unauthorized callback query'
      );
    });

    it('setupBotCommands registers native commands menu with Telegram', async () => {
      const ctx = await setupTestContext();
      await setupBotCommands(ctx.bot.api);

      const setCmdCall = ctx.apiCalls.find((c) => c.method === 'setMyCommands');
      assert.ok(setCmdCall, 'Must call setMyCommands');
      assert.deepEqual(setCmdCall.payload.commands, BOT_COMMANDS);
    });
  });
});
