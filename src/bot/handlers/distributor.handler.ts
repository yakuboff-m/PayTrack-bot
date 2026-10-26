import type { Composer, Context } from 'grammy';
import { DistributorService } from '../../distributors/distributor.service';
import { requireAdmin, isAdmin } from '../middleware/auth.middleware';
import {
  distributorListKeyboard,
  distributorSelectionKeyboard,
  deleteConfirmKeyboard,
  editFieldKeyboard,
  adminReplyKeyboard,
  adminInlineMenuKeyboard,
} from '../keyboards/keyboards';
import type {
  ConversationState,
  ConversationKey,
  CreateDistributorInput,
} from '../../types';
import { makeConversationKey } from '../../types';
import { IConversationStore, MemoryConversationStore } from '../../distributors/conversation.store';
import type { Config } from '../../config/config';

function formatDistributorDetail(dist: {
  name: string;
  alias: string;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
}): string {
  return [
    `🏢 *${escapeMarkdown(dist.name)}*`,
    `Command: /${escapeMarkdown(dist.alias)}`,
    `Bank: ${escapeMarkdown(dist.bankName)}`,
    `Account: \`${dist.accountNumber}\``,
    `Holder: ${escapeMarkdown(dist.accountHolder)}`,
  ].join('\n');
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function showDistributorsList(
  ctx: Context,
  service: DistributorService,
  customConfig?: Config
): Promise<void> {
  const distributors = await service.findAll();
  const userIsAdmin = ctx.from ? isAdmin(ctx.from.id, customConfig) : false;

  if (distributors.length === 0) {
    await ctx.reply('📋 No distributors found.', {
      reply_markup: distributorListKeyboard(userIsAdmin),
    });
    return;
  }

  const lines = ['🏢 *DISTRIBUTORS*\n'];
  distributors.forEach((d, i) => {
    lines.push(`${i + 1}\\. ${escapeMarkdown(d.name)} \\(\`/${d.alias}\`\\)`);
  });

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    reply_markup: distributorListKeyboard(userIsAdmin),
  });
}

