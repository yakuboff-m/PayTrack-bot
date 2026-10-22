import type { Composer, Context } from 'grammy';
import { DistributorService } from '../../distributors/distributor.service';
import { requireAdmin, isAdmin } from '../middleware/auth.middleware';
import {
  distributorListKeyboard,
  distributorSelectionKeyboard,
  deleteConfirmKeyboard,
  editFieldKeyboard,
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

export function registerDistributorHandler(
  bot: Composer<Context>,
  distributorService: DistributorService,
  conversationStore?: IConversationStore,
  customConfig?: Config
): void {
  const store = conversationStore ?? new MemoryConversationStore();

  // ─── /distributors ─ List all distributors ──────────────────

  bot.command('distributors', async (ctx) => {
    const distributors = await distributorService.findAll();
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

  bot.callbackQuery('dist:cancel', async (ctx) => {
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

  // ─── Conversation flow: handle text messages ────────────────

  bot.on('message:text', async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();

    const key = makeConversationKey(ctx.chat.id, ctx.from.id);
    const state = await store.get(key);
    if (!state) return next();

    const text = ctx.message.text.trim();

    if (state.action === 'add') {
      await handleAddFlow(ctx, key, state, text, distributorService, store);
    } else if (state.action === 'edit') {
      await handleEditFlow(ctx, key, state, text, distributorService, store);
    }
    // Don't call next() — we consumed this message as part of the conversation
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
      } else if (text.toLowerCase() === 'cancel') {
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
    await ctx.reply(`✅ Updated ${field} for ${updated.name}.`);
  } catch (err: unknown) {
    await ctx.reply(`❌ ${(err as Error).message}`);
    await store.delete(key);
  }
}
