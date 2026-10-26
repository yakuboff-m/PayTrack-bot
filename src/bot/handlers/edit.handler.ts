import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { getConfig, type Config } from '../../config/config';
import { TransactionRepository } from '../../transactions/transaction.repository';
import { requireAdmin } from '../middleware/auth.middleware';
import {
  getEffectiveRepliedMessage,
  detectMessageType,
  extractMediaInfo,
  MAX_TEXT_LENGTH,
  MAX_CAPTION_LENGTH,
} from '../helpers/telegram.helpers';
import { globalMessageTracker, type TrackedMessage } from '../helpers/message-tracker';

/**
 * Checks if a message represents the /edit command (text or caption).
 */
export function isEditCommand(msg: Message): boolean {
  const text = (msg.text ?? msg.caption ?? '').trim();
  return /^\/edit(@\w+)?(\s|$)/i.test(text);
}

/**
 * Determines whether a message ID belongs to a protected invoice or financial record.
 */
export async function checkMessageProtection(
  chatId: string,
  messageId: number,
  txRepo: TransactionRepository
): Promise<{ isProtected: boolean; reason?: string }> {
  try {
    const tx = await txRepo.findByAnyMessageId(chatId, messageId);
    if (!tx) {
      return { isProtected: false };
    }

    // 1. Account-control messages
    let historicalControlIds: number[] = [];
    try {
      historicalControlIds = JSON.parse(tx.historical_control_message_ids || '[]');
    } catch {
      historicalControlIds = [];
    }

    if (
      tx.account_control_message_id === messageId ||
      historicalControlIds.includes(messageId)
    ) {
      return {
        isProtected: true,
        reason:
          '❌ Cannot edit account-control messages with /edit. Account details are managed automatically.',
      };
    }

    // 2. Confirmed and payment-history messages
    if (
      tx.confirmation_message_id === messageId ||
      tx.history_message_id === messageId ||
      tx.payment_message_id === messageId
    ) {
      return {
        isProtected: true,
        reason:
          '❌ Cannot edit confirmed payment records with /edit. Financial history is protected.',
      };
    }

    const payments = await txRepo.getPayments(tx.id);
    if (
      payments.some(
        (p) =>
          p.payment_message_id === messageId ||
          p.confirmed_message_id === messageId ||
          p.history_message_id === messageId ||
          p.receipt_message_id === messageId
      )
    ) {
      return {
        isProtected: true,
        reason:
          '❌ Cannot edit confirmed payment records with /edit. Financial history is protected.',
      };
    }

    // 3. Invoice messages (original, metadata/canonical, superseded, additions)
    let supersededIds: number[] = [];
    try {
      supersededIds = JSON.parse(tx.superseded_message_ids || '[]');
    } catch {
      supersededIds = [];
    }

    const additions = await txRepo.getAdditions(tx.id);
    const additionMessageIds = additions
      .map((a) => a.message_id)
      .filter((id): id is number => typeof id === 'number');

    if (
      tx.original_message_id === messageId ||
      tx.metadata_message_id === messageId ||
      supersededIds.includes(messageId) ||
      additionMessageIds.includes(messageId)
    ) {
      return {
        isProtected: true,
        reason:
          '❌ Cannot edit protected invoice messages with /edit. Use /amount, /add, /note, or /paid to update invoices.',
      };
    }

    return {
      isProtected: true,
      reason: '❌ Cannot edit protected invoice or financial records with /edit.',
    };
  } catch (err) {
    console.error('Error checking message protection:', err);
    return { isProtected: false };
  }
}

