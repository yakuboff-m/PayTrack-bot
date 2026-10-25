import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { TransactionService } from '../../transactions/transaction.service';
import { DistributorService } from '../../distributors/distributor.service';
import { requireAdmin } from '../middleware/auth.middleware';
import { getConfig, type Config } from '../../config/config';
import { parseAmount, formatAmount, formatInvoiceId } from '../helpers/format.helpers';
import { copyAccountKeyboard } from '../keyboards/keyboards';
import { getEffectiveRepliedMessage } from '../helpers/telegram.helpers';
import { parseMeatInvoice } from '../../transactions/meat-invoice';

/**
 * Checks if a message represents the /amount command (text or caption).
 */
export function isAmountCommand(msg: Message): boolean {
  const text = (msg.text ?? msg.caption ?? '').trim();
  return /^\/amount(@\w+)?(\s|$)/i.test(text);
}

/**
 * Checks if a message represents the /add command (text or caption).
 */
export function isAddCommand(msg: Message): boolean {
  const text = (msg.text ?? msg.caption ?? '').trim();
  return /^\/add(@\w+)?(\s|$)/i.test(text);
}

export function registerAmountHandler(
  bot: Composer<Context>,
  transactionService: TransactionService,
  distributorService: DistributorService,
  customConfig?: Config
): void {
  const config = customConfig ?? getConfig();

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) return next();

    const isAmount = isAmountCommand(msg);
    const isAdd = isAddCommand(msg);

    if (!isAmount && !isAdd) {
      return next();
    }

    return requireAdmin(customConfig)(ctx, async () => {
      const threadId = msg.message_thread_id ?? config.pendingTopicId;
      const repliedMsg = getEffectiveRepliedMessage(msg);
      const rawFullText = (msg.text ?? msg.caption ?? '').trim();

      // ─── 1. /amount: Set transaction amount ─────────────────
      if (isAmount) {
        if (!repliedMsg) {
          await ctx.reply(
            '❌ Reply to a transaction message with the amount.\n\nExample:\n/amount 280,700',
            { message_thread_id: threadId }
          );
          return;
        }

        const rawAmount = rawFullText.replace(/^\/amount(@\w+)?\s*/i, '').trim();
        if (!rawAmount) {
          await ctx.reply('❌ Invalid amount.\n\nExample:\n/amount 280,700', {
            message_thread_id: threadId,
          });
          return;
        }

        const match = rawAmount.match(/^([₩\d,]+)(?:\s+([\s\S]*))?$/);
        const amountToken = match ? match[1] : rawAmount;
        const optionalNote = match && match[2] ? match[2].trim() : undefined;

        let amount = parseAmount(amountToken);
        if (amount === null) {
          const parsedMeat = parseMeatInvoice(rawAmount);
          if (parsedMeat.success && parsedMeat.invoice) {
            amount = parsedMeat.invoice.grandTotal;
          }
        }

        if (amount === null || amount <= 0) {
          await ctx.reply('❌ Invalid amount.\n\nExample:\n/amount 280,700', {
            message_thread_id: threadId,
          });
          return;
        }

        const chatId = String(ctx.chat.id);
        let transaction = await transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
        if (!transaction) {
          try {
            transaction = await transactionService.registerTransaction(
              chatId,
              config.pendingTopicId,
              repliedMsg.message_id
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

        await transactionService.setAmount(transaction.id, amount);
        const updated = (await transactionService.findByAnyMessageId(chatId, repliedMsg.message_id))!;

        const keyboard = updated.distributorSnapshot
          ? copyAccountKeyboard(updated.distributorSnapshot.accountNumber)
          : undefined;

        const result = await transactionService.updateTransactionDisplay(
          ctx.api,
          ctx.chat.id,
          config.pendingTopicId,
          repliedMsg,
          updated,
          updated.distributorSnapshot,
          updated.amount,
          keyboard
        );

        if ('error' in result) {
          await ctx.reply(`❌ ${result.error}`, { message_thread_id: threadId });
          return;
        }

        if (!msg.photo && !msg.document) {
          try {
            await ctx.deleteMessage();
          } catch {
            /* ignore */
          }
        }
        return;
      }

      // ─── 2. /add: Add to existing transaction amount ────────
      if (isAdd) {
        if (!repliedMsg) {
          await ctx.reply(
            '❌ Reply to a transaction message with the amount to add.\n\nExample:\n/add 50,000',
            { message_thread_id: threadId }
          );
          return;
        }

        const rawAmount = rawFullText.replace(/^\/add(@\w+)?\s*/i, '').trim();
        if (!rawAmount) {
          await ctx.reply('❌ Invalid amount.\n\nExample:\n/add 50,000', {
            message_thread_id: threadId,
          });
          return;
        }

        const match = rawAmount.match(/^([₩\d,]+)(?:\s+([\s\S]*))?$/);
        const amountToken = match ? match[1] : rawAmount;
        const optionalNote = match && match[2] ? match[2].trim() : undefined;

        let addedAmount = parseAmount(amountToken);
        if (addedAmount === null) {
          const parsedMeat = parseMeatInvoice(rawAmount);
          if (parsedMeat.success && parsedMeat.invoice) {
            addedAmount = parsedMeat.invoice.grandTotal;
          }
        }

        if (addedAmount === null || addedAmount <= 0) {
          await ctx.reply('❌ Invalid amount.\n\nExample:\n/add 50,000', {
            message_thread_id: threadId,
          });
          return;
        }

        const chatId = String(ctx.chat.id);
        let transaction = await transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
        if (!transaction) {
          try {
            transaction = await transactionService.registerTransaction(
              chatId,
              config.pendingTopicId,
              repliedMsg.message_id
            );
          } catch {
            await ctx.reply('❌ Could not find or register this transaction.', {
              message_thread_id: threadId,
            });
            return;
          }
        }

        if (transaction.status === 'PAID') {
          await ctx.reply('❌ This transaction has already been paid in full.', {
            message_thread_id: threadId,
          });
          return;
        }

        const result = await transactionService.executeAddAmount({
          api: ctx.api,
          chatId: ctx.chat.id,
          pendingTopicId: config.pendingTopicId,
          repliedMessage: repliedMsg,
          addMessage: msg,
          transaction,
          addedAmount,
          optionalNote,
        });

        if (!result.success) {
          await ctx.reply(`❌ ${result.error}`, { message_thread_id: threadId });
          return;
        }

        return;
      }
    });
  });
}
