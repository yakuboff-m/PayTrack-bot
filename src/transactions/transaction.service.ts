import type { Api } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { TransactionRepository } from './transaction.repository';
import { getConfig, type Config } from '../config/config';
import {
  buildMessageLink,
  detectMessageType,
  splitOriginalAndMetadata,
  composeMessageText,
  appendManualDeletionNotice,
  formatConfirmedInvoiceContent,
  splitTextMessage,
  MANUAL_DELETION_NOTICE,
  MAX_CAPTION_LENGTH,
  MAX_TEXT_LENGTH,
  isNoTextMessageError,
} from '../bot/helpers/telegram.helpers';
import {
  formatConfirmedHeader,
  formatHistoryRecord,
  buildMetadataBlock,
  formatInvoiceId,
  nowISO,
} from '../bot/helpers/format.helpers';
import { copyAccountKeyboard } from '../bot/keyboards/keyboards';
import type {
  Transaction,
  TransactionRow,
  DistributorSnapshot,
  ConfirmationResult,
  InvoiceNote,
} from '../types';

/**
 * In-memory lock set to prevent duplicate /confirmed processing within the same isolate.
 * Keyed by transaction ID.
 */
const processingLocks = new Set<number>();

export class TransactionService {
  constructor(
    private repo: TransactionRepository,
    private config?: Config
  ) {}

