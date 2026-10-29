import type { Api } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { TransactionRepository } from './transaction.repository';
import { getConfig, type Config } from '../config/config';
import {
  buildMessageLink,
  detectMessageType,
  extractMediaInfo,
  splitOriginalAndMetadata,
  composeMessageText,
  formatConfirmedInvoiceContent,
  splitTextMessage,
  MAX_CAPTION_LENGTH,
  MAX_TEXT_LENGTH,
  isNoTextMessageError,
} from '../bot/helpers/telegram.helpers';
import {
  formatConfirmedHeader,
  formatHistoryRecord,
  buildMetadataBlock,
  buildUnifiedInvoiceCaption,
  buildItemizedTextInvoiceMessage,
  isItemizedInvoiceText,
  extractItemizedTextFromMessage,
  computeInvoiceFinancialSummary,
  stripDuplicateTotalLines,
  formatInvoiceId,
  formatCleanedPendingInvoiceCaption,
  formatSupersededInvoiceCaption,
  formatAccountControlMessage,
  formatReceiptCaption,
  parsePaidCommandPayload,
  formatAmount,
  nowISO,
} from '../bot/helpers/format.helpers';
import { copyAccountKeyboard } from '../bot/keyboards/keyboards';
import type {
  Transaction,
  TransactionRow,
  DistributorSnapshot,
  ConfirmationResult,
  InvoiceNote,
  TransactionStatus,
  InvoiceType,
} from '../types';

export interface ExecuteAddAmountParams {
  api: Api;
  chatId: number | string;
  pendingTopicId: number;
  repliedMessage: Message;
  addMessage: Message;
  transaction: Transaction;
  addedAmount: number;
  optionalNote?: string;
}

