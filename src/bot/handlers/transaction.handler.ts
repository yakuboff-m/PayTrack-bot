import type { Composer, Context } from 'grammy';
import { getConfig } from '../../config/config';
import { TransactionService } from '../../transactions/transaction.service';
import { DistributorService } from '../../distributors/distributor.service';
import { requireAdmin } from '../middleware/auth.middleware';
import { copyAccountKeyboard } from '../keyboards/keyboards';
import { parseAmount } from '../helpers/format.helpers';
import {
  isFromBot,
  isCommand,
  isReply,
} from '../helpers/telegram.helpers';

export function registerTransactionHandler(
  bot: Composer<Context>,
  transactionService: TransactionService,
  distributorService: DistributorService,
  getBotId: () => number
): void {
  const config = getConfig();

  // ─── Auto-registration of new transactions ───────────────

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;

    // Only process messages in the Pending topic
    if (msg.message_thread_id !== config.pendingTopicId) return next();
    if (ctx.chat.id !== config.telegramGroupId) return next();

    // Skip bot messages
    if (isFromBot(msg)) return next();

    // Skip the bot's own messages
    if (msg.from?.id === getBotId()) return next();

    // Skip command messages
    if (isCommand(msg)) return next();

    // Skip replies (these are annotations/payments, not new invoices)
    if (isReply(msg)) return next();

    // Register the transaction
    const chatId = String(ctx.chat.id);
    try {
      transactionService.registerTransaction(chatId, config.pendingTopicId, msg.message_id);
      console.log(`📝 Auto-registered transaction: message ${msg.message_id}`);
    } catch (err: unknown) {
      console.warn('Auto-registration skipped:', (err as Error).message);
    }

    return next();
  });

  // ─── Dynamic distributor alias commands ──────────────────

  // Matches: /abc  or  /abc 280700  or  /abc 280,700
  // The optional second part is the amount.

  bot.on('message:text', requireAdmin, async (ctx, next) => {
    const msg = ctx.message;
    const text = msg.text.trim();

    // Match /alias or /alias <amount>
    const match = text.match(/^\/([a-z0-9_]+)(?:\s+(.+))?$/i);
    if (!match) return next();

    const alias = match[1].toLowerCase();
    const rawAmount = match[2]?.trim() || null;

    // Skip known framework commands
    const reservedCommands = ['help', 'distributors', 'add_distributor', 'amount', 'confirmed', 'start'];
    if (reservedCommands.includes(alias)) return next();

    // Look up distributor by alias
    const distributor = distributorService.findByAlias(alias);
    if (!distributor) return next();

    // Must be a reply to a message
    if (!msg.reply_to_message) {
      await ctx.reply(
        `❌ Reply to a transaction message with /${alias} to assign this distributor.`,
        { message_thread_id: msg.message_thread_id },
      );
      return;
    }

    const repliedMsg = msg.reply_to_message;
    const chatId = String(ctx.chat.id);

    // Find transaction (check both original and bot message IDs)
    let transaction = transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
    if (!transaction) {
      try {
        transaction = transactionService.registerTransaction(
          chatId, config.pendingTopicId, repliedMsg.message_id
        );
      } catch {
        await ctx.reply('❌ Could not find or register this transaction.', {
          message_thread_id: msg.message_thread_id,
        });
        return;
      }
    }

    if (transaction.status !== 'PENDING') {
      await ctx.reply('❌ This transaction has already been confirmed.', {
        message_thread_id: msg.message_thread_id,
      });
      return;
    }

    // Assign distributor
    const snapshot = distributorService.createSnapshot(distributor);
    transactionService.assignDistributor(transaction.id, distributor.id, snapshot);

    // If amount was provided inline (e.g., /abc 280700), set it too
    let amount = transaction.amount;
    if (rawAmount) {
      const parsed = parseAmount(rawAmount);
      if (parsed !== null) {
        transactionService.setAmount(transaction.id, parsed);
        amount = parsed;
      }
      // If parsing fails, silently ignore — distributor is still assigned
    }

    // Reload to get final state
    const updated = transactionService.findByAnyMessageId(chatId, repliedMsg.message_id)!;

    // Build keyboard with copy button
    const kb = copyAccountKeyboard(distributor.accountNumber);

    // Re-send as bot-owned message (or edit if already bot-owned)
    const result = await transactionService.updateTransactionDisplay(
      ctx.api,
      ctx.chat.id,
      config.pendingTopicId,
      repliedMsg,
      updated,
      snapshot,
      updated.amount,
      kb,
    );

    if ('error' in result) {
      await ctx.reply(`❌ ${result.error}`, {
        message_thread_id: msg.message_thread_id,
      });
      return;
    }

    // Delete the command message
    try {
      await ctx.deleteMessage();
    } catch { /* ignore */ }
  });
}
