import type { Api } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { TransactionRepository } from './transaction.repository';
import { getConfig } from '../config/config';
import {
  buildMessageLink,
  detectMessageType,
  splitOriginalAndMetadata,
  composeMessageText,
  MAX_CAPTION_LENGTH,
  MAX_TEXT_LENGTH,
} from '../bot/helpers/telegram.helpers';
import {
  formatConfirmedHeader,
  formatHistoryRecord,
  buildMetadataBlock,
  nowISO,
} from '../bot/helpers/format.helpers';
import type {
  Transaction,
  TransactionRow,
  DistributorSnapshot,
  ConfirmationResult,
} from '../types';

/**
 * In-memory lock set to prevent duplicate /confirmed processing.
 * Keyed by transaction ID.
 */
const processingLocks = new Set<number>();

export class TransactionService {
  constructor(private repo: TransactionRepository) {}

  // ─── Row → Domain mapping ────────────────────────────────

  private toDomain(row: TransactionRow): Transaction {
    return {
      id: row.id,
      telegramChatId: row.telegram_chat_id,
      pendingTopicId: row.pending_topic_id,
      originalMessageId: row.original_message_id,
      distributorId: row.distributor_id,
      distributorSnapshot: row.distributor_snapshot
        ? JSON.parse(row.distributor_snapshot)
        : null,
      amount: row.amount,
      currency: row.currency,
      status: row.status as Transaction['status'],
      receivedAt: row.received_at,
      paidAt: row.paid_at,
      paymentMessageId: row.payment_message_id,
      confirmationMessageId: row.confirmation_message_id,
      confirmationUrl: row.confirmation_url,
      historyMessageId: row.history_message_id,
      metadataMessageId: row.metadata_message_id,
      createdAt: row.created_at,
    };
  }

  // ─── Registration ─────────────────────────────────────────

  registerTransaction(chatId: string, topicId: number, messageId: number): Transaction {
    const row = this.repo.create(chatId, topicId, messageId, nowISO());
    return this.toDomain(row);
  }

  findById(id: number): Transaction | undefined {
    const row = this.repo.findById(id);
    return row ? this.toDomain(row) : undefined;
  }

  findByMessageId(chatId: string, messageId: number): Transaction | undefined {
    const row = this.repo.findByMessageId(chatId, messageId);
    return row ? this.toDomain(row) : undefined;
  }

  /** Finds a transaction by original or bot-resent message ID. */
  findByAnyMessageId(chatId: string, messageId: number): Transaction | undefined {
    const row = this.repo.findByAnyMessageId(chatId, messageId);
    return row ? this.toDomain(row) : undefined;
  }

  // ─── Distributor Assignment ───────────────────────────────

  assignDistributor(
    transactionId: number,
    distributorId: number,
    snapshot: DistributorSnapshot
  ): Transaction {
    this.repo.updateDistributor(transactionId, distributorId, JSON.stringify(snapshot));
    return this.toDomain(this.repo.findById(transactionId)!);
  }

  // ─── Amount ───────────────────────────────────────────────

  setAmount(transactionId: number, amount: number): Transaction {
    this.repo.updateAmount(transactionId, amount);
    return this.toDomain(this.repo.findById(transactionId)!);
  }

  // ─── Bot Message Management ───────────────────────────────