function sanitizeErrorMessage(errMsg: string): string {
  // Hide tokens, paths, or DB errors
  return errMsg
    .replace(/\b\d{9,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED_TOKEN]')
    .replace(/\/[a-zA-Z0-9_\-./]+\.(ts|js|sql)/g, '[INTERNAL_PATH]')
    .trim();
}

// Track recently processed edit command IDs for idempotency
const processedEditCommandIds = new Set<number>();

export function registerEditHandler(
  bot: Composer<Context>,
  transactionRepo: TransactionRepository,
  customConfig?: Config
): void {
  const config = customConfig ?? getConfig();

  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || !isEditCommand(msg)) return next();

    return requireAdmin(customConfig)(ctx, async () => {
      const threadId = msg.message_thread_id;
      const chatIdNum = ctx.chat.id;
      const chatIdStr = String(chatIdNum);

      // ─── 1. Group & Topic Authorization ──────────────────────
      const configuredGroupId = Number(config.telegramGroupId);
      if (chatIdNum !== configuredGroupId) {
        await ctx.reply('❌ The /edit command can only be used in the authorized group.', {
          message_thread_id: threadId,
        });
        return;
      }

      if (
        threadId !== undefined &&
        threadId !== config.pendingTopicId &&
        threadId !== config.confirmedTopicId
      ) {
        await ctx.reply('❌ The /edit command can only be used in authorized topics.', {
          message_thread_id: threadId,
        });
        return;
      }

      // ─── 2. Idempotency Check ────────────────────────────────
      if (processedEditCommandIds.has(msg.message_id)) {
        return;
      }

      // ─── 3. Validate Reply (Target Message) ───────────────────
      let targetMsg = getEffectiveRepliedMessage(msg);
      if (!targetMsg) {
        await ctx.reply(
          'ℹ️ Usage: Reply to the message you want to edit with `/edit`.\n\nExample:\n1. Send replacement message\n2. Reply to target message with `/edit`',
          {
            message_thread_id: threadId,
            parse_mode: 'Markdown',
          }
        );
        return;
      }

      // ─── 4. Resolve Replacement Content ───────────────────────
      const rawCmdText = (msg.text ?? msg.caption ?? '').replace(/^\/edit(?:@\w+)?\s*/i, '').trim();
      const cmdMedia = extractMediaInfo(msg);

      let replacementText: string | undefined;
      let replacementMediaFileId: string | undefined;
      let replacementMediaType: 'photo' | 'document' | undefined;
      let replacementMsgId: number | undefined;

      // Case A: Replacement content is passed directly in command message
      if (cmdMedia.mediaFileId) {
        replacementMediaFileId = cmdMedia.mediaFileId;
        replacementMediaType = cmdMedia.mediaType ?? undefined;
        replacementText = rawCmdText;
        replacementMsgId = msg.message_id;
      } else if (rawCmdText) {
        replacementText = rawCmdText;
        replacementMsgId = msg.message_id;
      } else {
        // Case B: User replied to replacement message, which itself replied to target message
        if (targetMsg.reply_to_message && targetMsg.from?.id === msg.from?.id) {
          const parentTarget = getEffectiveRepliedMessage(targetMsg);
          if (parentTarget) {
            // targetMsg is the replacement message, parentTarget is the actual target!
            const replMsg = targetMsg;
            targetMsg = parentTarget;
            replacementMsgId = replMsg.message_id;
            replacementText = (replMsg.text ?? replMsg.caption ?? '').trim() || undefined;
            const rMedia = extractMediaInfo(replMsg);
            if (rMedia.mediaFileId) {
              replacementMediaFileId = rMedia.mediaFileId;
              replacementMediaType = rMedia.mediaType ?? undefined;
            }
          }
        }

        // Case C: Standard two-step workflow:
        // 1. User sends replacement message.
        // 2. User replies to target message with /edit.
        if (!replacementText && !replacementMediaFileId) {
          const preceding = globalMessageTracker.findPrecedingMessage(
            chatIdStr,
            threadId,
            msg.message_id,
            msg.from?.id
          );

          let candidate: TrackedMessage | undefined = preceding;
          if (!candidate && msg.message_id > 1) {
            candidate = globalMessageTracker.get(chatIdStr, msg.message_id - 1);
          }

          if (candidate && candidate.message_id !== targetMsg.message_id) {
            replacementMsgId = candidate.message_id;
            replacementText = (candidate.text ?? candidate.caption ?? '').trim() || undefined;
            if (candidate.photo && candidate.photo.length > 0) {
              replacementMediaFileId = candidate.photo[candidate.photo.length - 1].file_id;
              replacementMediaType = 'photo';
            } else if (candidate.document) {
              replacementMediaFileId = candidate.document.file_id;
              replacementMediaType = 'document';
            }
          }
        }
      }

      // Check if replacement content is available
      if (!replacementText && !replacementMediaFileId) {
        await ctx.reply(
          '❌ Missing replacement content. Send your replacement message first, then reply to the message you want to edit with `/edit`.',
          {
            message_thread_id: threadId,
            parse_mode: 'Markdown',
          }
        );
        return;
      }

      // ─── 5. Check Target Message Protection ──────────────────
      const protection = await checkMessageProtection(
        chatIdStr,
        targetMsg.message_id,
        transactionRepo
      );
      if (protection.isProtected) {
        await ctx.reply(protection.reason || '❌ Cannot edit protected message with /edit.', {
          message_thread_id: threadId,
        });
        return;
      }

      // ─── 6. Execute Edit by Target and Replacement Types ─────
      const targetType = detectMessageType(targetMsg);
      const isReplacementMedia = Boolean(replacementMediaFileId);

      try {
        if (targetType === 'text') {
          if (isReplacementMedia) {
            await ctx.reply(
              '❌ Unsupported edit: Cannot replace a text message with media.',
              { message_thread_id: threadId }
            );
            return;
          }

          if (replacementText && replacementText.length > MAX_TEXT_LENGTH) {
            await ctx.reply(
              `❌ Text is too long (${replacementText.length} characters). Maximum allowed is ${MAX_TEXT_LENGTH} characters.`,
              { message_thread_id: threadId }
            );
            return;
          }

          try {
            await ctx.api.editMessageText(
              chatIdNum,
              targetMsg.message_id,
              replacementText ?? '',
              { parse_mode: 'HTML' }
            );
          } catch (htmlErr: any) {
            const htmlMsg = String(htmlErr?.message || '').toLowerCase();
            if (htmlMsg.includes("can't parse entities") || htmlMsg.includes('failed to parse entities')) {
              await ctx.api.editMessageText(
                chatIdNum,
                targetMsg.message_id,
                replacementText ?? ''
              );
            } else {
              throw htmlErr;
            }
          }
        } else if (targetType === 'photo' || targetType === 'document') {
          if (!isReplacementMedia) {
            // Target is media, replacement is text -> update caption, preserving media
            if (replacementText && replacementText.length > MAX_CAPTION_LENGTH) {
              await ctx.reply(
                `❌ Caption is too long (${replacementText.length} characters). Maximum allowed for media captions is ${MAX_CAPTION_LENGTH} characters.`,
                { message_thread_id: threadId }
              );
              return;
            }

            try {
              await ctx.api.editMessageCaption(
                chatIdNum,
                targetMsg.message_id,
                { caption: replacementText ?? '', parse_mode: 'HTML' }
              );
            } catch (htmlErr: any) {
              const htmlMsg = String(htmlErr?.message || '').toLowerCase();
              if (htmlMsg.includes("can't parse entities") || htmlMsg.includes('failed to parse entities')) {
                await ctx.api.editMessageCaption(
                  chatIdNum,
                  targetMsg.message_id,
                  { caption: replacementText ?? '' }
                );
              } else {
                throw htmlErr;
              }
            }
          } else {
            // Target is media, replacement is media -> update media using editMessageMedia
            const inputMedia =
              replacementMediaType === 'document'
                ? {
                    type: 'document' as const,
                    media: replacementMediaFileId!,
                    caption: replacementText ?? '',
                    parse_mode: 'HTML' as const,
                  }
                : {
                    type: 'photo' as const,
                    media: replacementMediaFileId!,
                    caption: replacementText ?? '',
                    parse_mode: 'HTML' as const,
                  };

            await ctx.api.editMessageMedia(
              chatIdNum,
              targetMsg.message_id,
              inputMedia
            );
          }
        }

        // Mark command as processed for idempotency
        processedEditCommandIds.add(msg.message_id);
        if (processedEditCommandIds.size > 1000) {
          const first = processedEditCommandIds.values().next().value;
          if (first) processedEditCommandIds.delete(first);
        }

        // ─── 7. Cleanup Replacement Message ──────────────────────
        if (replacementMsgId && replacementMsgId !== msg.message_id) {
          try {
            await ctx.api.deleteMessage(chatIdNum, replacementMsgId);
            globalMessageTracker.delete(chatIdStr, replacementMsgId);
          } catch (delErr: unknown) {
            console.warn(
              `Failed to delete replacement message ${replacementMsgId}:`,
              (delErr as Error).message
            );
          }
        }

        // ─── 8. Brief Confirmation ───────────────────────────────
        await ctx.reply('✅ Message edited successfully.', {
          reply_to_message_id: msg.message_id,
          message_thread_id: threadId,
        });
      } catch (err: unknown) {
        const errMsg = (err as Error).message || String(err);
        if (errMsg.includes('message is not modified')) {
          // Idempotent: content already matches
          processedEditCommandIds.add(msg.message_id);
          if (replacementMsgId && replacementMsgId !== msg.message_id) {
            await ctx.api.deleteMessage(chatIdNum, replacementMsgId).catch(() => {});
          }
          await ctx.reply('✅ Message edited successfully.', {
            reply_to_message_id: msg.message_id,
            message_thread_id: threadId,
          });
          return;
        }

        console.error('Failed to edit message via /edit:', errMsg);
        await ctx.reply(
          `❌ Failed to edit message: ${sanitizeErrorMessage(errMsg)}`,
          { message_thread_id: threadId }
        );
      }
    });
  });
}