export type ExecuteAddAmountResult =
  | {
      success: true;
      transactionId: number;
      newTotalAmount: number;
      newInvoiceMessageId: number;
      updatedInvoiceUrl: string;
      supersededInvoiceMessageId?: number;
    }
  | {
      success: false;
      error: string;
      failedStep:
        | 'resolve_and_validate'
        | 'create_new_invoice'
        | 'save_transaction'
        | 'edit_original_invoice'
        | 'delete_add_message';
    };

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
      initialAmount: row.initial_amount ?? null,
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
      accountControlMessageId: row.account_control_message_id ?? null,
      historicalControlMessageIds: row.historical_control_message_ids
        ? JSON.parse(row.historical_control_message_ids)
        : [],
      supersededMessageIds: row.superseded_message_ids
        ? JSON.parse(row.superseded_message_ids)
        : [],
      notes: row.notes ? JSON.parse(row.notes) : [],
      mediaFileId: row.media_file_id ?? null,
      mediaType: row.media_type ?? null,
      invoiceType: (row.invoice_type as InvoiceType) ?? null,
      originalText: row.original_text ?? null,
      createdAt: row.created_at,
    };
  }

  // ─── Registration ─────────────────────────────────────────

  async registerTransaction(
    chatId: string,
    topicId: number,
    messageId: number,
    notes?: InvoiceNote[],
    mediaFileId?: string | null,
    mediaType?: string | null,
    invoiceType?: InvoiceType | null,
    originalText?: string | null
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
      notes && notes.length > 0 ? JSON.stringify(notes) : undefined,
      mediaFileId ?? null,
      mediaType ?? null,
      invoiceType ?? null,
      originalText ?? null
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
    mediaFileId?: string | null;
    mediaType?: string | null;
    invoiceType?: InvoiceType | null;
    originalText?: string | null;
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
      mediaFileId: params.mediaFileId ?? null,
      mediaType: params.mediaType ?? null,
      invoiceType: params.invoiceType ?? null,
      originalText: params.originalText ?? null,
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
   * Authoritative invoice caption builder that fetches durable event history
   * (registration, additions, payments with receipt URLs) from the database
   * and formats a consistent, append-only invoice caption.
   */
  async renderInvoiceCaptionForTransaction(
    transactionId: number,
    rawContent?: string,
    maxLen: number = MAX_CAPTION_LENGTH
  ): Promise<string> {
    const tx = await this.findById(transactionId);
    if (!tx) {
      return '';
    }

    const additions = await this.repo.getAdditions(tx.id);
    const payments = await this.repo.getPayments(tx.id);

    const additionsList = additions.map((a) => ({
      amount: a.amount,
      addedAt: a.added_at,
      note: a.note,
    }));

    const paymentsList = payments.map((p) => ({
      amount: p.amount,
      paidAt: p.paid_at,
      note: p.note,
      receiptUrl: p.receipt_url,
    }));

    const totalAdditions = additionsList.reduce((sum, a) => sum + a.amount, 0);
    const initialAmount =
      tx.initialAmount ??
      (tx.amount !== null ? Math.max(0, tx.amount - totalAdditions) : null);

    const hasAnyMedia =
      Boolean(tx.mediaFileId || tx.mediaType) ||
      additions.some((a) => Boolean(a.media_file_id || a.media_type));

    const isItemized =
      !hasAnyMedia &&
      (tx.invoiceType === 'ITEMIZED_TEXT' ||
        Boolean(tx.originalText) ||
        Boolean(rawContent && isItemizedInvoiceText(rawContent)));

    if (isItemized) {
      let origText = tx.originalText;
      if (!origText && rawContent) {
        origText = extractItemizedTextFromMessage(rawContent);
        if (origText) {
          await this.repo.updateOriginalText(tx.id, origText, 'ITEMIZED_TEXT');
          tx.originalText = origText;
          tx.invoiceType = 'ITEMIZED_TEXT';
        }
      }

      return buildItemizedTextInvoiceMessage({
        invoiceId: tx.id,
        distributor: tx.distributorSnapshot,
        originalText: origText || rawContent || '',
        receivedAt: tx.receivedAt,
        initialAmount,
        currentAmount: tx.amount,
        additions: additionsList,
        payments: paymentsList,
        notes: tx.notes,
        hasSeparateAccountControlMessage: Boolean(tx.accountControlMessageId),
      });
    }

    let cleanItems = '';
    let isMeat = false;
    if (rawContent) {
      const { original } = splitOriginalAndMetadata(rawContent);
      cleanItems = stripDuplicateTotalLines(original);
      if (/MEAT INVOICE/i.test(rawContent)) {
        isMeat = true;
      }
    }

    return buildUnifiedInvoiceCaption({
      invoiceId: tx.id,
      title: isMeat ? '🥩 MEAT INVOICE' : '🧾 INVOICE',
      distributor: tx.distributorSnapshot,
      itemsBreakdown: cleanItems,
      receivedAt: tx.receivedAt,
      initialAmount,
      currentAmount: tx.amount,
      additions: additionsList,
      payments: paymentsList,
      notes: tx.notes,
      maxCaptionLength: hasAnyMedia ? maxLen : MAX_TEXT_LENGTH,
      hasSeparateAccountControlMessage: Boolean(tx.accountControlMessageId),
    });
  }

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
    const msgType = detectMessageType(repliedMessage);
    const maxLen = msgType === 'text' ? MAX_TEXT_LENGTH : MAX_CAPTION_LENGTH;
    const currentText = repliedMessage.text ?? repliedMessage.caption ?? '';

    if (amount !== null && transaction.amount !== amount) {
      await this.setAmount(transaction.id, amount);
      transaction.amount = amount;
    }
    if (distributor && !transaction.distributorSnapshot) {
      transaction.distributorSnapshot = distributor;
    }

    const safeCaption = await this.renderInvoiceCaptionForTransaction(
      transaction.id,
      currentText,
      maxLen
    );

    const dist = distributor || transaction.distributorSnapshot;
    const effectiveKeyboard =
      keyboard || (dist?.accountNumber ? copyAccountKeyboard(dist.accountNumber) : undefined);

    // ── If the bot already owns the message, just edit it ────
    if (transaction.metadataMessageId) {
      try {
        const editMarkup = !transaction.accountControlMessageId ? effectiveKeyboard : undefined;
        if (msgType === 'text') {
          await api.editMessageText(chatId, transaction.metadataMessageId, safeCaption, {
            reply_markup: editMarkup,
          });
        } else {
          await api.editMessageCaption(chatId, transaction.metadataMessageId, {
            caption: safeCaption,
            reply_markup: editMarkup,
          });
        }
        return { botMessageId: transaction.metadataMessageId };
      } catch (err: unknown) {
        console.warn('Failed to edit bot message, will re-send:', (err as Error).message);
        // Fall through to re-send
      }
    }

    // ── Re-send as bot if direct edit failed or message is user-owned ────
    let botMsg: Message;
    try {
      const sendMarkup = !transaction.accountControlMessageId ? effectiveKeyboard : undefined;
      switch (msgType) {
        case 'photo': {
          // Get the highest-resolution photo
          const photos = repliedMessage.photo!;
          const fileId = photos[photos.length - 1].file_id;
          botMsg = await api.sendPhoto(chatId, fileId, {
            caption: safeCaption,
            message_thread_id: topicId,
            reply_markup: sendMarkup,
          });
          break;
        }
        case 'document': {
          const fileId = repliedMessage.document!.file_id;
          botMsg = await api.sendDocument(chatId, fileId, {
            caption: safeCaption,
            message_thread_id: topicId,
            reply_markup: sendMarkup,
          });
          break;
        }
        case 'text':
        default: {
          botMsg = await api.sendMessage(chatId, safeCaption, {
            message_thread_id: topicId,
            reply_markup: sendMarkup,
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
    transaction.metadataMessageId = botMsg.message_id;

    // Persist media file id and media type if not already stored
    let savedFileId: string | null = null;
    if (msgType === 'photo' && repliedMessage.photo && repliedMessage.photo.length > 0) {
      savedFileId = repliedMessage.photo[repliedMessage.photo.length - 1].file_id;
    } else if (msgType === 'document' && repliedMessage.document) {
      savedFileId = repliedMessage.document.file_id;
    }
    if (savedFileId && (!transaction.mediaFileId || !transaction.mediaType)) {
      await this.repo.updateMedia(transaction.id, savedFileId, msgType);
      transaction.mediaFileId = savedFileId;
      transaction.mediaType = msgType;
    }

    return { botMessageId: botMsg.message_id };
  }

  async updateTransactionMedia(
    id: number,
    mediaFileId: string | null,
    mediaType: string | null
  ): Promise<void> {
    return this.repo.updateMedia(id, mediaFileId, mediaType);
  }

  async updateOriginalText(
    id: number,
    originalText: string,
    invoiceType?: InvoiceType | null
  ): Promise<void> {
    await this.repo.updateOriginalText(id, originalText, invoiceType);
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
    paymentEvidenceMsg?: Message,
    paymentAmount?: number | null,
    userNote?: string | null
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

    // ── Check for duplicate/retried update (Idempotency) ────────────
    const paymentMsgId = paymentEvidenceMsg?.message_id ?? commandMessageId;
    if (paymentMsgId && typeof this.repo.findPaymentByMessageId === 'function') {
      const existingPayment = await this.repo.findPaymentByMessageId(transaction.id, paymentMsgId);
      if (existingPayment) {
        const totalPaid =
          typeof this.repo.getTotalPaid === 'function'
            ? await this.repo.getTotalPaid(transaction.id)
            : existingPayment.amount;
        const remaining =
          transaction.amount !== null ? Math.max(0, transaction.amount - totalPaid) : 0;
        return {
          success: true,
          confirmationUrl:
            transaction.confirmationUrl ??
            (transaction.confirmationMessageId
              ? buildMessageLink(chatId, transaction.confirmationMessageId)
              : undefined),
          confirmedMessageId: transaction.confirmationMessageId ?? undefined,
          historyMessageId: transaction.historyMessageId ?? undefined,
          status: transaction.status,
          paidAmount: existingPayment.amount,
          cumulativePaid: totalPaid,
          remainingBalance: remaining,
        };
      }
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
    let fallbackHistoryMsgId: number | undefined;

    // Helper for rolling back all created messages in Confirmed topic
    const rollbackAllCreatedMessages = async () => {
      if (fallbackHistoryMsgId) {
        try {
          await api.deleteMessage(chatId, fallbackHistoryMsgId);
        } catch {
          /* best effort */
        }
      }
      for (const id of additionalConfirmedMsgIds) {
        try {
          await api.deleteMessage(chatId, id);
        } catch {
          /* best effort */
        }
      }
      if (confirmedMsgId) {
        try {
          await api.deleteMessage(chatId, confirmedMsgId);
        } catch {
          /* best effort */
        }
      }
    };

    try {
      const paidAt = nowISO();
      const distributorName = transaction.distributorSnapshot?.name ?? null;

      // Determine which message represents the invoice in Pending
      const invoiceMessageId = transaction.metadataMessageId ?? transaction.originalMessageId;

      // Extract payment amount & note from message if not supplied explicitly
      const rawText = (paymentEvidenceMsg?.caption ?? paymentEvidenceMsg?.text ?? '').trim();
      const parsedCmd = parsePaidCommandPayload(rawText);
      const effectivePaymentAmount =
        paymentAmount !== undefined && paymentAmount !== null
          ? paymentAmount
          : parsedCmd.paymentAmount;
      const effectiveNote =
        userNote !== undefined && userNote !== null
          ? userNote
          : (parsedCmd.userNote || undefined);

      // ── Accounting calculations ──────────────────────────────
      const previousTotalPaid =
        typeof this.repo.getTotalPaid === 'function'
          ? await this.repo.getTotalPaid(transaction.id)
          : 0;
      let payAmount: number;
      if (
        effectivePaymentAmount !== null &&
        effectivePaymentAmount !== undefined &&
        effectivePaymentAmount > 0
      ) {
        payAmount = effectivePaymentAmount;
      } else {
        // Pay remaining balance in full
        payAmount =
          transaction.amount !== null
            ? Math.max(0, transaction.amount - previousTotalPaid)
            : 0;
      }

      const cumulativePaid = previousTotalPaid + payAmount;
      const remainingBalance =
        transaction.amount !== null ? Math.max(0, transaction.amount - cumulativePaid) : 0;
      const newStatus: TransactionStatus =
        transaction.amount !== null && remainingBalance <= 0
          ? 'PAID'
          : transaction.amount === null && effectivePaymentAmount === null
          ? 'PAID'
          : 'PARTIALLY_PAID';

      // Get additions breakdown if available
      let additionsTotal = 0;
      if (typeof this.repo.getAdditions === 'function') {
        const additions = await this.repo.getAdditions(transaction.id);
        additionsTotal = additions.reduce((sum, a) => sum + a.amount, 0);
      }
      const originalAmount =
        transaction.initialAmount ??
        (transaction.amount !== null ? Math.max(0, transaction.amount - additionsTotal) : null);

      // Distributor bank details
      let bankDetails: string | null = null;
      if (
        transaction.distributorSnapshot?.bankName ||
        transaction.distributorSnapshot?.accountNumber
      ) {
        bankDetails = [
          transaction.distributorSnapshot?.bankName,
          transaction.distributorSnapshot?.accountNumber,
        ]
          .filter(Boolean)
          .join(' ');
      }
      const accountHolder = transaction.distributorSnapshot?.accountHolder ?? null;

      // Extract file IDs from invoice and payment media
      const invoicePhoto =
        invoiceMsg?.photo && invoiceMsg.photo.length > 0
          ? invoiceMsg.photo[invoiceMsg.photo.length - 1].file_id
          : null;
      const invoiceDoc = invoiceMsg?.document?.file_id ?? null;

      // ── Phase 1: Create confirmation in Confirmed topic ────
      const isSubsequentPayment = previousTotalPaid > 0 || !!transaction.confirmationMessageId;
      let effectiveReceiptMsgId: number | null = null;
      let confirmedInvoiceCopyMsgId: number | null = null;

      try {
        // Step 1: Copy original invoice media into Confirmed topic (on first payment only)
        const hasInvoiceMedia = Boolean(
          invoicePhoto ||
          invoiceDoc ||
          (transaction.mediaFileId && transaction.mediaType !== 'text') ||
          (invoiceMsg && (invoiceMsg.photo || invoiceMsg.document))
        );
        if (!isSubsequentPayment && invoiceMessageId && hasInvoiceMedia) {
          try {
            const copiedInvoice = await api.copyMessage(chatId, chatId, invoiceMessageId, {
              message_thread_id: config.confirmedTopicId,
            });
            confirmedInvoiceCopyMsgId = copiedInvoice.message_id;
            additionalConfirmedMsgIds.push(copiedInvoice.message_id);
          } catch {
            // Best-effort fallback if copyMessage fails (e.g. if original message was deleted)
            if (invoicePhoto) {
              const sent = await api.sendPhoto(chatId, invoicePhoto, {
                message_thread_id: config.confirmedTopicId,
              });
              confirmedInvoiceCopyMsgId = sent.message_id;
              additionalConfirmedMsgIds.push(sent.message_id);
            } else if (invoiceDoc) {
              const sent = await api.sendDocument(chatId, invoiceDoc, {
                message_thread_id: config.confirmedTopicId,
              });
              confirmedInvoiceCopyMsgId = sent.message_id;
              additionalConfirmedMsgIds.push(sent.message_id);
            }
          }
        }

        // Step 2: Copy payment receipt media into Confirmed as a separate media message, preserving original content
        const replyToTargetId = isSubsequentPayment
          ? (transaction.confirmationMessageId ?? undefined)
          : (confirmedInvoiceCopyMsgId ?? undefined);

        if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== invoiceMessageId) {
          const hasEvidenceMedia =
            (paymentEvidenceMsg.photo && paymentEvidenceMsg.photo.length > 0) ||
            !!paymentEvidenceMsg.document;
          const isDistinctReceiptMsg =
            paymentEvidenceMsg.message_id !== commandMessageId &&
            Boolean(paymentEvidenceMsg.text || paymentEvidenceMsg.caption);

          if (hasEvidenceMedia || isDistinctReceiptMsg) {
            const copiedEvidence = await api.copyMessage(
              chatId,
              chatId,
              paymentEvidenceMsg.message_id,
              {
                message_thread_id: config.confirmedTopicId,
                ...(replyToTargetId ? { reply_to_message_id: replyToTargetId } : {}),
              }
            );
            effectiveReceiptMsgId = copiedEvidence.message_id;
            additionalConfirmedMsgIds.push(copiedEvidence.message_id);
          }
        }

        // Step 3: Determine the clickable receipt link
        const receiptUrl = effectiveReceiptMsgId
          ? buildMessageLink(chatId, effectiveReceiptMsgId)
          : undefined;

        // Step 4: Build complete visible confirmation text
        const confirmationText = formatConfirmedHeader(
          distributorName,
          transaction.amount,
          transaction.receivedAt,
          paidAt,
          transaction.id,
          effectiveNote,
          transaction.notes,
          {
            status: newStatus,
            paymentAmount: payAmount,
            cumulativePaid,
            remainingBalance,
            originalAmount,
            additionsTotal,
            bankDetails,
            accountHolder,
            receiptUrl,
          }
        );

        // For plain text invoices, combine with original invoice content
        const invoiceRawText = invoiceMsg?.text ?? invoiceMsg?.caption ?? '';
        const { original: extractedOriginal } = splitOriginalAndMetadata(invoiceRawText);
        const originalInvoiceContent =
          transaction.originalText ||
          (extractedOriginal.trim() || invoiceRawText.trim());
        const isMediaInvoice = Boolean(invoicePhoto || invoiceDoc);
        let fullConfirmationText = confirmationText;
        if (!isMediaInvoice && originalInvoiceContent) {
          fullConfirmationText = formatConfirmedInvoiceContent(
            confirmationText,
            originalInvoiceContent
          );
        }

        // Step 5: Send a separate, ordinary text message to the Confirmed topic (splitting if necessary)
        const chunks = splitTextMessage(fullConfirmationText, MAX_TEXT_LENGTH);
        const sentConfirmation = await api.sendMessage(chatId, chunks[0], {
          message_thread_id: config.confirmedTopicId,
          ...(replyToTargetId ? { reply_to_message_id: replyToTargetId } : {}),
        });
        confirmedMsgId = sentConfirmation.message_id;

        for (const chunk of chunks.slice(1)) {
          const followUp = await api.sendMessage(chatId, chunk, {
            message_thread_id: config.confirmedTopicId,
          });
          additionalConfirmedMsgIds.push(followUp.message_id);
        }
      } catch (err: unknown) {
        await rollbackAllCreatedMessages();
        return {
          success: false,
          error: `Failed to create confirmation in Confirmed topic: ${(err as Error).message}`,
        };
      }

      if (!effectiveReceiptMsgId) {
        effectiveReceiptMsgId = confirmedMsgId;
      }

      const confirmationUrl = buildMessageLink(chatId, confirmedMsgId);
      const receiptUrl = effectiveReceiptMsgId
        ? buildMessageLink(chatId, effectiveReceiptMsgId)
        : confirmationUrl;

      // ── Phase 2: Record Payment in DB ────────────────────
      if (typeof this.repo.recordPayment === 'function') {
        await this.repo.recordPayment(
          transaction.id,
          payAmount,
          paidAt,
          paymentMsgId,
          confirmedMsgId,
          null,
          effectiveNote,
          effectiveReceiptMsgId,
          receiptUrl,
          cumulativePaid,
          remainingBalance
        );
      }

      let committed = false;
      const primaryConfirmedMsgId = transaction.confirmationMessageId ?? confirmedMsgId;
      const primaryConfirmationUrl = buildMessageLink(chatId, primaryConfirmedMsgId);
      try {
        if (typeof this.repo.updateTransactionPaymentStatus === 'function') {
          committed = await this.repo.updateTransactionPaymentStatus({
            id: transaction.id,
            status: newStatus,
            paidAt,
            paymentMessageId: paymentMsgId,
            confirmationMessageId: primaryConfirmedMsgId,
            confirmationUrl: primaryConfirmationUrl,
            historyMessageId: null,
            allowFromStatuses: ['PENDING', 'PARTIALLY_PAID'],
          });
        } else {
          committed = await this.repo.markPaid(
            transaction.id,
            paidAt,
            paymentMsgId,
            primaryConfirmedMsgId,
            primaryConfirmationUrl,
            0
          );
        }
      } catch (dbErr: unknown) {
        // D1 or network timeout verification
        let verificationSucceeded = false;
        try {
          const verifyTx = await this.repo.findById(transaction.id);
          verificationSucceeded = true;
          if (
            verifyTx &&
            verifyTx.status === newStatus &&
            verifyTx.confirmation_message_id === confirmedMsgId
          ) {
            committed = true;
          }
        } catch (verifyErr: unknown) {
          console.error(
            `Verification query also failed after markPaid error for transaction ${transaction.id}:`,
            (verifyErr as Error).message
          );
        }

        if (committed) {
          // Treated as committed
        } else if (!verificationSucceeded) {
          return {
            success: false,
            error: `Database write and verification both failed. Commit status is uncertain; Telegram messages were preserved to prevent data loss. Original error: ${(dbErr as Error).message}`,
          };
        } else {
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

      // ── Phase 3: Update Pending Topic & Cleanup ─────────
      try {
        if (invoiceMsg) {
          const msgType = detectMessageType(invoiceMsg);
          const isMedia =
            msgType === 'photo' || msgType === 'document' || invoiceMsg.caption !== undefined;

          if (newStatus === 'PAID') {
            // FULL PAYMENT (Bug 2):
            // Replace caption with ONLY invoice ID + status text. Remove unwanted manual-deletion text.
            const cleanedCaption = formatCleanedPendingInvoiceCaption(
              transaction.id,
              'PAID',
              confirmationUrl
            );

            let editSucceeded = false;
            if (isMedia) {
              try {
                await api.editMessageCaption(chatId, invoiceMessageId, {
                  caption: cleanedCaption,
                  reply_markup: { inline_keyboard: [] },
                });
                editSucceeded = true;
              } catch (editErr: unknown) {
                console.warn(
                  `Failed to edit pending invoice caption ${invoiceMessageId}:`,
                  (editErr as Error).message
                );
              }
            } else {
              try {
                await api.editMessageText(chatId, invoiceMessageId, cleanedCaption, {
                  reply_markup: { inline_keyboard: [] },
                });
                editSucceeded = true;
              } catch (textErr: unknown) {
                if (isNoTextMessageError(textErr)) {
                  try {
                    await api.editMessageCaption(chatId, invoiceMessageId, {
                      caption: cleanedCaption,
                      reply_markup: { inline_keyboard: [] },
                    });
                    editSucceeded = true;
                  } catch (captionErr: unknown) {
                    console.warn(
                      `Failed to edit pending invoice caption fallback ${invoiceMessageId}:`,
                      (captionErr as Error).message
                    );
                  }
                } else {
                  console.warn(
                    `Failed to edit pending invoice text ${invoiceMessageId}:`,
                    (textErr as Error).message
                  );
                }
              }
            }

            if (!editSucceeded) {
              // Best effort: remove keyboard
              try {
                await api.editMessageReplyMarkup(chatId, invoiceMessageId, {
                  reply_markup: { inline_keyboard: [] },
                });
              } catch {
                /* best effort */
              }
            }

            // Clean up disposable account-control messages from Pending
            if (transaction.accountControlMessageId) {
              try {
                await api.deleteMessage(chatId, transaction.accountControlMessageId);
                await this.repo.updateAccountControlMessageId(transaction.id, null);
                transaction.accountControlMessageId = null;
              } catch (delErr: unknown) {
                console.warn(
                  `Failed to delete account control message ${transaction.accountControlMessageId}:`,
                  (delErr as Error).message
                );
              }
            }
            if (transaction.historicalControlMessageIds && transaction.historicalControlMessageIds.length > 0) {
              for (const histId of transaction.historicalControlMessageIds) {
                try {
                  await api.deleteMessage(chatId, histId);
                } catch {
                  /* ignore */
                }
              }
            }
          } else {
            // PARTIAL PAYMENT:
            // Update display to reflect partial payment and remaining balance
            const currentCaption = invoiceMsg.text ?? invoiceMsg.caption ?? '';
            const newContent = await this.renderInvoiceCaptionForTransaction(
              transaction.id,
              currentCaption,
              isMedia ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH
            );

            const pendingKeyboard =
              !transaction.accountControlMessageId && transaction.distributorSnapshot?.accountNumber
                ? copyAccountKeyboard(transaction.distributorSnapshot.accountNumber)
                : undefined;

            if (isMedia) {
              try {
                await api.editMessageCaption(chatId, invoiceMessageId, {
                  caption: newContent,
                  reply_markup: pendingKeyboard,
                });
              } catch (editErr: unknown) {
                console.warn(
                  `Failed to edit pending invoice caption for partial payment:`,
                  (editErr as Error).message
                );
              }
            } else {
              try {
                await api.editMessageText(
                  chatId,
                  invoiceMessageId,
                  newContent,
                  {
                    reply_markup: pendingKeyboard,
                  }
                );
              } catch (textErr: unknown) {
                console.warn(
                  `Failed to edit pending invoice text for partial payment:`,
                  (textErr as Error).message
                );
              }
            }
          }
        } else {
          // invoiceMsg was not provided (standalone /paid #INV0001 without reply).
          // Remove inline keyboard from pending invoice
          try {
            await api.editMessageReplyMarkup(chatId, invoiceMessageId, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            /* best effort */
          }

          // Post a single clear history record into Pending topic
          try {
            const historyText = formatHistoryRecord(
              distributorName,
              transaction.amount,
              transaction.receivedAt,
              paidAt,
              confirmationUrl,
              transaction.id,
              effectiveNote,
              transaction.notes,
              {
                status: newStatus,
                paymentAmount: payAmount,
                cumulativePaid,
                remainingBalance,
              }
            );
            const sentHistory = await api.sendMessage(chatId, historyText, {
              message_thread_id: config.pendingTopicId,
            });
            fallbackHistoryMsgId = sentHistory.message_id;
          } catch (sendErr: unknown) {
            console.warn(`Failed to send history record: ${(sendErr as Error).message}`);
          }
        }
      } catch (err: unknown) {
        console.warn(
          `Phase 3 message display update error for message ${invoiceMessageId}:`,
          (err as Error).message
        );
      }

      // Cleanup receipt and command messages from Pending (Bug 3)
      // Original receipt message in Pending must be processed once and cleaned up after Confirmed copy succeeds
      if (paymentEvidenceMsg && paymentEvidenceMsg.message_id !== invoiceMessageId) {
        try {
          await api.deleteMessage(chatId, paymentEvidenceMsg.message_id);
        } catch (err: unknown) {
          console.warn(
            `Failed to delete receipt message ${paymentEvidenceMsg.message_id} from Pending:`,
            (err as Error).message
          );
        }
      }

      if (
        commandMessageId &&
        commandMessageId !== invoiceMessageId &&
        (!paymentEvidenceMsg || commandMessageId !== paymentEvidenceMsg.message_id)
      ) {
        try {
          await api.deleteMessage(chatId, commandMessageId);
        } catch (err: unknown) {
          console.warn(
            `Failed to delete command message ${commandMessageId}:`,
            (err as Error).message
          );
        }
      }

      return {
        success: true,
        confirmationUrl,
        confirmedMessageId: confirmedMsgId,
        historyMessageId: fallbackHistoryMsgId,
        status: newStatus,
        paidAmount: payAmount,
        cumulativePaid,
        remainingBalance,
      };
    } finally {
      processingLocks.delete(transaction.id);
    }
  }

  /**
   * Executes the /add amount workflow when an admin replies to an invoice message
   * with new media and /add AMOUNT.
   *
   * Ordered and failure-safe:
   * 1. Resolves and validates amount & status.
   * 2. Preserves original invoice media and receivedAt timestamp.
   * 3. Creates a new updated invoice record/message immediately (combining media where Telegram permits).
   * 4. Updates transaction amount, appends addition record, and preserves existing payment ledger.
   * 5. Edits original invoice message: removes keyboard, sets superseded caption with link and warning.
   * 6. Deletes admin's /add message after all operations succeed.
   * 7. Preserves source media and returns exact failed step if any error occurs.
   */
  async executeAddAmount(params: ExecuteAddAmountParams): Promise<ExecuteAddAmountResult> {
    const {
      api,
      chatId,
      pendingTopicId,
      repliedMessage,
      addMessage,
      transaction,
      addedAmount,
      optionalNote,
    } = params;

    // 1. Resolve & validate
    if (transaction.status === 'PAID') {
      return {
        success: false,
        error: 'This transaction has already been paid in full.',
        failedStep: 'resolve_and_validate',
      };
    }

    if (addedAmount <= 0) {
      return {
        success: false,
        error: 'Invalid added amount.',
        failedStep: 'resolve_and_validate',
      };
    }

    // Idempotency: avoid duplicate additions if Telegram retries the update
    const existingAddition = await this.repo.findAdditionByMessageId(
      transaction.id,
      addMessage.message_id
    );
    if (existingAddition) {
      const activeMsgId = transaction.metadataMessageId ?? addMessage.message_id;
      return {
        success: true,
        transactionId: transaction.id,
        newTotalAmount: transaction.amount ?? 0,
        newInvoiceMessageId: activeMsgId,
        updatedInvoiceUrl: buildMessageLink(chatId, activeMsgId),
        supersededInvoiceMessageId: transaction.originalMessageId,
      };
    }

    // Isolate lock
    if (processingLocks.has(transaction.id)) {
      return {
        success: false,
        error: 'This transaction is already being updated. Please wait.',
        failedStep: 'resolve_and_validate',
      };
    }
    processingLocks.add(transaction.id);

    try {
      // 2. Fetch history and calculate totals
      const previousAdditions = await this.repo.getAdditions(transaction.id);
      const previousPayments = await this.repo.getPayments(transaction.id);
      const totalPreviousAdditions = previousAdditions.reduce((sum, a) => sum + a.amount, 0);
      const initialAmount =
        transaction.initialAmount ??
        (transaction.amount !== null ? Math.max(0, transaction.amount - totalPreviousAdditions) : 0);
      const newTotalAmount = (transaction.amount ?? 0) + addedAmount;
      const now = nowISO();

      const additionsList = [
        ...previousAdditions.map((a) => ({
          amount: a.amount,
          addedAt: a.added_at,
          note: a.note,
        })),
        { amount: addedAmount, addedAt: now, note: optionalNote },
      ];

      const paymentsList = previousPayments.map((p) => ({
        amount: p.amount,
        paidAt: p.paid_at,
        note: p.note,
        receiptUrl: p.receipt_url,
      }));

      // 3. Extract media from replied and add messages
      const repliedPhoto =
        repliedMessage.photo && repliedMessage.photo.length > 0
          ? repliedMessage.photo[repliedMessage.photo.length - 1].file_id
          : null;
      const repliedDoc = repliedMessage.document?.file_id ?? null;

      const addPhoto =
        addMessage.photo && addMessage.photo.length > 0
          ? addMessage.photo[addMessage.photo.length - 1].file_id
          : null;
      const addDoc = addMessage.document?.file_id ?? null;

      // Ensure original invoice media identity is preserved and persisted
      let originalMediaFileId = transaction.mediaFileId;
      let originalMediaType = transaction.mediaType;

      if (!originalMediaFileId || !originalMediaType) {
        const repliedMedia = extractMediaInfo(repliedMessage);
        if (repliedMedia.mediaFileId) {
          originalMediaFileId = repliedMedia.mediaFileId;
          originalMediaType = repliedMedia.mediaType;
          await this.repo.updateMedia(transaction.id, originalMediaFileId, originalMediaType);
          transaction.mediaFileId = originalMediaFileId;
          transaction.mediaType = originalMediaType;
        }
      }

      const hasAddedMedia = Boolean(addPhoto || addDoc);
      const isMedia =
        originalMediaType === 'photo' ||
        originalMediaType === 'document' ||
        Boolean(repliedMessage.photo || repliedMessage.document);

      // Compose caption
      const repliedText = repliedMessage.text ?? repliedMessage.caption ?? '';
      const isItemized =
        transaction.invoiceType === 'ITEMIZED_TEXT' ||
        Boolean(transaction.originalText) ||
        (!isMedia && isItemizedInvoiceText(repliedText));

      let safeCaption: string;

      if (isItemized && !hasAddedMedia) {
        let origText = transaction.originalText;
        if (!origText) {
          origText = extractItemizedTextFromMessage(repliedText);
          if (origText) {
            await this.repo.updateOriginalText(transaction.id, origText, 'ITEMIZED_TEXT');
            transaction.originalText = origText;
            transaction.invoiceType = 'ITEMIZED_TEXT';
          }
        }

        safeCaption = buildItemizedTextInvoiceMessage({
          invoiceId: transaction.id,
          distributor: transaction.distributorSnapshot,
          originalText: origText || repliedText,
          receivedAt: transaction.receivedAt,
          initialAmount,
          currentAmount: newTotalAmount,
          additions: additionsList,
          payments: paymentsList,
          notes: transaction.notes,
          hasSeparateAccountControlMessage: false,
        });
      } else {
        const { original } = splitOriginalAndMetadata(repliedText);
        const cleanItems = stripDuplicateTotalLines(original);
        const isMeat = /MEAT INVOICE/i.test(repliedText);

        safeCaption = buildUnifiedInvoiceCaption({
          invoiceId: transaction.id,
          title: isMeat ? '🥩 MEAT INVOICE' : '🧾 INVOICE',
          distributor: transaction.distributorSnapshot,
          itemsBreakdown: cleanItems,
          receivedAt: transaction.receivedAt,
          initialAmount,
          currentAmount: newTotalAmount,
          additions: additionsList,
          payments: paymentsList,
          notes: transaction.notes,
          maxCaptionLength: isMedia ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH,
          hasSeparateAccountControlMessage: hasAddedMedia ? true : Boolean(transaction.accountControlMessageId),
        });
      }

      const targetMessageId = transaction.metadataMessageId ?? repliedMessage.message_id;
      const keyboard = transaction.distributorSnapshot?.accountNumber
        ? copyAccountKeyboard(transaction.distributorSnapshot.accountNumber)
        : undefined;

      let newInvoiceMsg: Message;

      if (hasAddedMedia) {
        // ── Case A: /add includes new invoice media ────────────────
        // Collect all invoice media in chronological order:
        // 1. Original invoice media (from registration)
        // 2. All previous addition media (from earlier /add commands)
        // 3. Newly added media from this /add command
        interface InvoiceMediaItem {
          fileId: string;
          type: 'photo' | 'document';
        }

        const mediaItems: InvoiceMediaItem[] = [];

        // 1. Original media
        if (originalMediaFileId && originalMediaType) {
          mediaItems.push({
            fileId: originalMediaFileId,
            type: originalMediaType as 'photo' | 'document',
          });
        }

        // 2. Previous additions media
        for (const prev of previousAdditions) {
          if (prev.media_file_id && prev.media_type) {
            mediaItems.push({
              fileId: prev.media_file_id,
              type: prev.media_type as 'photo' | 'document',
            });
          }
        }

        // 3. Newly added media
        if (addPhoto) {
          mediaItems.push({
            fileId: addPhoto,
            type: 'photo',
          });
        } else if (addDoc) {
          mediaItems.push({
            fileId: addDoc,
            type: 'document',
          });
        }

        const allPhotos = mediaItems.every((m) => m.type === 'photo');
        const allDocs = mediaItems.every((m) => m.type === 'document');

        try {
          if (mediaItems.length >= 2 && (allPhotos || allDocs)) {
            // Telegram media group combining ALL media items together (original + all additions)
            const groupType = allPhotos ? 'photo' : 'document';
            const mediaGroup = mediaItems.map((item, idx) => ({
              type: groupType,
              media: item.fileId,
              ...(idx === 0 ? { caption: safeCaption, parse_mode: 'HTML' as const } : {}),
            }));

            const sentMsgs = await api.sendMediaGroup(chatId, mediaGroup as any, {
              message_thread_id: pendingTopicId,
            });
            newInvoiceMsg = sentMsgs[0];

            for (const other of sentMsgs.slice(1)) {
              await this.repo.addSupersededMessageId(transaction.id, other.message_id);
            }
          } else if (addPhoto) {
            newInvoiceMsg = await api.sendPhoto(chatId, addPhoto, {
              caption: safeCaption,
              message_thread_id: pendingTopicId,
              parse_mode: 'HTML',
            });
          } else if (addDoc) {
            newInvoiceMsg = await api.sendDocument(chatId, addDoc, {
              caption: safeCaption,
              message_thread_id: pendingTopicId,
              parse_mode: 'HTML',
            });
          } else {
            newInvoiceMsg = await api.sendMessage(chatId, safeCaption, {
              message_thread_id: pendingTopicId,
              parse_mode: 'HTML',
            });
          }

          if (addPhoto || addDoc) {
            const newMediaId = addPhoto || addDoc;
            const newMediaType = addPhoto ? 'photo' : 'document';
            if (!transaction.mediaFileId) {
              await this.updateTransactionMedia(transaction.id, newMediaId, newMediaType);
              await this.repo.updateInvoiceType(transaction.id, 'MEDIA');
              transaction.mediaFileId = newMediaId;
              transaction.mediaType = newMediaType;
              transaction.invoiceType = 'MEDIA';
            }
          }

          // Ensure exactly one current account-control message for the current invoice version
          if (transaction.distributorSnapshot?.accountNumber) {
            try {
              const controlText = formatAccountControlMessage(
                transaction.id,
                transaction.distributorSnapshot
              );
              const newControlMsg = await api.sendMessage(chatId, controlText, {
                message_thread_id: pendingTopicId,
                reply_markup: copyAccountKeyboard(transaction.distributorSnapshot.accountNumber),
                parse_mode: 'HTML',
              });
              const oldControlId = transaction.accountControlMessageId;
              await this.repo.updateAccountControlMessageId(transaction.id, newControlMsg.message_id);
              transaction.accountControlMessageId = newControlMsg.message_id;
              if (oldControlId && oldControlId !== newControlMsg.message_id) {
                try {
                  await api.deleteMessage(chatId, oldControlId);
                } catch (delErr) {
                  console.warn(`Failed to delete previous control message ${oldControlId}:`, (delErr as Error).message);
                }
              }
            } catch (btnErr) {
              console.warn('Failed to send account control message:', (btnErr as Error).message);
            }
          }
        } catch (sendErr) {
          return {
            success: false,
            error: `Failed to create new invoice message: ${(sendErr as Error).message}`,
            failedStep: 'create_new_invoice',
          };
        }

        // 2. Update the original invoice's text/history message with a clear notice and direct link
        const updatedInvoiceUrl = buildMessageLink(chatId, newInvoiceMsg.message_id);
        const supersededNotice = formatSupersededInvoiceCaption(transaction.id, updatedInvoiceUrl);
        try {
          if (isMedia) {
            await api.editMessageCaption(chatId, targetMessageId, {
              caption: supersededNotice,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [] },
            });
          } else {
            await api.editMessageText(chatId, targetMessageId, supersededNotice, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [] },
            });
          }
        } catch (err: unknown) {
          if (isNoTextMessageError(err)) {
            try {
              if (isMedia) {
                await api.editMessageText(chatId, targetMessageId, supersededNotice, {
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: [] },
                });
              } else {
                await api.editMessageCaption(chatId, targetMessageId, {
                  caption: supersededNotice,
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: [] },
                });
              }
            } catch {
              /* best effort */
            }
          }
          console.warn(`Failed to update original invoice notice ${targetMessageId}:`, (err as Error).message);
        }

        await this.repo.addSupersededMessageId(transaction.id, targetMessageId);

        if (transaction.originalMessageId && transaction.originalMessageId !== targetMessageId) {
          try {
            await api.editMessageCaption(chatId, transaction.originalMessageId, {
              caption: supersededNotice,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            /* best effort */
          }
          await this.repo.addSupersededMessageId(transaction.id, transaction.originalMessageId);
        }

        // 3. Persist new primary message ID in DB (so subsequent operations target this active invoice), preserving superseded message in history
        await this.repo.updateMetadataAndHistoryMessageId(
          transaction.id,
          newInvoiceMsg.message_id,
          targetMessageId !== newInvoiceMsg.message_id ? targetMessageId : undefined
        );
        transaction.metadataMessageId = newInvoiceMsg.message_id;
        if (targetMessageId !== newInvoiceMsg.message_id && !transaction.historyMessageId) {
          transaction.historyMessageId = targetMessageId;
        }
      } else {
        // ── Case B: Amount-only addition (no new media) ────────────
        // Edit existing message in place
        const buttonMarkup =
          !transaction.accountControlMessageId && keyboard
            ? keyboard
            : undefined;

        let editSucceeded = false;
        if (isMedia) {
          try {
            await api.editMessageCaption(chatId, targetMessageId, {
              caption: safeCaption,
              reply_markup: buttonMarkup,
            });
            editSucceeded = true;
          } catch (capErr: unknown) {
            if (isNoTextMessageError(capErr)) {
              try {
                await api.editMessageText(chatId, targetMessageId, safeCaption, {
                  reply_markup: buttonMarkup,
                });
                editSucceeded = true;
              } catch {
                /* fall through to re-send fallback */
              }
            }
          }
        } else {
          try {
            await api.editMessageText(chatId, targetMessageId, safeCaption, {
              reply_markup: buttonMarkup,
            });
            editSucceeded = true;
          } catch (txtErr: unknown) {
            if (isNoTextMessageError(txtErr)) {
              try {
                await api.editMessageCaption(chatId, targetMessageId, {
                  caption: safeCaption,
                  reply_markup: buttonMarkup,
                });
                editSucceeded = true;
              } catch {
                /* fall through to re-send fallback */
              }
            }
          }
        }

        if (editSucceeded) {
          newInvoiceMsg = {
            ...repliedMessage,
            message_id: targetMessageId,
          } as Message;
          if (!transaction.metadataMessageId) {
            await this.repo.updateMetadataMessageId(transaction.id, targetMessageId);
            transaction.metadataMessageId = targetMessageId;
          }
        } else {
          // Fallback: Re-send preserving the ORIGINAL media
          try {
            if (originalMediaType === 'photo' && originalMediaFileId) {
              newInvoiceMsg = await api.sendPhoto(chatId, originalMediaFileId, {
                caption: safeCaption,
                message_thread_id: pendingTopicId,
                parse_mode: 'HTML',
                reply_markup: buttonMarkup,
              });
            } else if (originalMediaType === 'document' && originalMediaFileId) {
              newInvoiceMsg = await api.sendDocument(chatId, originalMediaFileId, {
                caption: safeCaption,
                message_thread_id: pendingTopicId,
                parse_mode: 'HTML',
                reply_markup: buttonMarkup,
              });
            } else {
              newInvoiceMsg = await api.sendMessage(chatId, safeCaption, {
                message_thread_id: pendingTopicId,
                parse_mode: 'HTML',
                reply_markup: buttonMarkup,
              });
            }

            await this.repo.updateMetadataMessageId(transaction.id, newInvoiceMsg.message_id);
            transaction.metadataMessageId = newInvoiceMsg.message_id;

            // If fallback created a new message, update the old message with superseded notice
            if (targetMessageId !== newInvoiceMsg.message_id) {
              const updatedInvoiceUrl = buildMessageLink(chatId, newInvoiceMsg.message_id);
              const supersededCaption = formatSupersededInvoiceCaption(transaction.id, updatedInvoiceUrl);
              try {
                if (isMedia) {
                  await api.editMessageCaption(chatId, targetMessageId, {
                    caption: supersededCaption,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] },
                  });
                } else {
                  await api.editMessageText(chatId, targetMessageId, supersededCaption, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] },
                  });
                }
              } catch (err: unknown) {
                console.warn(`Failed to update superseded invoice message ${targetMessageId}:`, (err as Error).message);
              }
            }
          } catch (sendErr) {
            return {
              success: false,
              error: `Failed to update invoice message: ${(sendErr as Error).message}`,
              failedStep: 'create_new_invoice',
            };
          }
        }
      }

      // 5. Save updated transaction and addition record in database
      try {
        await this.setAmount(transaction.id, newTotalAmount);
        await this.repo.recordAddition(
          transaction.id,
          addedAmount,
          now,
          addMessage.message_id,
          addPhoto ?? addDoc ?? null,
          addPhoto ? 'photo' : addDoc ? 'document' : null,
          optionalNote ?? null
        );

        if (optionalNote) {
          const currentNotes = transaction.notes ?? [];
          currentNotes.push({
            text: optionalNote,
            createdAt: now,
          });
          await this.repo.updateNotes(transaction.id, JSON.stringify(currentNotes));
        }
      } catch (dbErr) {
        return {
          success: false,
          error: `Failed to save updated transaction record: ${(dbErr as Error).message}`,
          failedStep: 'save_transaction',
        };
      }

      // 6. Delete admin's /add message
      try {
        await api.deleteMessage(chatId, addMessage.message_id);
      } catch (delErr) {
        console.warn(`Failed to delete admin /add message: ${(delErr as Error).message}`);
      }

      const updatedInvoiceUrl = buildMessageLink(chatId, newInvoiceMsg.message_id);
      return {
        success: true,
        transactionId: transaction.id,
        newTotalAmount,
        newInvoiceMessageId: newInvoiceMsg.message_id,
        updatedInvoiceUrl,
        supersededInvoiceMessageId:
          newInvoiceMsg.message_id !== targetMessageId ? targetMessageId : undefined,
      };
    } finally {
      processingLocks.delete(transaction.id);
    }
  }
}

