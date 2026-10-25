import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { Transaction } from '../../types';
import { TransactionService } from '../../transactions/transaction.service';
import { getConfig, type Config } from '../../config/config';
import {
  formatInvoiceId,
  parseInvoiceId,
  extractInvoiceIdFromText,
  parseInvoiceMetadataFromText,
  parsePaidCommandPayload,
} from '../helpers/format.helpers';
import { getEffectiveRepliedMessage, isCommand } from '../helpers/telegram.helpers';

/**
 * Checks if a message represents the /paid (or /confirmed) command.
 * Checks both msg.text (plain text messages) and msg.caption (photo/document uploads).
 */
export function isPaidCommand(msg: Message): boolean {
  const text = (msg.text ?? msg.caption ?? '').trim();
  return /^\/(paid|confirmed)(@\w+)?(\s|$)/i.test(text);
}

// Backward-compatibility export
export const isConfirmedCommand = isPaidCommand;

function scheduleDelete(ctx: Context, chatId: number, messageId: number, delayMs: number): void {
  const deleteTask = async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch {
      /* ignore */
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyCtx = ctx as any;
  const executionContext = anyCtx.executionContext;
  if (executionContext && typeof executionContext.waitUntil === 'function') {
    executionContext.waitUntil(deleteTask());
  } else if (typeof anyCtx.waitUntil === 'function') {
    anyCtx.waitUntil(deleteTask());
  } else {
    setTimeout(deleteTask, delayMs);
  }
}

export function registerConfirmedHandler(
  bot: Composer<Context>,
  transactionService: TransactionService,
  customConfig?: Config
): void {
  const config = customConfig ?? getConfig();

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) return next();

    const isPaid = isPaidCommand(msg);

    // If not a /paid command, check if user uploaded receipt media as a reply without /paid
    // so we can give them an informative auto-deleting hint
    if (!isPaid) {
      // If the message is ANY command (starts with /), DO NOT treat it as a receipt! Pass to next()!
      if (isCommand(msg)) {
        return next();
      }

      const repliedMediaMsg = getEffectiveRepliedMessage(msg);
      if (repliedMediaMsg && ((msg.photo && msg.photo.length > 0) || msg.document)) {
        const senderId = ctx.from?.id;
        if (senderId && config.adminUserIds.includes(senderId)) {
          const chatId = String(ctx.chat.id);
          const targetTx = await transactionService.findByAnyMessageId(chatId, repliedMediaMsg.message_id);
          if (targetTx && targetTx.status !== 'PAID') {
            try {
              const hint = await ctx.reply(
                `💡 Receipt received! To mark payment for ${formatInvoiceId(targetTx.id)}, add \`/paid\` in the caption or reply with \`/paid\`.`,
                { message_thread_id: msg.message_thread_id ?? config.pendingTopicId }
              );
              scheduleDelete(ctx, ctx.chat.id, hint.message_id, 15_000);
            } catch {
              /* ignore */
            }
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
    const { explicitInvoiceId: explicitId, paymentAmount, userNote } = parsePaidCommandPayload(text);

    const chatId = String(ctx.chat.id);
    const repliedMsg = getEffectiveRepliedMessage(msg);

    let transaction: Transaction | undefined;
    let invoiceMsg: Message | undefined;
    let paymentEvidenceMsg: Message | undefined =
      (msg.photo && msg.photo.length > 0) || msg.document ? msg : undefined;

    if (repliedMsg) {
      transaction = await transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
      invoiceMsg = repliedMsg;

      const parentRepliedMsg = getEffectiveRepliedMessage(repliedMsg);
      if (!transaction && parentRepliedMsg) {
        const parentTx = await transactionService.findByAnyMessageId(chatId, parentRepliedMsg.message_id);
        if (parentTx) {
          transaction = parentTx;
          invoiceMsg = parentRepliedMsg;
          if (!paymentEvidenceMsg && repliedMsg) {
            paymentEvidenceMsg = repliedMsg;
          }
        }
      }

      // Fallback 1: Extract invoice ID from replied message caption or text (e.g. photo invoice)
      if (!transaction) {
        const textToScan = repliedMsg.caption ?? repliedMsg.text ?? '';
        const parsed = parseInvoiceMetadataFromText(textToScan);
        if (parsed.invoiceId) {
          transaction = await transactionService.findById(parsed.invoiceId);
          if (!transaction) {
            // Auto-restore transaction from the invoice message metadata
            try {
              transaction = await transactionService.restoreOrRegisterTransaction({
                id: parsed.invoiceId,
                chatId,
                pendingTopicId: threadId,
                messageId: repliedMsg.message_id,
                distributorSnapshot: parsed.distributor,
                amount: parsed.amount,
              });
            } catch {
              /* ignore */
            }
          }
          if (transaction) {
            invoiceMsg = repliedMsg;
          }
        }
      }

      // Fallback 2: Extract invoice ID from parent replied message caption or text
      if (!transaction && parentRepliedMsg) {
        const textToScan = parentRepliedMsg.caption ?? parentRepliedMsg.text ?? '';
        const parsed = parseInvoiceMetadataFromText(textToScan);
        if (parsed.invoiceId) {
          transaction = await transactionService.findById(parsed.invoiceId);
          if (!transaction) {
            try {
              transaction = await transactionService.restoreOrRegisterTransaction({
                id: parsed.invoiceId,
                chatId,
                pendingTopicId: threadId,
                messageId: parentRepliedMsg.message_id,
                distributorSnapshot: parsed.distributor,
                amount: parsed.amount,
              });
            } catch {
              /* ignore */
            }
          }
          if (transaction) {
            invoiceMsg = parentRepliedMsg;
            if (!paymentEvidenceMsg && repliedMsg) {
              paymentEvidenceMsg = repliedMsg;
            }
          }
        }
      }

      // Fallback 3: If replied to a message in the pending topic but transaction isn't registered yet
      if (!transaction) {
        try {
          transaction = await transactionService.registerTransaction(
            chatId,
            threadId,
            repliedMsg.message_id
          );
          if (transaction) {
            invoiceMsg = repliedMsg;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Fallback 4: If not found via reply, check explicit ID or scan current command message
    if (!transaction && explicitId) {
      transaction = await transactionService.findById(explicitId);
      if (!transaction && repliedMsg) {
        try {
          transaction = await transactionService.restoreOrRegisterTransaction({
            id: explicitId,
            chatId,
            pendingTopicId: threadId,
            messageId: repliedMsg.message_id,
          });
          if (transaction) {
            invoiceMsg = repliedMsg;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (!transaction) {
      const msgTextToScan = msg.caption ?? msg.text ?? '';
      const fallbackId = extractInvoiceIdFromText(msgTextToScan);
      if (fallbackId) {
        transaction = await transactionService.findById(fallbackId);
      }
    }

    // Keep invoice-to-message mapping synchronized for future lookups
    if (
      transaction &&
      repliedMsg &&
      (!transaction.metadataMessageId || transaction.metadataMessageId !== repliedMsg.message_id)
    ) {
      await transactionService.updateMetadataMessageId(transaction.id, repliedMsg.message_id).catch(() => {});
    }

    if (!transaction) {
      await ctx.reply(
        '❌ Invalid payment confirmation.\n\n' +
        'Reply to the invoice with /paid (and optional receipt), or type /paid #INV0001.',
        { message_thread_id: threadId },
      );
      return;
    }

    if (transaction.status === 'PAID') {
      await ctx.reply(`❌ Transaction ${formatInvoiceId(transaction.id)} has already been paid.`, {
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
      paymentEvidenceMsg,
      paymentAmount,
      userNote
    );

    if (result.success) {
      // If invoiceMsg was NOT in the thread (e.g. standalone /paid #INV0001), send brief confirmation
      // If invoiceMsg was edited in place, the updated caption in Pending IS the confirmation (no duplicate status message!)
      if (!invoiceMsg) {
        try {
          const statusText = result.status === 'PARTIALLY_PAID' ? 'partially paid' : 'paid';
          const successMsg = await ctx.reply(
            `✅ Transaction ${formatInvoiceId(transaction.id)} ${statusText}.\n🔗 ${result.confirmationUrl}`,
            { message_thread_id: threadId }
          );
          // Auto-delete the success message after 10 seconds
          scheduleDelete(ctx, ctx.chat.id, successMsg.message_id, 10_000);
        } catch {
          /* ignore */
        }
      }
    }
 else {
      // Confirmation failed — originals are preserved
      await ctx.reply(
        `❌ Payment confirmation failed for ${formatInvoiceId(transaction.id)}.\n\n` +
        `The original transaction and payment message were not removed.\n` +
        `Please try again.\n\n` +
        `Error: ${result.error}`,
        { message_thread_id: threadId },
      );
    }
  });
}