  private getEffectiveConfig(): Config {
    return this.config ?? getConfig();
  }

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
      notes: row.notes ? JSON.parse(row.notes) : [],
      createdAt: row.created_at,
    };
  }

  // ─── Registration ─────────────────────────────────────────

  async registerTransaction(
    chatId: string,
    topicId: number,
    messageId: number,
    notes?: InvoiceNote[]
  ): Promise<Transaction> {
    if (
      messageId === topicId ||
      (this.config && (messageId === this.config.pendingTopicId || messageId === this.config.confirmedTopicId))
    ) {
      throw new Error(`Cannot register topic creation message ${messageId} as a transaction.`);
    }
    const row = await this.repo.create(
      chatId,
      topicId,
      messageId,
      nowISO(),
      notes && notes.length > 0 ? JSON.stringify(notes) : undefined
    );
    return this.toDomain(row);
  }

  async restoreOrRegisterTransaction(params: {
    id?: number | null;
    chatId: string;
    pendingTopicId: number;
    messageId: number;
    distributorSnapshot?: DistributorSnapshot | null;
    amount?: number | null;
    notes?: InvoiceNote[];
  }): Promise<Transaction> {
    if (
      params.messageId === params.pendingTopicId ||
      (this.config && (params.messageId === this.config.pendingTopicId || params.messageId === this.config.confirmedTopicId))
    ) {
      throw new Error(`Cannot restore or register topic creation message ${params.messageId} as a transaction.`);
    }
    const row = await this.repo.restoreOrRegister({
      id: params.id ?? undefined,
      chatId: params.chatId,
      pendingTopicId: params.pendingTopicId,
      messageId: params.messageId,
      distributorSnapshot: params.distributorSnapshot ? JSON.stringify(params.distributorSnapshot) : null,
      amount: params.amount ?? null,
      receivedAt: nowISO(),
      notes: params.notes && params.notes.length > 0 ? JSON.stringify(params.notes) : null,
    });
    return this.toDomain(row);
  }

  async findById(id: number): Promise<Transaction | undefined> {
    const row = await this.repo.findById(id);
    return row ? this.toDomain(row) : undefined;
  }

  async findByMessageId(chatId: string, messageId: number): Promise<Transaction | undefined> {
    if (
      this.config &&
      (messageId === this.config.pendingTopicId || messageId === this.config.confirmedTopicId)
    ) {
      return undefined;
    }
    const row = await this.repo.findByMessageId(chatId, messageId);
    return row ? this.toDomain(row) : undefined;
  }

  /** Finds a transaction by original or bot-resent message ID. */
  async findByAnyMessageId(chatId: string, messageId: number): Promise<Transaction | undefined> {
    if (
      this.config &&
      (messageId === this.config.pendingTopicId || messageId === this.config.confirmedTopicId)
    ) {
      return undefined;
    }
    const row = await this.repo.findByAnyMessageId(chatId, messageId);
    return row ? this.toDomain(row) : undefined;
  }

  // ─── Distributor Assignment ───────────────────────────────

  async assignDistributor(
    transactionId: number,
    distributorId: number,
    snapshot: DistributorSnapshot
  ): Promise<Transaction> {
    await this.repo.updateDistributor(transactionId, distributorId, JSON.stringify(snapshot));
    const row = await this.repo.findById(transactionId);
    return this.toDomain(row!);
  }

  // ─── Amount ───────────────────────────────────────────────

  async setAmount(transactionId: number, amount: number): Promise<Transaction> {
    await this.repo.updateAmount(transactionId, amount);
    const row = await this.repo.findById(transactionId);
    return this.toDomain(row!);
  }

  // ─── Notes ────────────────────────────────────────────────

  async updateNotes(transactionId: number, notes: InvoiceNote[]): Promise<Transaction> {
    await this.repo.updateNotes(transactionId, JSON.stringify(notes));
    const row = await this.repo.findById(transactionId);
    return this.toDomain(row!);
  }

  async appendNote(transactionId: number, note: InvoiceNote): Promise<Transaction> {
    const tx = await this.findById(transactionId);
    if (!tx) {
      throw new Error(`Transaction ${transactionId} not found`);
    }
    const updatedNotes = [...(tx.notes ?? []), note];
    return this.updateNotes(transactionId, updatedNotes);
  }

  async updateMetadataMessageId(id: number, metadataMessageId: number): Promise<void> {
    await this.repo.updateMetadataMessageId(id, metadataMessageId);
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
      transaction.id,
      transaction.notes
    );

    const msgType = detectMessageType(repliedMessage);
    const maxLen = msgType === 'text' ? MAX_TEXT_LENGTH : MAX_CAPTION_LENGTH;

    // ── If the bot already owns the message, just edit it ────
    if (transaction.metadataMessageId) {
      try {
        // Get the current caption/text to preserve the original content
        const currentText = repliedMessage.text ?? repliedMessage.caption ?? '';
        const { original } = splitOriginalAndMetadata(currentText);

        const newContent = original
          ? composeMessageText(original, metadataBlock)
          : metadataBlock;

        let safeContent: string;
        if (newContent.length <= maxLen) {
          safeContent = newContent;
        } else {
          const available = maxLen - metadataBlock.length - 2;
          if (available > 10 && original) {
            safeContent = composeMessageText(original.substring(0, available - 3) + '...', metadataBlock);
          } else {
            safeContent = metadataBlock.length <= maxLen ? metadataBlock : metadataBlock.substring(0, maxLen);
          }
        }

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

    // ── Re-send as bot if direct edit failed or message is user-owned ────
    const originalCaption = repliedMessage.text ?? repliedMessage.caption ?? '';
    const caption = originalCaption
      ? composeMessageText(originalCaption, metadataBlock)
      : metadataBlock;

    let safeCaption: string;
    if (caption.length <= maxLen) {
      safeCaption = caption;
    } else {
      const available = maxLen - metadataBlock.length - 2;
      if (available > 10 && originalCaption) {
        safeCaption = composeMessageText(originalCaption.substring(0, available - 3) + '...', metadataBlock);
      } else {
        safeCaption = metadataBlock.length <= maxLen ? metadataBlock : metadataBlock.substring(0, maxLen);
      }
    }

    let botMsg: Message;
    try {
      switch (msgType) {
        case 'photo': {
          // Get the highest-resolution photo
          const photos = repliedMessage.photo!;
          const fileId = photos[photos.length - 1].file_id;
          botMsg = await api.sendPhoto(chatId, fileId, {
            caption: safeCaption,
            message_thread_id: topicId,
            reply_markup: keyboard,
          });
          break;
        }
        case 'document': {
          const fileId = repliedMessage.document!.file_id;
          botMsg = await api.sendDocument(chatId, fileId, {
            caption: safeCaption,
            message_thread_id: topicId,
            reply_markup: keyboard,
          });
          break;
        }
        case 'text':
        default: {
          botMsg = await api.sendMessage(chatId, safeCaption, {
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
    await this.repo.updateMetadataMessageId(transaction.id, botMsg.message_id);

    return { botMessageId: botMsg.message_id };
  }

  /**
   * Safely updates the display of an existing invoice when notes are added or updated.
   * Handles text and caption editing, preserves original content, calculations, distributor info, and media.
   * Works for both Pending and Confirmed invoices.
   */
  async updateInvoiceNotesDisplay(
    api: Api,
    chatId: number,
    transaction: Transaction,
    repliedMessage: Message
  ): Promise<{ success: boolean; botMessageId?: number; error?: string }> {
    try {
      const config = this.getEffectiveConfig();

      if (transaction.status === 'PAID') {
        const distributorName = transaction.distributorSnapshot?.name ?? null;
        const paidAt = transaction.paidAt ?? transaction.receivedAt;
        const targetMessageId = repliedMessage.message_id;

        // Replying to confirmation message in Confirmed topic
        if (transaction.confirmationMessageId && targetMessageId === transaction.confirmationMessageId) {
          const newHeader = formatConfirmedHeader(
            distributorName,
            transaction.amount,
            transaction.receivedAt,
            paidAt,
            transaction.id,
            undefined,
            transaction.notes
          );
          if (repliedMessage.photo || repliedMessage.document) {
            await api.editMessageCaption(chatId, targetMessageId, { caption: newHeader });
          } else {
            await api.editMessageText(chatId, targetMessageId, newHeader);
          }
          return { success: true, botMessageId: targetMessageId };
        }

        // Replying to history record in Pending topic
        if (transaction.historyMessageId && targetMessageId === transaction.historyMessageId) {
          const historyText = formatHistoryRecord(
            distributorName,
            transaction.amount,
            transaction.receivedAt,
            paidAt,
            transaction.confirmationUrl ?? '',
            transaction.id,
            undefined,
            transaction.notes
          );
          await api.editMessageText(chatId, targetMessageId, historyText);
          return { success: true, botMessageId: targetMessageId };
        }

        // Fallback for confirmed transaction
        if (transaction.confirmationMessageId) {
          try {
            const newHeader = formatConfirmedHeader(
              distributorName,
              transaction.amount,
              transaction.receivedAt,
              paidAt,
              transaction.id,
              undefined,
              transaction.notes
            );
            if (repliedMessage.photo || repliedMessage.document) {
              await api.editMessageCaption(chatId, transaction.confirmationMessageId, { caption: newHeader });
            } else {
              await api.editMessageText(chatId, transaction.confirmationMessageId, newHeader);
            }
          } catch {
            // best effort
          }
        }
        return { success: true };
      }

      // Invoice is PENDING:
      let keyboard: InlineKeyboardMarkup | undefined;
      if (transaction.distributorSnapshot?.accountNumber) {
        keyboard = copyAccountKeyboard(transaction.distributorSnapshot.accountNumber);
      } else if (repliedMessage.reply_markup) {
        keyboard = repliedMessage.reply_markup as InlineKeyboardMarkup;
      }

      const result = await this.updateTransactionDisplay(
        api,
        chatId,
        transaction.pendingTopicId ?? config.pendingTopicId,
        repliedMessage,
        transaction,
        transaction.distributorSnapshot,
        transaction.amount,
        keyboard
      );

      if ('error' in result) {
        return { success: false, error: result.error };
      }
      return { success: true, botMessageId: result.botMessageId };
    } catch (err: unknown) {
      console.error('Failed to update invoice notes display:', (err as Error).message);
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Confirmation Orchestration ───────────────────────────

  /**
   * Executes the full confirmation workflow.
   * This is failure-safe/ordered: creative operations first, then DB commit,
   * then destructive cleanup. If any creative step fails, originals are preserved.
   *
   * Uses an in-memory lock to prevent duplicate processing within the isolate,
   * and an atomic database compare-and-swap for distributed safety.
   */
  async executeConfirmation(
    api: Api,
    transaction: Transaction,
    commandMessageId: number,
    invoiceMsg?: Message,
    paymentEvidenceMsg?: Message
  ): Promise<ConfirmationResult> {
    const config = this.getEffectiveConfig();
    const chatId = config.telegramGroupId;

    // ── Check if already confirmed ───────────────────────────
    if (transaction.status === 'PAID') {
      return {
        success: false,
        error: 'Transaction was already confirmed.',
        confirmedMessageId: transaction.confirmationMessageId ?? undefined,
        historyMessageId: transaction.historyMessageId ?? undefined,
      };
    }

    // ── Acquire processing lock ──────────────────────────────
    if (processingLocks.has(transaction.id)) {
      return {
        success: false,
        error: 'This transaction is already being confirmed. Please wait.',
      };
    }
    processingLocks.add(transaction.id);

    let confirmedMsgId: number | undefined;
    const additionalConfirmedMsgIds: number[] = [];
    let pendingReceiptMsgId: number | undefined;
    let historyMsgId: number | undefined;

    // Helper for rolling back all created messages
    const rollbackAllCreatedMessages = async () => {
      if (historyMsgId) {
        try { await api.deleteMessage(chatId, historyMsgId); } catch { /* best effort */ }
      }
      if (pendingReceiptMsgId) {
        try { await api.deleteMessage(chatId, pendingReceiptMsgId); } catch { /* best effort */ }
      }
      for (const id of additionalConfirmedMsgIds) {
        try { await api.deleteMessage(chatId, id); } catch { /* best effort */ }
      }
      if (confirmedMsgId) {
        try { await api.deleteMessage(chatId, confirmedMsgId); } catch { /* best effort */ }
      }
    };

    try {
      const paidAt = nowISO();
      const distributorName = transaction.distributorSnapshot?.name ?? null;

      // Determine which message to copy: bot's message if available, otherwise original
      const invoiceMessageId = transaction.metadataMessageId ?? transaction.originalMessageId;

      // Extract optional note from payment message
      const rawNote = (paymentEvidenceMsg?.caption ?? paymentEvidenceMsg?.text ?? '')
        .replace(/^\/(paid|confirmed)(@\w+)?\s*/i, '')
        .trim();
      const userNote = rawNote || undefined;

      // ── Phase 1: Create confirmation in Confirmed topic ────
      const headerText = formatConfirmedHeader(
        distributorName,
        transaction.amount,
        transaction.receivedAt,
        paidAt,
        transaction.id,
        userNote,
        transaction.notes
      );

      // Extract original invoice content (preserving item breakdown, text, or captions)
      const invoiceRawText = invoiceMsg?.text ?? invoiceMsg?.caption ?? '';
      const { original: extractedOriginal } = splitOriginalAndMetadata(invoiceRawText);
      const originalInvoiceContent = extractedOriginal.trim() || invoiceRawText.trim();

      // Combined text for Confirmed topic: PAID header + blank line + original invoice content
      const combinedConfirmedText = formatConfirmedInvoiceContent(headerText, originalInvoiceContent);

      // Extract file IDs from invoice and payment media
      const invoicePhoto = (invoiceMsg?.photo && invoiceMsg.photo.length > 0)
        ? invoiceMsg.photo[invoiceMsg.photo.length - 1].file_id
        : null;
      const paymentPhoto = (paymentEvidenceMsg?.photo && paymentEvidenceMsg.photo.length > 0)
        ? paymentEvidenceMsg.photo[paymentEvidenceMsg.photo.length - 1].file_id
        : null;

      const invoiceDoc = invoiceMsg?.document?.file_id ?? null;
      const paymentDoc = paymentEvidenceMsg?.document?.file_id ?? null;

      try {
        if (invoicePhoto && paymentPhoto) {
          // Both are photos: send TOGETHER as ONE media group (album)
          const caption = combinedConfirmedText.length <= MAX_CAPTION_LENGTH
            ? combinedConfirmedText
            : headerText;
          const album = await api.sendMediaGroup(
            chatId,
            [
              {
                type: 'photo',
                media: invoicePhoto,
                caption,
              },
              {
                type: 'photo',
                media: paymentPhoto,
                caption: paymentEvidenceMsg?.caption || undefined,
              },
            ],
            { message_thread_id: config.confirmedTopicId }
          );
          confirmedMsgId = album[0].message_id;
          if (album[1]) {
            additionalConfirmedMsgIds.push(album[1].message_id);
          }

          // If combined text exceeded caption length, send remaining invoice content as follow-up text message(s)
          if (combinedConfirmedText.length > MAX_CAPTION_LENGTH && originalInvoiceContent) {
            const chunks = splitTextMessage(originalInvoiceContent, MAX_TEXT_LENGTH);
            for (const chunk of chunks) {
              const followUp = await api.sendMessage(chatId, chunk, {
                message_thread_id: config.confirmedTopicId,
              });
              additionalConfirmedMsgIds.push(followUp.message_id);
            }
          }
        } else if (invoiceDoc && paymentDoc) {
          // Both are documents: send TOGETHER as ONE media group
          const caption = combinedConfirmedText.length <= MAX_CAPTION_LENGTH
            ? combinedConfirmedText
            : headerText;
          const album = await api.sendMediaGroup(
            chatId,
            [
              {
                type: 'document',
                media: invoiceDoc,
                caption,
              },
              {
                type: 'document',
                media: paymentDoc,
                caption: paymentEvidenceMsg?.caption || undefined,
              },
            ],
            { message_thread_id: config.confirmedTopicId }
          );
          confirmedMsgId = album[0].message_id;
          if (album[1]) {
            additionalConfirmedMsgIds.push(album[1].message_id);
          }

          if (combinedConfirmedText.length > MAX_CAPTION_LENGTH && originalInvoiceContent) {
            const chunks = splitTextMessage(originalInvoiceContent, MAX_TEXT_LENGTH);
            for (const chunk of chunks) {
              const followUp = await api.sendMessage(chatId, chunk, {
                message_thread_id: config.confirmedTopicId,
              });
              additionalConfirmedMsgIds.push(followUp.message_id);
            }
          }
        } else if (!invoicePhoto && !invoiceDoc) {
          // Plain text invoice: split cleanly if over MAX_TEXT_LENGTH without dropping content
          const chunks = splitTextMessage(combinedConfirmedText, MAX_TEXT_LENGTH);
          const sent = await api.sendMessage(chatId, chunks[0], {
            message_thread_id: config.confirmedTopicId,
          });
          confirmedMsgId = sent.message_id;

          for (const chunk of chunks.slice(1)) {
            const followUp = await api.sendMessage(chatId, chunk, {
              message_thread_id: config.confirmedTopicId,
            });
            additionalConfirmedMsgIds.push(followUp.message_id);
          }

          // If there is payment evidence (photo, doc, or text receipt), copy it into Confirmed
          if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== invoiceMessageId) {
            if (paymentPhoto || paymentDoc) {
              const receiptCaption = userNote
                ? `🧾 Payment Receipt: ${userNote}`
                : '🧾 Payment Receipt';
              const copied = await api.copyMessage(chatId, chatId, paymentEvidenceMsg.message_id, {
                message_thread_id: config.confirmedTopicId,
                caption: receiptCaption,
              });
              additionalConfirmedMsgIds.push(copied.message_id);
            } else {
              const copied = await api.copyMessage(chatId, chatId, paymentEvidenceMsg.message_id, {
                message_thread_id: config.confirmedTopicId,
              });
              additionalConfirmedMsgIds.push(copied.message_id);
            }
          }
        } else {
          // Single media invoice (photo/doc invoice without matched media payment group)
          const caption = combinedConfirmedText.length <= MAX_CAPTION_LENGTH
            ? combinedConfirmedText
            : headerText;
          const copied = await api.copyMessage(chatId, chatId, invoiceMessageId, {
            message_thread_id: config.confirmedTopicId,
            caption,
          });
          confirmedMsgId = copied.message_id;

          // If caption length limit prevented appending original invoice caption, send full content as follow-up text
          if (combinedConfirmedText.length > MAX_CAPTION_LENGTH && originalInvoiceContent) {
            const chunks = splitTextMessage(originalInvoiceContent, MAX_TEXT_LENGTH);
            for (const chunk of chunks) {
              const followUp = await api.sendMessage(chatId, chunk, {
                message_thread_id: config.confirmedTopicId,
              });
              additionalConfirmedMsgIds.push(followUp.message_id);
            }
          }

          // If there is payment evidence (photo, doc, or text receipt) that could not be grouped, copy it to Confirmed
          if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== invoiceMessageId) {
            if (paymentPhoto || paymentDoc) {
              const receiptCaption = userNote
                ? `🧾 Payment Receipt: ${userNote}`
                : '🧾 Payment Receipt';
              const copiedEvidence = await api.copyMessage(chatId, chatId, paymentEvidenceMsg.message_id, {
                message_thread_id: config.confirmedTopicId,
                caption: receiptCaption,
              });
              additionalConfirmedMsgIds.push(copiedEvidence.message_id);
            } else {
              const copiedEvidence = await api.copyMessage(chatId, chatId, paymentEvidenceMsg.message_id, {
                message_thread_id: config.confirmedTopicId,
              });
              additionalConfirmedMsgIds.push(copiedEvidence.message_id);
            }
          }
        }
      } catch (err: unknown) {
        await rollbackAllCreatedMessages();
        return {
          success: false,
          error: `Failed to create confirmation in Confirmed topic: ${(err as Error).message}`,
        };
      }

      const confirmationUrl = buildMessageLink(chatId, confirmedMsgId);

      // ── Phase 2: Record in Pending + DB ────────────────────

      // 1. Copy payment evidence into Pending topic (photos, docs, text receipts)
      if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== invoiceMessageId) {
        try {
          const copied = await api.copyMessage(chatId, chatId, paymentEvidenceMsg.message_id, {
            message_thread_id: config.pendingTopicId,
          });
          pendingReceiptMsgId = copied.message_id;
        } catch (err: unknown) {
          await rollbackAllCreatedMessages();
          return {
            success: false,
            error: `Failed to copy payment evidence to Pending: ${(err as Error).message}`,
          };
        }
      }

      // 2. Create history record in Pending topic
      try {
        const historyText = formatHistoryRecord(
          distributorName,
          transaction.amount,
          transaction.receivedAt,
          paidAt,
          confirmationUrl,
          transaction.id,
          userNote,
          transaction.notes
        );
        const historyMsg = await api.sendMessage(chatId, historyText, {
          message_thread_id: config.pendingTopicId,
        });
        historyMsgId = historyMsg.message_id;
      } catch (err: unknown) {
        await rollbackAllCreatedMessages();
        return {
          success: false,
          error: `Failed to create history record: ${(err as Error).message}`,
        };
      }

      // 3. Update DB — compare-and-swap
      let committed = false;
      try {
        committed = await this.repo.markPaid(
          transaction.id,
          paidAt,
          paymentEvidenceMsg?.message_id ?? commandMessageId,
          confirmedMsgId,
          confirmationUrl,
          historyMsgId
        );
      } catch (dbErr: unknown) {
        // A D1 error or network timeout occurred. Verify whether the database actually committed!
        let verificationSucceeded = false;
        try {
          const verifyTx = await this.repo.findById(transaction.id);
          verificationSucceeded = true;
          if (
            verifyTx &&
            verifyTx.status === 'PAID' &&
            verifyTx.confirmation_message_id === confirmedMsgId
          ) {
            // The write succeeded on the database before the network error/timeout!
            committed = true;
          }
        } catch (verifyErr: unknown) {
          console.error(
            `Verification query also failed after markPaid error for transaction ${transaction.id}:`,
            (verifyErr as Error).message
          );
        }

        if (committed) {
          // Treated as committed — proceed to Phase 3 cleanup
        } else if (!verificationSucceeded) {
          // Both the write and the verification query failed! Commit status is UNCERTAIN.
          console.error(
            `Transaction ${transaction.id} commit status is uncertain. Preserving Telegram confirmation messages.`
          );
          return {
            success: false,
            error: `Database write and verification both failed. Commit status is uncertain; Telegram messages were preserved to prevent data loss. Original error: ${(dbErr as Error).message}`,
          };
        } else {
          // Verification query confirmed row was NOT committed. Clean up orphan messages.
          await rollbackAllCreatedMessages();
          return {
            success: false,
            error: `Database update failed: ${(dbErr as Error).message}`,
          };
        }
      }

      if (!committed) {
        await rollbackAllCreatedMessages();
        return {
          success: false,
          error: 'Transaction was already confirmed by another request.',
        };
      }

      // ── Phase 3: Retain & edit original Pending invoice message ─
      // NEVER delete the invoice message or payment evidence automatically.
      try {
        if (invoiceMsg) {
          const msgType = detectMessageType(invoiceMsg);
          const isMedia = msgType === 'photo' || msgType === 'document' || invoiceMsg.caption !== undefined;
          const currentContent = invoiceMsg.text ?? invoiceMsg.caption ?? '';
          const maxLen = isMedia ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH;
          const noticeResult = appendManualDeletionNotice(currentContent, maxLen);

          if (noticeResult.overflow) {
            // Insufficient room: keep original caption/text intact, remove keyboard
            try {
              await api.editMessageReplyMarkup(chatId, invoiceMessageId, {
                reply_markup: { inline_keyboard: [] },
              });
            } catch {
              /* best effort */
            }
            // Send warning as a separate reply/message
            try {
              await api.sendMessage(chatId, MANUAL_DELETION_NOTICE, {
                message_thread_id: config.pendingTopicId,
                reply_parameters: { message_id: invoiceMessageId },
              });
            } catch (noticeErr: unknown) {
              console.warn(`Failed to send separate warning message: ${(noticeErr as Error).message}`);
            }
          } else {
            // Fits (or notice already present)
            let editSucceeded = false;
            if (isMedia) {
              try {
                await api.editMessageCaption(chatId, invoiceMessageId, {
                  caption: noticeResult.text,
                  reply_markup: { inline_keyboard: [] },
                });
                editSucceeded = true;
              } catch (editErr: unknown) {
                console.warn(`Failed to edit pending invoice caption ${invoiceMessageId}:`, (editErr as Error).message);
              }
            } else {
              try {
                await api.editMessageText(chatId, invoiceMessageId, noticeResult.text, {
                  reply_markup: { inline_keyboard: [] },
                });
                editSucceeded = true;
              } catch (textErr: unknown) {
                // Classify error: only fall back to editMessageCaption if the error reliably
                // indicates absence of editable text (genuine media message)
                if (isNoTextMessageError(textErr)) {
                  try {
                    await api.editMessageCaption(chatId, invoiceMessageId, {
                      caption: noticeResult.text,
                      reply_markup: { inline_keyboard: [] },
                    });
                    editSucceeded = true;
                  } catch (captionErr: unknown) {
                    console.warn(`Failed to edit pending invoice caption fallback ${invoiceMessageId}:`, (captionErr as Error).message);
                  }
                } else {
                  // For network errors, rate limits, server errors, permission failures, or uneditable messages:
                  // Avoid an unnecessary second edit attempt!
                  console.warn(`Failed to edit pending invoice text ${invoiceMessageId} with non-media error, skipping caption edit:`, (textErr as Error).message);
                }
              }
            }

            if (!editSucceeded) {
              // Attempt to remove inline keyboard while keeping original content intact
              try {
                await api.editMessageReplyMarkup(chatId, invoiceMessageId, {
                  reply_markup: { inline_keyboard: [] },
                });
              } catch {
                /* best effort */
              }
              console.warn(`Warning could not be added to original invoice message ${invoiceMessageId}`);
            }
          }
        } else {
          // invoiceMsg was not provided (explicit /paid #INV0001 without reply).
          // Original content cannot be retrieved. NEVER replace the original invoice with only the deletion notice!
          // Preserve the original message, remove its inline keyboard where possible, and send the warning separately.
          try {
            await api.editMessageReplyMarkup(chatId, invoiceMessageId, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch (markupErr: unknown) {
            console.warn(`Could not remove inline keyboard for invoice ${invoiceMessageId}:`, (markupErr as Error).message);
          }

          try {
            await api.sendMessage(chatId, MANUAL_DELETION_NOTICE, {
              message_thread_id: config.pendingTopicId,
              reply_parameters: { message_id: invoiceMessageId },
            });
          } catch (sendErr: unknown) {
            console.warn(`Could not send separate deletion warning for invoice ${invoiceMessageId}:`, (sendErr as Error).message);
          }
        }
      } catch (err: unknown) {
        console.warn(`Phase 3 warning handling error for message ${invoiceMessageId}:`, (err as Error).message);
      }

      // Delete pure payment command message (/paid) from Pending only if it contains no receipt or note
      if (
        commandMessageId &&
        (!paymentEvidenceMsg || commandMessageId !== paymentEvidenceMsg.message_id) &&
        commandMessageId !== invoiceMessageId &&
        !userNote
      ) {
        try {
          await api.deleteMessage(chatId, commandMessageId);
        } catch (err: unknown) {
          console.warn(`Failed to delete command message ${commandMessageId}:`, (err as Error).message);
        }
      }

      return {
        success: true,
        confirmationUrl,
        confirmedMessageId: confirmedMsgId,
        pendingReceiptMessageId: pendingReceiptMsgId,
        historyMessageId: historyMsgId,
      };
    } finally {
      processingLocks.delete(transaction.id);
    }
  }
}