export function registerDistributorHandler(
  bot: Composer<Context>,
  distributorService: DistributorService,
  conversationStore?: IConversationStore,
  customConfig?: Config
): void {
  const store = conversationStore ?? new MemoryConversationStore();

  // ─── /menu ─ Admin interactive menu ──────────────────────────

  bot.command('menu', requireAdmin(customConfig), async (ctx) => {
    await ctx.reply(
      '🏢 *Distributor Management Menu*\n\nSelect an option below to manage distributors:',
      {
        parse_mode: 'MarkdownV2',
        reply_markup: adminReplyKeyboard(),
      }
    );
  });

  // ─── /cancel ─ Cancel ongoing conversation / action ─────────

  bot.command('cancel', async (ctx) => {
    if (!ctx.from || !ctx.chat) return;
    const key = makeConversationKey(ctx.chat.id, ctx.from.id);
    await store.delete(key);
    await ctx.reply('❌ Cancelled.');
  });

  // ─── /distributors ─ List all distributors ──────────────────

  bot.command('distributors', async (ctx) => {
    await showDistributorsList(ctx, distributorService, customConfig);
  });

  // ─── /add_distributor ─ Start add flow ──────────────────────

  bot.command('add_distributor', requireAdmin(customConfig), async (ctx) => {
    const key = makeConversationKey(ctx.chat.id, ctx.from!.id);
    await store.set(key, {
      step: 'name',
      action: 'add',
      data: {},
      startedAt: Date.now(),
    });
    await ctx.reply('➕ *Add Distributor*\n\nEnter the distributor name:', {
      parse_mode: 'MarkdownV2',
    });
  });

  // ─── Callback queries for distributor management ────────────

  bot.callbackQuery('dist:list', requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDistributorsList(ctx, distributorService, customConfig);
  });

  bot.callbackQuery('dist:add', requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = makeConversationKey(ctx.chat!.id, ctx.from.id);
    await store.set(key, {
      step: 'name',
      action: 'add',
      data: {},
      startedAt: Date.now(),
    });
    await ctx.reply('➕ *Add Distributor*\n\nEnter the distributor name:', {
      parse_mode: 'MarkdownV2',
    });
  });

  bot.callbackQuery('dist:edit_select', requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributors = await distributorService.findAll();
    if (distributors.length === 0) {
      await ctx.reply('No distributors to edit.');
      return;
    }
    await ctx.reply('✏️ Select a distributor to edit:', {
      reply_markup: distributorSelectionKeyboard(distributors, 'dist:edit'),
    });
  });

  bot.callbackQuery('dist:delete_select', requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributors = await distributorService.findAll();
    if (distributors.length === 0) {
      await ctx.reply('No distributors to delete.');
      return;
    }
    await ctx.reply('🗑 Select a distributor to delete:', {
      reply_markup: distributorSelectionKeyboard(distributors, 'dist:delete'),
    });
  });

  bot.callbackQuery('dist:cancel', requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery('Cancelled');
    const key = makeConversationKey(ctx.chat!.id, ctx.from.id);
    await store.delete(key);
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore if can't delete */
    }
  });

  // ─── Edit: select distributor → show field picker ──────────

  bot.callbackQuery(/^dist:edit:(\d+)$/, requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const dist = await distributorService.findById(distributorId);
    if (!dist) {
      await ctx.reply('❌ Distributor not found.');
      return;
    }
    await ctx.editMessageText(
      `✏️ Editing: ${dist.name}\n\nSelect a field to edit:`,
      { reply_markup: editFieldKeyboard(distributorId) }
    );
  });

  // ─── Edit: pick a field → start conversation for that field ─

  bot.callbackQuery(/^dist:edit_field:(\d+):(name|alias|bank|account|holder)$/, requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const field = ctx.match![2] as 'name' | 'alias' | 'bank' | 'account' | 'holder';
    const dist = await distributorService.findById(distributorId);
    if (!dist) {
      await ctx.reply('❌ Distributor not found.');
      return;
    }

    const key = makeConversationKey(ctx.chat!.id, ctx.from.id);
    await store.set(key, {
      step: field,
      action: 'edit',
      distributorId,
      data: {},
      startedAt: Date.now(),
    });

    const fieldLabels: Record<string, string> = {
      name: 'name',
      alias: 'command/alias (without /)',
      bank: 'bank name',
      account: 'account number',
      holder: 'account holder',
    };
    await ctx.reply(`Enter the new ${fieldLabels[field]} for ${dist.name}:`);
  });

  // ─── Delete: select distributor → confirm ──────────────────

  bot.callbackQuery(/^dist:delete:(\d+)$/, requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const dist = await distributorService.findById(distributorId);
    if (!dist) {
      await ctx.reply('❌ Distributor not found.');
      return;
    }
    await ctx.editMessageText(
      `⚠️ Delete ${dist.name}?\n\nThis will not affect historical transaction records.`,
      { reply_markup: deleteConfirmKeyboard(distributorId) }
    );
  });

  // ─── Delete: confirmed ─────────────────────────────────────

  bot.callbackQuery(/^dist:delete_confirm:(\d+)$/, requireAdmin(customConfig), async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const dist = await distributorService.findById(distributorId);
    if (!dist) {
      await ctx.reply('❌ Distributor not found.');
      return;
    }
    try {
      await distributorService.delete(distributorId);
      await ctx.editMessageText(`✅ Deleted: ${dist.name}`);
    } catch (err: unknown) {
      await ctx.reply(`❌ Failed to delete: ${(err as Error).message}`);
    }
  });

  // ─── Conversation flow: handle text messages and reply buttons ──

  bot.on('message:text', async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();

    const text = ctx.message.text.trim();

    // 0. Command /menu
    if (text === '/menu' || text.startsWith('/menu@') || text.startsWith('/menu ')) {
      if (!isAdmin(ctx.from.id, customConfig)) return;
      await ctx.reply(
        '🏢 *Distributor Management Menu*\n\nSelect an option below to manage distributors:',
        {
          parse_mode: 'MarkdownV2',
          reply_markup: adminReplyKeyboard(),
        }
      );
      return;
    }

    // 1. Reply keyboard button: 🏢 Distributors
    if (text === '🏢 Distributors') {
      if (!isAdmin(ctx.from.id, customConfig)) return next();
      await showDistributorsList(ctx, distributorService, customConfig);
      return;
    }

    // 2. Reply keyboard button: ➕ Add Distributor
    if (text === '➕ Add Distributor') {
      if (!isAdmin(ctx.from.id, customConfig)) return next();
      const key = makeConversationKey(ctx.chat.id, ctx.from.id);
      await store.set(key, {
        step: 'name',
        action: 'add',
        data: {},
        startedAt: Date.now(),
      });
      await ctx.reply('➕ *Add Distributor*\n\nEnter the distributor name:', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    // 3. Reply keyboard button: ✏️ Edit Distributor
    if (text === '✏️ Edit Distributor') {
      if (!isAdmin(ctx.from.id, customConfig)) return next();
      const distributors = await distributorService.findAll();
      if (distributors.length === 0) {
        await ctx.reply('No distributors to edit.');
        return;
      }
      await ctx.reply('✏️ Select a distributor to edit:', {
        reply_markup: distributorSelectionKeyboard(distributors, 'dist:edit'),
      });
      return;
    }

    // 4. Reply keyboard button: 🗑️ Delete Distributor
    if (text === '🗑️ Delete Distributor' || text === '🗑 Delete Distributor') {
      if (!isAdmin(ctx.from.id, customConfig)) return next();
      const distributors = await distributorService.findAll();
      if (distributors.length === 0) {
        await ctx.reply('No distributors to delete.');
        return;
      }
      await ctx.reply('🗑 Select a distributor to delete:', {
        reply_markup: distributorSelectionKeyboard(distributors, 'dist:delete'),
      });
      return;
    }

    // 5. Reply keyboard button / command: ❌ Cancel
    if (text === '❌ Cancel' || text.toLowerCase() === 'cancel' || text === '/cancel') {
      const key = makeConversationKey(ctx.chat.id, ctx.from.id);
      const state = await store.get(key);
      if (state) {
        await store.delete(key);
        await ctx.reply('❌ Cancelled.');
        return;
      }
      if (isAdmin(ctx.from.id, customConfig)) {
        await ctx.reply('❌ Action cancelled.');
        return;
      }
      return next();
    }

    // Active conversation check
    const key = makeConversationKey(ctx.chat.id, ctx.from.id);
    const state = await store.get(key);
    if (!state) return next();

    // Expire conversations older than 5 minutes
    if (Date.now() - state.startedAt > 300_000) {
      await store.delete(key);
      await ctx.reply('⚠️ Conversation expired. Please start again from the menu or /distributors.');
      return;
    }

    if (state.action === 'add') {
      await handleAddFlow(ctx, key, state, text, distributorService, store);
    } else if (state.action === 'edit') {
      await handleEditFlow(ctx, key, state, text, distributorService, store);
    }
    // Don't call next() — message was consumed by the active conversation
  });
}

