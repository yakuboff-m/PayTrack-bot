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

const CONVERSATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Active conversation states for distributor add/edit flows.
 * Key: `${chatId}:${userId}`
 */
const conversations = new Map<ConversationKey, ConversationState>();

/** Clears expired conversation states. */
function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, state] of conversations) {
    if (now - state.startedAt > CONVERSATION_TIMEOUT_MS) {
      conversations.delete(key);
    }
  }
}

function formatDistributorDetail(dist: { name: string; alias: string; bankName: string; accountNumber: string; accountHolder: string }): string {
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
  distributorService: DistributorService
): void {
  // ─── /distributors ─ List all distributors ──────────────────

  bot.command('distributors', async (ctx) => {
    const distributors = distributorService.findAll();
    const userIsAdmin = ctx.from ? isAdmin(ctx.from.id) : false;

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

  bot.command('add_distributor', requireAdmin, async (ctx) => {
    const key = makeConversationKey(ctx.chat.id, ctx.from!.id);
    conversations.set(key, {
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

  bot.callbackQuery('dist:add', requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = makeConversationKey(ctx.chat!.id, ctx.from.id);
    conversations.set(key, {
      step: 'name',
      action: 'add',
      data: {},
      startedAt: Date.now(),
    });
    await ctx.reply('➕ *Add Distributor*\n\nEnter the distributor name:', {
      parse_mode: 'MarkdownV2',
    });
  });

  bot.callbackQuery('dist:edit_select', requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributors = distributorService.findAll();
    if (distributors.length === 0) {
      await ctx.reply('No distributors to edit.');
      return;
    }
    await ctx.reply('✏️ Select a distributor to edit:', {
      reply_markup: distributorSelectionKeyboard(distributors, 'dist:edit'),
    });
  });

  bot.callbackQuery('dist:delete_select', requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributors = distributorService.findAll();
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
    conversations.delete(key);
    try {
      await ctx.deleteMessage();
    } catch { /* ignore if can't delete */ }
  });

  // ─── Edit: select distributor → show field picker ──────────

  bot.callbackQuery(/^dist:edit:(\d+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const dist = distributorService.findById(distributorId);
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

  bot.callbackQuery(/^dist:edit_field:(\d+):(name|alias|bank|account|holder)$/, requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const field = ctx.match![2] as 'name' | 'alias' | 'bank' | 'account' | 'holder';
    const dist = distributorService.findById(distributorId);
    if (!dist) {
      await ctx.reply('❌ Distributor not found.');
      return;
    }

    const key = makeConversationKey(ctx.chat!.id, ctx.from.id);
    conversations.set(key, {
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

  bot.callbackQuery(/^dist:delete:(\d+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const dist = distributorService.findById(distributorId);
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

  bot.callbackQuery(/^dist:delete_confirm:(\d+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const distributorId = parseInt(ctx.match![1], 10);
    const dist = distributorService.findById(distributorId);
    if (!dist) {
      await ctx.reply('❌ Distributor not found.');
      return;
    }
    try {
      distributorService.delete(distributorId);
      await ctx.editMessageText(`✅ Deleted: ${dist.name}`);
    } catch (err: unknown) {
      await ctx.reply(`❌ Failed to delete: ${(err as Error).message}`);
    }
  });

  // ─── Conversation flow: handle text messages ────────────────

  bot.on('message:text', async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();

    cleanupExpired();
    const key = makeConversationKey(ctx.chat.id, ctx.from.id);
    const state = conversations.get(key);
    if (!state) return next();

    const text = ctx.message.text.trim();

    if (state.action === 'add') {
      await handleAddFlow(ctx, key, state, text, distributorService);
    } else if (state.action === 'edit') {
      await handleEditFlow(ctx, key, state, text, distributorService);
    }
    // Don't call next() — we consumed this message as part of the conversation
  });
}

async function handleAddFlow(
  ctx: Context,
  key: ConversationKey,
  state: ConversationState,
  text: string,
  service: DistributorService
): Promise<void> {
  switch (state.step) {
    case 'name':
      state.data.name = text;
      state.step = 'alias';
      await ctx.reply(`Name: ${text}\n\nEnter the command/alias (without /):`);
      break;

    case 'alias': {
      const alias = text.replace(/^\//, '').toLowerCase();
      if (!/^[a-z0-9_]+$/.test(alias)) {
        await ctx.reply('❌ Alias must contain only letters, numbers, and underscores.\nTry again:');
        return;
      }
      const existing = service.findByAlias(alias);
      if (existing) {
        await ctx.reply(`❌ Alias "/${alias}" is already used by "${existing.name}".\nEnter a different alias:`);
        return;
      }
      state.data.alias = alias;
      state.step = 'bank';
      await ctx.reply(`Alias: /${alias}\n\nEnter the bank name:`);
      break;
    }

    case 'bank':
      state.data.bankName = text;
      state.step = 'account';
      await ctx.reply(`Bank: ${text}\n\nEnter the account number:`);
      break;

    case 'account':
      state.data.accountNumber = text;
      state.step = 'holder';
      await ctx.reply(`Account: ${text}\n\nEnter the account holder name:`);
      break;

    case 'holder':
      state.data.accountHolder = text;
      state.step = 'confirm';
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
          const dist = service.create(state.data as CreateDistributorInput);
          conversations.delete(key);
          await ctx.reply(`✅ Created distributor: ${dist.name}\nCommand: /${dist.alias}`);
        } catch (err: unknown) {
          await ctx.reply(`❌ ${(err as Error).message}`);
        }
      } else if (text.toLowerCase() === 'cancel') {
        conversations.delete(key);
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
  service: DistributorService
): Promise<void> {
  if (!state.distributorId) {
    conversations.delete(key);
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
    conversations.delete(key);
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
    const updated = service.update(state.distributorId, update);
    conversations.delete(key);
    await ctx.reply(`✅ Updated ${field} for ${updated.name}.`);
  } catch (err: unknown) {
    await ctx.reply(`❌ ${(err as Error).message}`);
    conversations.delete(key);
  }
}

