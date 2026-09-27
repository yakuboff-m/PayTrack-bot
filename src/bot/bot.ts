import { Bot } from 'grammy';
import type { Context } from 'grammy';
import { getConfig } from '../config/config';
import { DistributorRepository } from '../distributors/distributor.repository';
import { DistributorService } from '../distributors/distributor.service';
import { TransactionRepository } from '../transactions/transaction.repository';
import { TransactionService } from '../transactions/transaction.service';
import { registerHelpHandler } from './handlers/help.handler';
import { registerDistributorHandler } from './handlers/distributor.handler';
import { registerAmountHandler } from './handlers/amount.handler';
import { registerConfirmedHandler } from './handlers/confirmed.handler';
import { registerTransactionHandler } from './handlers/transaction.handler';

export function createBot(): { bot: Bot<Context>; start: () => Promise<void> } {
  const config = getConfig();
  const bot = new Bot<Context>(config.botToken);

  // ─── Services ──────────────────────────────────────────────

  const distributorRepo = new DistributorRepository();
  const distributorService = new DistributorService(distributorRepo);

  const transactionRepo = new TransactionRepository();
  const transactionService = new TransactionService(transactionRepo);

  // ─── Error handler ─────────────────────────────────────────

  bot.catch((err) => {
    console.error('Bot error:', err.error);
    console.error('Update that caused the error:', JSON.stringify(err.ctx.update, null, 2));
  });

  // ─── Register handlers (order matters!) ────────────────────

  // 1. Named commands first (these have the highest specificity)
  registerHelpHandler(bot);
  registerDistributorHandler(bot, distributorService);
  registerAmountHandler(bot, transactionService, distributorService);
  registerConfirmedHandler(bot, transactionService);

  // 2. Dynamic distributor alias commands + auto-registration last
  //    (these match broadly and use next() to pass through)
  registerTransactionHandler(bot, transactionService, distributorService, () => bot.botInfo.id);

  // ─── Start function ────────────────────────────────────────

  async function start(): Promise<void> {
    // Initialize bot info (needed for getBotId)
    await bot.init();
    console.log(`🤖 Bot started as @${bot.botInfo.username} (ID: ${bot.botInfo.id})`);

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
