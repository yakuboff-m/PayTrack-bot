import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { getConfig, type Config } from '../../config/config';
import { TransactionService } from '../../transactions/transaction.service';
import { DistributorService } from '../../distributors/distributor.service';
import { requireAdmin } from '../middleware/auth.middleware';
import { copyAccountKeyboard } from '../keyboards/keyboards';
import { parseAmount, extractNoteFromText, nowISO } from '../helpers/format.helpers';
import {
  isFromBot,
  isCommand,
  isReply,
  getEffectiveRepliedMessage,
  METADATA_SEPARATOR,
} from '../helpers/telegram.helpers';
import {
  parseMeatInvoice,
  type MeatInvoice,
} from '../../transactions/meat-invoice';
import type { InvoiceNote } from '../../types';

/**
 * In-memory lock set of message IDs currently being processed to prevent duplicate
 * registrations during concurrent updates or Telegram retries.
 */
const inFlightRegistrations = new Set<string>();

export function registerTransactionHandler(
  bot: Composer<Context>,
  transactionService: TransactionService,
  distributorService: DistributorService,
  getBotId: () => number,
  customConfig?: Config
): void {
  const config = customConfig ?? getConfig();

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
    const rawText = msg.text ?? msg.caption ?? '';
    const { cleanText, note: initialNoteText } = extractNoteFromText(rawText);
    const author = msg.from?.username ?? (msg.from?.first_name ? msg.from.first_name : undefined);
    const initialNotes: InvoiceNote[] = initialNoteText
      ? [{ text: initialNoteText, createdAt: nowISO(), author }]
      : [];

    try {
      const tx = await transactionService.registerTransaction(
        chatId,
        config.pendingTopicId,
        msg.message_id,
        initialNotes.length > 0 ? initialNotes : undefined
      );
      console.log(`📝 Auto-registered transaction: message ${msg.message_id}`);

      // If an initial note was supplied, display the note inside the invoice's message
      if (initialNotes.length > 0) {
        const displayMsg = {
          ...msg,
          text: msg.text !== undefined ? cleanText : undefined,
          caption: msg.caption !== undefined ? cleanText : undefined,
        } as Message;

        await transactionService.updateInvoiceNotesDisplay(
          ctx.api,
          ctx.chat.id,
          tx,
          displayMsg
        );
      }
    } catch (err: unknown) {
      console.warn('Auto-registration skipped:', (err as Error).message);
    }

    return next();
  });

  // ─── Dynamic distributor alias commands ──────────────────

  // Matches:
  // 1. /alias
  // 2. /alias 280700 (simple amount)
  // 3. /alias <meat invoice lines> (plain-text meat calculator)
  bot.on('message:text', requireAdmin(customConfig), async (ctx, next) => {
    const msg = ctx.message;
    const text = msg.text.trim();

    // Match /alias or /alias <payload> (handles multiline text and optional @bot username)
    const match = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:[\s\n]+([\s\S]+))?$/i);
    if (!match) return next();

    const alias = match[1].toLowerCase();
    const payload = match[2]?.trim() || null;

    // Skip known framework commands
    const reservedCommands = ['help', 'distributors', 'add_distributor', 'amount', 'confirmed', 'paid', 'start', 'note'];
    if (reservedCommands.includes(alias)) return next();

    // Look up distributor by alias
    const distributor = await distributorService.findByAlias(alias);
    if (!distributor) return next();

    const chatId = String(ctx.chat.id);
    const threadId = msg.message_thread_id ?? config.pendingTopicId;
    const lockKey = `${chatId}:${msg.message_id}`;

    // Prevent duplicate processing if Telegram retries the update while in flight
    if (inFlightRegistrations.has(lockKey)) {
      return;
    }
    inFlightRegistrations.add(lockKey);

    try {
      let meatInvoice: MeatInvoice | undefined;
      let simpleAmount: number | null = null;
      let effectivePayload = payload;
      const initialNotes: InvoiceNote[] = [];

      const repliedMsg = getEffectiveRepliedMessage(msg);

      if (payload) {
        const { cleanText, note: payloadNote } = extractNoteFromText(payload);
        if (payloadNote) {
          initialNotes.push({
            text: payloadNote,
            createdAt: nowISO(),
            author: msg.from?.username ?? (msg.from?.first_name ? msg.from.first_name : undefined),
          });
          effectivePayload = cleanText || null;
        }
      }

      if (effectivePayload) {
        // Check if payload is a simple single amount
        const isSimpleAmount =
          !effectivePayload.includes('\n') &&
          !/[xX×\*]/.test(effectivePayload) &&
          parseAmount(effectivePayload) !== null;

        if (isSimpleAmount) {
          simpleAmount = parseAmount(effectivePayload);
        } else {
          // Attempt to parse as meat invoice
          const parsed = parseMeatInvoice(effectivePayload);
          if (!parsed.success) {
            await ctx.reply(`❌ ${parsed.error}`, {
              message_thread_id: threadId,
            });
            return;
          }
          meatInvoice = parsed.invoice;
        }
      } else if (repliedMsg) {
        // No payload on command, but user replied to a message
        // Check if replied message text contains meat invoice lines
        const repliedText = repliedMsg.text ?? repliedMsg.caption ?? '';
        if (
          repliedText &&
          /[xX×\*]/.test(repliedText) &&
          !repliedText.includes(METADATA_SEPARATOR)
        ) {
          const parsed = parseMeatInvoice(repliedText);
          if (parsed.success) {
            meatInvoice = parsed.invoice;
          }
        }
      }

      // ─── Case 1: Meat invoice provided directly (not a reply) ───
      if (meatInvoice && !repliedMsg) {
        // Prevent accidental duplicate registration if Telegram retried
        const existingTx = await transactionService.findByMessageId(chatId, msg.message_id);
        if (existingTx) {
          return;
        }

        let transaction;
        try {
          transaction = await transactionService.registerTransaction(
            chatId,
            config.pendingTopicId,
            msg.message_id,
            initialNotes.length > 0 ? initialNotes : undefined
          );
        } catch (err: unknown) {
          const errorMsg = (err as Error).message || '';
          if (errorMsg.includes('UNIQUE') || errorMsg.includes('constraint')) {
            return; // Duplicate caught by database constraint
          }
          throw err;
        }

        const snapshot = distributorService.createSnapshot(distributor);
        await transactionService.assignDistributor(transaction.id, distributor.id, snapshot);
        await transactionService.setAmount(transaction.id, meatInvoice.grandTotal);

        const displayMsg = {
          ...msg,
          text: meatInvoice.formattedDisplay,
        } as Message;

        const kb = copyAccountKeyboard(distributor.accountNumber);
        const result = await transactionService.updateTransactionDisplay(
          ctx.api,
          ctx.chat.id,
          config.pendingTopicId,
          displayMsg,
          transaction,
          snapshot,
          meatInvoice.grandTotal,
          kb
        );

        if ('error' in result) {
          await ctx.reply(`❌ ${result.error}`, {
            message_thread_id: threadId,
          });
        }
        return;
      }

      // ─── Case 2: Must be a reply to an existing transaction ─────
      if (!repliedMsg) {
        await ctx.reply(
          `❌ Reply to a transaction message with /${alias} to assign this distributor.`,
          { message_thread_id: threadId }
        );
        return;
      }

      // Find transaction (check both original and bot message IDs)
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

      // Assign distributor
      const snapshot = distributorService.createSnapshot(distributor);
      await transactionService.assignDistributor(transaction.id, distributor.id, snapshot);

      // Set amount if either meat invoice total or simple amount was provided
      let finalAmount = transaction.amount;
      if (meatInvoice) {
        finalAmount = meatInvoice.grandTotal;
        await transactionService.setAmount(transaction.id, finalAmount);
      } else if (simpleAmount !== null) {
        finalAmount = simpleAmount;
        await transactionService.setAmount(transaction.id, finalAmount);
      }

      // Reload to get latest state
      const updated = (await transactionService.findByAnyMessageId(chatId, repliedMsg.message_id))!;

      // Build keyboard with copy button
      const kb = copyAccountKeyboard(distributor.accountNumber);

      // Re-send or edit with new content
      let displayMsg: Message = repliedMsg;
      if (meatInvoice) {
        displayMsg = {
          ...repliedMsg,
          text: repliedMsg.text ? meatInvoice.formattedDisplay : undefined,
          caption: !repliedMsg.text ? meatInvoice.formattedDisplay : undefined,
        } as Message;
      }

      const result = await transactionService.updateTransactionDisplay(
        ctx.api,
        ctx.chat.id,
        config.pendingTopicId,
        displayMsg,
        updated,
        snapshot,
        finalAmount,
        kb
      );

      if ('error' in result) {
        await ctx.reply(`❌ ${result.error}`, {
          message_thread_id: threadId,
        });
        return;
      }

      // Delete the command message
      try {
        await ctx.deleteMessage();
      } catch {
        /* ignore */
      }
    } finally {
      inFlightRegistrations.delete(lockKey);
    }
  });
}