async function handleAddFlow(
  ctx: Context,
  key: ConversationKey,
  state: ConversationState,
  text: string,
  service: DistributorService,
  store: IConversationStore
): Promise<void> {
  // Support cancellation during add conversation
  if (text.toLowerCase() === 'cancel' || text === '❌ Cancel' || text === '/cancel') {
    await store.delete(key);
    await ctx.reply('❌ Cancelled.');
    return;
  }

  switch (state.step) {
    case 'name':
      state.data.name = text;
      state.step = 'alias';
      await store.set(key, state);
      await ctx.reply(`Name: ${text}\n\nEnter the command/alias (without /):`);
      break;

    case 'alias': {
      const alias = text.replace(/^\//, '').toLowerCase();
      if (!/^[a-z0-9_]+$/.test(alias)) {
        await ctx.reply('❌ Alias must contain only letters, numbers, and underscores.\nTry again:');
        return;
      }
      const existing = await service.findByAlias(alias);
      if (existing) {
        await ctx.reply(`❌ Alias "/${alias}" is already used by "${existing.name}".\nEnter a different alias:`);
        return;
      }
      state.data.alias = alias;
      state.step = 'bank';
      await store.set(key, state);
      await ctx.reply(`Alias: /${alias}\n\nEnter the bank name:`);
      break;
    }

    case 'bank':
      state.data.bankName = text;
      state.step = 'account';
      await store.set(key, state);
      await ctx.reply(`Bank: ${text}\n\nEnter the account number:`);
      break;

    case 'account':
      state.data.accountNumber = text;
      state.step = 'holder';
      await store.set(key, state);
      await ctx.reply(`Account: ${text}\n\nEnter the account holder name:`);
      break;

    case 'holder':
      state.data.accountHolder = text;
      state.step = 'confirm';
      await store.set(key, state);
      {
        const d = state.data;
        const summary = [
          '📋 *Confirm new distributor:*\n',
          `Name: ${escapeMarkdown(d.name!)}`,
          `Command: /${escapeMarkdown(d.alias!)}`,
          `Bank: ${escapeMarkdown(d.bankName!)}`,
          `Account: \`${d.accountNumber}\``,
          `Holder: ${escapeMarkdown(d.accountHolder!)}`,
          '\nType *yes* to confirm or *cancel* to abort\\.',
        ];
        await ctx.reply(summary.join('\n'), { parse_mode: 'MarkdownV2' });
      }
      break;

    case 'confirm':
      if (text.toLowerCase() === 'yes') {
        try {
          const dist = await service.create(state.data as CreateDistributorInput);
          await store.delete(key);
          await ctx.reply(`✅ Created distributor: ${dist.name}\nCommand: /${dist.alias}`);
        } catch (err: unknown) {
          await ctx.reply(`❌ ${(err as Error).message}`);
        }
      } else if (text.toLowerCase() === 'cancel' || text === '❌ Cancel' || text === '/cancel') {
        await store.delete(key);
        await ctx.reply('❌ Cancelled.');
      } else {
        await ctx.reply('Type *yes* to confirm or *cancel* to abort\\.', {
          parse_mode: 'MarkdownV2',
        });
      }
      break;
  }
}

async function handleEditFlow(
  ctx: Context,
  key: ConversationKey,
  state: ConversationState,
  text: string,
  service: DistributorService,
  store: IConversationStore
): Promise<void> {
  // Support cancellation during edit conversation
  if (text.toLowerCase() === 'cancel' || text === '❌ Cancel' || text === '/cancel') {
    await store.delete(key);
    await ctx.reply('❌ Cancelled.');
    return;
  }

  if (!state.distributorId) {
    await store.delete(key);
    return;
  }

  const field = state.step;
  const updateMap: Record<string, Record<string, string>> = {
    name: { name: text },
    alias: { alias: text.replace(/^\//, '').toLowerCase() },
    bank: { bankName: text },
    account: { accountNumber: text },
    holder: { accountHolder: text },
  };

  const update = updateMap[field];
  if (!update) {
    await store.delete(key);
    return;
  }

  // Validate alias format if editing alias
  if (field === 'alias') {
    const alias = update.alias;
    if (!/^[a-z0-9_]+$/.test(alias)) {
      await ctx.reply('❌ Alias must contain only letters, numbers, and underscores.\nTry again:');
      return;
    }
  }

  try {
    const updated = await service.update(state.distributorId, update);
    await store.delete(key);
    const detail = formatDistributorDetail(updated);
    await ctx.reply(
      `✅ Updated ${field} for *${escapeMarkdown(updated.name)}*\\.\n\n${detail}`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err: unknown) {
    await ctx.reply(`❌ ${(err as Error).message}`);
    await store.delete(key);
  }
}