  /**
   * Re-sends the user's invoice as a bot-owned message with metadata caption
   * and inline keyboard, then deletes the user's original.
   *
   * If the bot already owns the message (metadataMessageId exists), edits
   * the existing bot message's caption/text instead of re-sending.
   *
   * Result: ONE clean message in Pending — bot-owned, with media + caption + keyboard.
   */
  async updateTransactionDisplay(
    api: Api,
    chatId: number,
    topicId: number,
    repliedMessage: Message,
    transaction: Transaction,
    distributor: DistributorSnapshot | null,
    amount: number | null,
    keyboard?: InlineKeyboardMarkup
  ): Promise<{ botMessageId: number } | { error: string }> {
    const metadataBlock = buildMetadataBlock(
      distributor,
      amount,
      transaction.receivedAt,
      transaction.id
    );

    // ── If the bot already owns the message, just edit it ────
    if (transaction.metadataMessageId) {
      try {
        // Get the current caption/text to preserve the original content
        const currentText = repliedMessage.text ?? repliedMessage.caption ?? '';
        const { original } = splitOriginalAndMetadata(currentText);

        const msgType = detectMessageType(repliedMessage);
        const newContent = original
          ? composeMessageText(original, metadataBlock)
          : metadataBlock;
        const maxLen = msgType === 'text' ? MAX_TEXT_LENGTH : MAX_CAPTION_LENGTH;
        const safeContent = newContent.length <= maxLen ? newContent : metadataBlock;

        if (msgType === 'text') {
          await api.editMessageText(chatId, transaction.metadataMessageId, safeContent, {
            reply_markup: keyboard,
          });
        } else {
          await api.editMessageCaption(chatId, transaction.metadataMessageId, {
            caption: safeContent,
            reply_markup: keyboard,
          });
        }
        return { botMessageId: transaction.metadataMessageId };
      } catch (err: unknown) {
        console.warn('Failed to edit bot message, will re-send:', (err as Error).message);
        // Fall through to re-send
      }
    }

    // ── Bot doesn't own the message yet — re-send as bot ────
    const msgType = detectMessageType(repliedMessage);
    const originalCaption = repliedMessage.text ?? repliedMessage.caption ?? '';
    const caption = originalCaption
      ? composeMessageText(originalCaption, metadataBlock)
      : metadataBlock;

    let botMsg: Message;
    try {
      switch (msgType) {
        case 'photo': {
          // Get the highest-resolution photo
          const photos = repliedMessage.photo!;
          const fileId = photos[photos.length - 1].file_id;
          const maxLen = MAX_CAPTION_LENGTH;
          const safeCaption = caption.length <= maxLen ? caption : metadataBlock;
          botMsg = await api.sendPhoto(chatId, fileId, {
            caption: safeCaption,
            message_thread_id: topicId,
            reply_markup: keyboard,
          });
          break;
        }
        case 'document': {
          const fileId = repliedMessage.document!.file_id;
          const maxLen = MAX_CAPTION_LENGTH;
          const safeCaption = caption.length <= maxLen ? caption : metadataBlock;
          botMsg = await api.sendDocument(chatId, fileId, {
            caption: safeCaption,
            message_thread_id: topicId,
            reply_markup: keyboard,
          });
          break;
        }
        case 'text':
        default: {
          botMsg = await api.sendMessage(chatId, caption, {
            message_thread_id: topicId,
            reply_markup: keyboard,
          });
          break;
        }
      }
    } catch (err: unknown) {
      return { error: `Failed to re-send as bot message: ${(err as Error).message}` };
    }

    // Delete the user's original message
    try {
      await api.deleteMessage(chatId, repliedMessage.message_id);
    } catch (err: unknown) {
      console.warn('Failed to delete user original:', (err as Error).message);
      // Non-fatal — bot message was already sent successfully
    }

    // Persist the bot message ID
    this.repo.updateMetadataMessageId(transaction.id, botMsg.message_id);

    return { botMessageId: botMsg.message_id };
  }

  // ─── Confirmation Orchestration ───────────────────────────

