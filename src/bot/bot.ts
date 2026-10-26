import { Bot } from 'grammy';
import type { Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { getConfig, getBotIdFromToken, type Config } from '../config/config';
import { DistributorRepository } from '../distributors/distributor.repository';
import { DistributorService } from '../distributors/distributor.service';
import { TransactionRepository } from '../transactions/transaction.repository';
import { TransactionService } from '../transactions/transaction.service';
import { registerHelpHandler } from './handlers/help.handler';
import { registerDistributorHandler } from './handlers/distributor.handler';
import { registerAmountHandler } from './handlers/amount.handler';
import { registerConfirmedHandler } from './handlers/confirmed.handler';
import { registerNoteHandler } from './handlers/note.handler';
import { registerEditHandler } from './handlers/edit.handler';
import { registerTransactionHandler } from './handlers/transaction.handler';
import { globalMessageTracker } from './helpers/message-tracker';
import type { IDatabase } from '../database/adapter';
import type { IConversationStore } from '../distributors/conversation.store';

export interface CreateBotOptions {
  config?: Config;
  db?: IDatabase;
  conversationStore?: IConversationStore;
  executionContext?: ExecutionContext;
}

export function createBot(options?: CreateBotOptions): {
  bot: Bot<Context>;
  start: () => Promise<void>;
} {
  const config = options?.config ?? getConfig();
  const botId = getBotIdFromToken(config.botToken);

  const bot = new Bot<Context>(config.botToken, {
    botInfo: {
      id: botId,
      is_bot: true,
      first_name: 'PayTrack Bot',
      username: 'paytrack_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as UserFromGetMe,
  });

  // ─── Services ──────────────────────────────────────────────

  const distributorRepo = new DistributorRepository(options?.db);
  const distributorService = new DistributorService(distributorRepo);

  const transactionRepo = new TransactionRepository(options?.db);
  const transactionService = new TransactionService(transactionRepo, config);

  // ─── Error handler ─────────────────────────────────────────

  if (options?.executionContext) {
    bot.use(async (ctx, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx as any).executionContext = options.executionContext;
      await next();
    });
  }

  // Track incoming messages for /edit and other reply-based workflows
  bot.use(async (ctx, next) => {
    if (ctx.message) {
      globalMessageTracker.record(ctx.message);
    }
    await next();
  });

  bot.catch((err) => {
    console.error('Bot error:', err.error);
    console.error('Update that caused the error:', JSON.stringify(err.ctx.update, null, 2));
  });

  // ─── Register handlers (order matters!) ────────────────────

  // 1. Named commands first (these have the highest specificity)
  registerHelpHandler(bot);
  registerDistributorHandler(bot, distributorService, options?.conversationStore, config);
  registerAmountHandler(bot, transactionService, distributorService, config);
  registerConfirmedHandler(bot, transactionService, config);
  registerNoteHandler(bot, transactionService, config);
  registerEditHandler(bot, transactionRepo, config);

  // 2. Dynamic distributor alias commands + auto-registration last
  //    (these match broadly and use next() to pass through)
  registerTransactionHandler(bot, transactionService, distributorService, () => botId, config);

  // ─── Start function ────────────────────────────────────────

  async function start(): Promise<void> {
    // Initialize bot info (needed for getBotId if not provided upfront)
    await bot.init();
    console.log(`🤖 Bot started as @${bot.botInfo.username} (ID: ${bot.botInfo.id})`);

    // Register native bot commands menu with Telegram
    await setupBotCommands(bot.api);

    // Start long polling
    await bot.start({
      onStart: () => {
        console.log('📡 Long polling started');
      },
      allowed_updates: ['message', 'callback_query'],
    });
  }

  return { bot, start };
}

export const BOT_COMMANDS = [
  { command: 'menu', description: 'Distributor management menu' },
  { command: 'distributors', description: 'List registered distributors' },
  { command: 'add_distributor', description: 'Add a new distributor' },
  { command: 'amount', description: 'Set or update invoice amount' },
  { command: 'add', description: 'Add amount or media to invoice' },
  { command: 'note', description: 'Add note to invoice' },
  { command: 'paid', description: 'Record payment / confirm invoice' },
  { command: 'edit', description: 'Edit a message' },
  { command: 'cancel', description: 'Cancel current action' },
  { command: 'help', description: 'Show bot usage instructions' },
];

export async function setupBotCommands(api: any): Promise<void> {
  try {
    await api.setMyCommands(BOT_COMMANDS);
  } catch (err: unknown) {
    console.warn('Failed to register bot commands with Telegram:', (err as Error).message);
  }
}

