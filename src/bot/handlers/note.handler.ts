import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { getConfig, type Config } from '../../config/config';
import { TransactionService } from '../../transactions/transaction.service';
import { requireAdmin } from '../middleware/auth.middleware';
import { isReply, getEffectiveRepliedMessage } from '../helpers/telegram.helpers';
import { nowISO } from '../helpers/format.helpers';
import type { InvoiceNote } from '../../types';

export const MAX_NOTE_LENGTH = 1000;

/**
 * Checks if a message represents the /note command.
 * Checks both msg.text and msg.caption.
 */
export function isNoteCommand(msg: Message): boolean {
  const text = (msg.text ?? msg.caption ?? '').trim();
  return /^\/note(@\w+)?(\s|$)/i.test(text);
}

export function registerNoteHandler(
  bot: Composer<Context>,
  transactionService: TransactionService,
  customConfig?: Config
): void {
  const config = customConfig ?? getConfig();

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || !isNoteCommand(msg)) return next();

    return requireAdmin(customConfig)(ctx, async () => {
      const threadId = msg.message_thread_id;
      const text = (msg.text ?? msg.caption ?? '').trim();
      const rawNote = text.replace(/^\/note(?:@\w+)?\s*/i, '').trim();

      const repliedMsg = getEffectiveRepliedMessage(msg);

      // 1. Validate reply: must reply to an existing invoice message
      if (!repliedMsg) {
        await ctx.reply(
          'ℹ️ Usage: Reply to an invoice message with `/note <your note>` to attach a note.',
          {
            message_thread_id: threadId,
            parse_mode: 'Markdown',
          }
        );
        return;
      }

      // 2. Validate note text: must not be empty
      if (!rawNote) {
        await ctx.reply(
          'ℹ️ Please provide note content. Example: `/note Verified by manager`',
          {
            message_thread_id: threadId,
            parse_mode: 'Markdown',
          }
        );
        return;
      }

      // 3. Validate note length: reject excessively long input
      if (rawNote.length > MAX_NOTE_LENGTH) {
        await ctx.reply(
          `❌ Note is too long (${rawNote.length} characters). Maximum allowed is ${MAX_NOTE_LENGTH} characters.`,
          {
            message_thread_id: threadId,
          }
        );
        return;
      }

      const chatId = String(ctx.chat.id);

      // 4. Resolve the target invoice using message-to-invoice mapping
      const transaction = await transactionService.findByAnyMessageId(chatId, repliedMsg.message_id);
      if (!transaction) {
        await ctx.reply('❌ Could not find an invoice associated with this message.', {
          message_thread_id: threadId,
        });
        return;
      }

      // 5. Append new note and persist to database FIRST before Telegram message edit
      const author =
        ctx.from?.username ?? (ctx.from?.first_name ? ctx.from.first_name : undefined);
      const newNote: InvoiceNote = {
        text: rawNote,
        createdAt: nowISO(),
        author,
      };

      let updatedTx;
      try {
        updatedTx = await transactionService.appendNote(transaction.id, newNote);
      } catch (err: unknown) {
        console.error('Failed to persist note to database:', (err as Error).message);
        await ctx.reply(`❌ Failed to save note: ${(err as Error).message}`, {
          message_thread_id: threadId,
        });
        return;
      }

      // 6. Update the original invoice message in Telegram safely
      try {
        const result = await transactionService.updateInvoiceNotesDisplay(
          ctx.api,
          ctx.chat.id,
          updatedTx,
          repliedMsg
        );
        if (!result.success) {
          console.warn('Note saved to DB, but updating Telegram display failed:', result.error);
        }
      } catch (err: unknown) {
        console.error('Failed to update Telegram message display:', (err as Error).message);
        // Safe recovery path: note is already saved in DB! Do not fail or create duplicate invoice.
      }

      // 7. Delete the /note command message (do not send a separate note message)
      try {
        await ctx.deleteMessage();
      } catch {
        // Best effort deletion of the command message
      }
    });
  });
}
