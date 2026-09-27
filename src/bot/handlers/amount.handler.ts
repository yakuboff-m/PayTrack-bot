import type { Composer, Context } from 'grammy';
import { TransactionService } from '../../transactions/transaction.service';
import { DistributorService } from '../../distributors/distributor.service';
import { requireAdmin } from '../middleware/auth.middleware';
import { getConfig } from '../../config/config';
import { parseAmount, formatAmount } from '../helpers/format.helpers';
import { copyAccountKeyboard } from '../keyboards/keyboards';

export function registerAmountHandler(
  bot: Composer<Context>,
  transactionService: TransactionService,
  distributorService: DistributorService
): void {
  const config = getConfig();

  bot.command('amount', requireAdmin, async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;

    const threadId = msg.message_thread_id ?? config.pendingTopicId;

    // Must be a reply to a transaction message
    if (!msg.reply_to_message) {
      await ctx.reply(
        '❌ Reply to a transaction message with the amount.\n\nExample:\n/amount 280,700',
        { message_thread_id: threadId },
      );
      return;
    }

    // Parse the amount
    const rawAmount = msg.text?.replace(/^\/amount\s*/i, '').trim();
    if (!rawAmount) {
      await ctx.reply('❌ Invalid amount.\n\nExample:\n/amount 280,700', {
        message_thread_id: threadId,
      });
      return;
    }

    const amount = parseAmount(rawAmount);
    if (amount === null) {
      await ctx.reply('❌ Invalid amount.\n\nExample:\n/amount 280,700', {
        message_thread_id: threadId,
      });
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
          message_thread_id: threadId,
        });
        return;
      }
    }

    if (transaction.status !== 'PENDING') {
      await ctx.reply('❌ This transaction has already been confirmed.', {
        message_thread_id: threadId,
      });
      return;
    }

    // Store the amount
    transactionService.setAmount(transaction.id, amount);

    // Reload
    const updated = transactionService.findByAnyMessageId(chatId, repliedMsg.message_id)!;

    // Build keyboard if distributor is assigned
    const keyboard = updated.distributorSnapshot
      ? copyAccountKeyboard(updated.distributorSnapshot.accountNumber)
      : undefined;

    // Update the bot's message (or re-send if not bot-owned yet)
    const result = await transactionService.updateTransactionDisplay(
      ctx.api,
      ctx.chat.id,
      config.pendingTopicId,
      repliedMsg,
      updated,
      updated.distributorSnapshot,
      updated.amount,
      keyboard,
    );

    if ('error' in result) {
      await ctx.reply(`❌ ${result.error}`, { message_thread_id: threadId });
      return;
    }

    // Delete the /amount command message
    try {
      await ctx.deleteMessage();
    } catch { /* ignore */ }
  });
}