  /**
   * Executes the full confirmation workflow.
   * This is failure-safe/ordered: creative operations first, then DB commit,
   * then destructive cleanup. If any creative step fails, originals are preserved.
   *
   * Uses an in-memory lock to prevent duplicate processing and re-checks
   * the transaction status before the final DB commit.
   */
  async executeConfirmation(
    api: Api,
    transaction: Transaction,
    commandMessageId: number,
    invoiceMsg?: Message,
    paymentEvidenceMsg?: Message
  ): Promise<ConfirmationResult> {
    const config = getConfig();
    const chatId = config.telegramGroupId;

    // ── Acquire processing lock ──────────────────────────────
    if (processingLocks.has(transaction.id)) {
      return {
        success: false,
        error: 'This transaction is already being confirmed. Please wait.',
      };
    }
    processingLocks.add(transaction.id);

    try {
      const paidAt = nowISO();
      const distributorName = transaction.distributorSnapshot?.name ?? null;

      // Determine which message to copy: bot's message if available, otherwise original
      const invoiceMessageId = transaction.metadataMessageId ?? transaction.originalMessageId;

      // Extract optional note from payment message
      const rawNote = (paymentEvidenceMsg?.caption ?? paymentEvidenceMsg?.text ?? '')
        .replace(/^\/confirmed(@\w+)?\s*/i, '')
        .trim();
      const userNote = rawNote || undefined;

      // ── Phase 1: Create confirmation in Confirmed topic ────
      const headerText = formatConfirmedHeader(
        distributorName,
        transaction.amount,
        transaction.receivedAt,
        paidAt,
        transaction.id,
        userNote
      );

      // Extract file IDs from invoice and payment media
      const invoicePhoto = (invoiceMsg?.photo && invoiceMsg.photo.length > 0)
        ? invoiceMsg.photo[invoiceMsg.photo.length - 1].file_id
        : null;
      const paymentPhoto = (paymentEvidenceMsg?.photo && paymentEvidenceMsg.photo.length > 0)
        ? paymentEvidenceMsg.photo[paymentEvidenceMsg.photo.length - 1].file_id
        : null;

      const invoiceDoc = invoiceMsg?.document?.file_id ?? null;
      const paymentDoc = paymentEvidenceMsg?.document?.file_id ?? null;

      let confirmedMsgId: number;

      try {
        if (invoicePhoto && paymentPhoto) {
          // Both are photos: send TOGETHER as ONE media group (album) with the single caption!
          const album = await api.sendMediaGroup(
            chatId,
            [
              {
                type: 'photo',
                media: invoicePhoto,
                caption: headerText,
              },
              {
                type: 'photo',
                media: paymentPhoto,
              },
            ],
            { message_thread_id: config.confirmedTopicId }
          );
          confirmedMsgId = album[0].message_id;
        } else if (invoiceDoc && paymentDoc) {
          // Both are documents: send TOGETHER as ONE media group with the single caption!
          const album = await api.sendMediaGroup(
            chatId,
            [
              {
                type: 'document',
                media: invoiceDoc,
                caption: headerText,
              },
              {
                type: 'document',
                media: paymentDoc,
              },
            ],
            { message_thread_id: config.confirmedTopicId }
          );
          confirmedMsgId = album[0].message_id;
        } else if (invoiceMsg && detectMessageType(invoiceMsg) === 'text') {
          // Text invoice
          const sent = await api.sendMessage(chatId, headerText, {
            message_thread_id: config.confirmedTopicId,
          });
          confirmedMsgId = sent.message_id;
          if (paymentPhoto) {
            try {
              await api.copyMessage(chatId, chatId, paymentEvidenceMsg!.message_id, {
                message_thread_id: config.confirmedTopicId,
                caption: userNote ? `🧾 Payment Receipt: ${userNote}` : '🧾 Payment Receipt',
              });
            } catch { /* best effort */ }
          }
        } else {
          // Single media (no separate payment photo, or mixed formats)
          const copied = await api.copyMessage(chatId, chatId, invoiceMessageId, {
            message_thread_id: config.confirmedTopicId,
            caption: headerText,
          });
          confirmedMsgId = copied.message_id;

          // If there is a payment document that couldn't be grouped with a photo
          if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== invoiceMessageId && paymentDoc) {
            try {
              await api.copyMessage(chatId, chatId, paymentEvidenceMsg.message_id, {
                message_thread_id: config.confirmedTopicId,
                caption: userNote ? `🧾 Payment Receipt: ${userNote}` : '🧾 Payment Receipt',
              });
            } catch (err: unknown) {
              console.warn(`Failed to copy payment doc: ${(err as Error).message}`);
            }
          }
        }
      } catch (err: unknown) {
        return {
          success: false,
          error: `Failed to create confirmation in Confirmed topic: ${(err as Error).message}`,
        };
      }

      const confirmationUrl = buildMessageLink(chatId, confirmedMsgId);

      // ── Phase 2: Record in Pending + DB ────────────────────

      // Create history record in Pending topic
      let historyMsg: Message.TextMessage;
      try {
        const historyText = formatHistoryRecord(
          distributorName,
          transaction.amount,
          transaction.receivedAt,
          paidAt,
          confirmationUrl,
          transaction.id,
          userNote
        );
        historyMsg = await api.sendMessage(chatId, historyText, {
          message_thread_id: config.pendingTopicId,
        });
      } catch (err: unknown) {
        return {
          success: false,
          error: `Failed to create history record: ${(err as Error).message}`,
        };
      }

      // Update DB — compare-and-swap
      const committed = this.repo.markPaid(
        transaction.id,
        paidAt,
        paymentEvidenceMsg?.message_id ?? commandMessageId,
        confirmedMsgId,
        confirmationUrl,
        historyMsg.message_id
      );

      if (!committed) {
        try { await api.deleteMessage(chatId, historyMsg.message_id); } catch { /* best effort */ }
        return {
          success: false,
          error: 'Transaction was already confirmed by another request.',
        };
      }

      // ── Phase 3: Cleanup (destructive — only after Phase 1+2 succeed) ─

      // Delete the bot's invoice message from Pending (or user's original if no bot msg)
      try {
        await api.deleteMessage(chatId, invoiceMessageId);
      } catch (err: unknown) {
        console.warn(`Failed to delete invoice message ${invoiceMessageId}:`, (err as Error).message);
      }

      // If bot re-sent and original still exists separately, delete original too
      if (transaction.metadataMessageId && transaction.metadataMessageId !== transaction.originalMessageId) {
        try {
          await api.deleteMessage(chatId, transaction.originalMessageId);
        } catch { /* may already be deleted during re-send */ }
      }

      // Delete payment evidence message from Pending if separate from command message
      if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== commandMessageId) {
        try {
          await api.deleteMessage(chatId, paymentEvidenceMsg.message_id);
        } catch (err: unknown) {
          console.warn(`Failed to delete payment evidence message: ${(err as Error).message}`);
        }
      }

      // Delete payment command message (/confirmed) from Pending
      try {
        await api.deleteMessage(chatId, commandMessageId);
      } catch (err: unknown) {
        console.warn(`Failed to delete command message ${commandMessageId}:`, (err as Error).message);
      }

      return {
        success: true,
        confirmationUrl,
      };
    } finally {
      processingLocks.delete(transaction.id);
    }
  }
}

