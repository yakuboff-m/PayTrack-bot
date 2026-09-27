import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { Transaction } from '../../types';
import { TransactionService } from '../../transactions/transaction.service';
import { getConfig } from '../../config/config';
import { formatInvoiceId, parseInvoiceId } from '../helpers/format.helpers';

/**
 * Checks if a message represents the /confirmed command.
 * Checks both msg.text (plain text messages) and msg.caption (photo/document uploads).
 */
export function isConfirmedCommand(msg: Message): boolean {
  const text = (msg.text ?? msg.caption ?? '').trim();
  return /^\/confirmed(@\w+)?(\s|$)/i.test(text);
}

export function registerConfirmedHandler(
  bot: Composer<Context>,
  transactionService: TransactionService
): void {
  const config = getConfig();

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) return next();

    const isConfirmed = isConfirmedCommand(msg);

    // If not a /confirmed command, check if user uploaded receipt media as a reply without /confirmed
    // so we can give them an informative auto-deleting hint
    if (!isConfirmed) {
      if (msg.reply_to_message && ((msg.photo && msg.photo.length > 0) || msg.document)) {
        const senderId = ctx.from?.id;
        if (senderId && config.adminUserIds.includes(senderId)) {
          const chatId = String(ctx.chat.id);
          const repliedMsg = msg.reply_to_message;
          const targetTx = transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
          if (targetTx && targetTx.status === 'PENDING') {
            try {
              const hint = await ctx.reply(
                `💡 Receipt received! To confirm payment for ${formatInvoiceId(targetTx.id)}, add \`/confirmed\` in the caption or reply with \`/confirmed\`.`,
                { message_thread_id: msg.message_thread_id ?? config.pendingTopicId }
              );
              setTimeout(async () => {
                try {
                  await ctx.api.deleteMessage(ctx.chat.id, hint.message_id);
                } catch { /* ignore */ }
              }, 15_000);
            } catch { /* ignore */ }
          }
        }
      }
      return next();
    }

    // ── Check admin authorization ────────────────────────────
    const senderId = ctx.from?.id;
    if (!senderId || !config.adminUserIds.includes(senderId)) {
      await ctx.reply('⛔ You are not authorized to confirm transactions.', {
        message_thread_id: msg.message_thread_id ?? config.pendingTopicId,
      });
      return;
    }

    const threadId = msg.message_thread_id ?? config.pendingTopicId;
    const text = (msg.text ?? msg.caption ?? '').trim();
    const commandArg = text.replace(/^\/confirmed(@\w+)?\s*/i, '').trim();
    const explicitId = parseInvoiceId(commandArg);

    const chatId = String(ctx.chat.id);
    const repliedMsg = msg.reply_to_message;

    let transaction: Transaction | undefined;
    let invoiceMsg: Message | undefined;
    let paymentEvidenceMsg: Message | undefined =
      (msg.photo && msg.photo.length > 0) || msg.document ? msg : undefined;

    if (repliedMsg) {
      transaction = transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
      invoiceMsg = repliedMsg;

      const parentRepliedMsg = (repliedMsg as unknown as { reply_to_message?: Message }).reply_to_message;
      if (!transaction && parentRepliedMsg) {
        const parentTx = transactionService.findByAnyMessageId(chatId, parentRepliedMsg.message_id);
        if (parentTx) {
          transaction = parentTx;
          invoiceMsg = parentRepliedMsg;
          if (!paymentEvidenceMsg && ((repliedMsg.photo && repliedMsg.photo.length > 0) || repliedMsg.document)) {
            paymentEvidenceMsg = repliedMsg;
          }
        }
      }
    }

    // Fallback: If not found via reply, check if explicit invoice ID was provided (e.g. /confirmed #INV-0001)
    if (!transaction && explicitId) {
      transaction = transactionService.findById(explicitId);
    }

    if (!transaction) {
      await ctx.reply(
        '❌ Invalid confirmation.\n\n' +
        'Reply to the invoice with /confirmed (and optional receipt), or type /confirmed #INV-0001.',
        { message_thread_id: threadId },
      );
      return;
    }

    if (transaction.status !== 'PENDING') {
      await ctx.reply(`❌ Transaction ${formatInvoiceId(transaction.id)} has already been confirmed.`, {
        message_thread_id: threadId,
      });
      return;
    }

    // ── Delegate to service ─────────────────────────────────
    const commandMessageId = msg.message_id;

    const result = await transactionService.executeConfirmation(
      ctx.api,
      transaction,
      commandMessageId,
      invoiceMsg,
      paymentEvidenceMsg
    );

    if (result.success) {
      // Confirmation succeeded — send a brief confirmation that auto-deletes
      try {
        const successMsg = await ctx.reply(
          `✅ Transaction ${formatInvoiceId(transaction.id)} confirmed.\n🔗 ${result.confirmationUrl}`,
          { message_thread_id: threadId },
        );
        // Auto-delete the success message after 10 seconds
        setTimeout(async () => {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, successMsg.message_id);
          } catch { /* ignore */ }
        }, 10_000);
      } catch { /* ignore */ }
    } else {
      // Confirmation failed — originals are preserved
      await ctx.reply(
        `❌ Confirmation failed for ${formatInvoiceId(transaction.id)}.\n\n` +
        `The original transaction and payment message were not removed.\n` +
        `Please try again.\n\n` +
        `Error: ${result.error}`,
        { message_thread_id: threadId },
      );
    }
  });
}
