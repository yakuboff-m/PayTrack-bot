import { getDatabase } from '../database/database';
import { IDatabase, SqliteDatabaseAdapter } from '../database/adapter';
import type { TransactionRow } from '../types';

export class TransactionRepository {
  private db: IDatabase;

  constructor(db?: IDatabase) {
    this.db = db ?? new SqliteDatabaseAdapter(getDatabase());
  }

  async create(
    chatId: string,
    topicId: number,
    messageId: number,
    receivedAt: string,
    notes?: string
  ): Promise<TransactionRow> {
    const result = await this.db.exec(
      `INSERT INTO transactions (telegram_chat_id, pending_topic_id, original_message_id, received_at, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [chatId, topicId, messageId, receivedAt, notes ?? '[]']
    );
    const created = await this.findById(result.lastInsertRowid as number);
    if (!created) {
      throw new Error('Failed to retrieve newly created transaction.');
    }
    return created;
  }

  async restoreOrRegister(params: {
    id?: number;
    chatId: string;
    pendingTopicId: number;
    messageId: number;
    distributorSnapshot?: string | null;
    amount?: number | null;
    receivedAt: string;
    notes?: string | null;
  }): Promise<TransactionRow> {
    if (params.id) {
      await this.db.exec(
        `INSERT INTO transactions (id, telegram_chat_id, pending_topic_id, original_message_id, metadata_message_id, distributor_snapshot, amount, received_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           metadata_message_id = COALESCE(metadata_message_id, excluded.metadata_message_id),
           distributor_snapshot = COALESCE(distributor_snapshot, excluded.distributor_snapshot),
           amount = COALESCE(amount, excluded.amount)`,
        [
          params.id,
          params.chatId,
          params.pendingTopicId,
          params.messageId,
          params.messageId,
          params.distributorSnapshot ?? null,
          params.amount ?? null,
          params.receivedAt,
          params.notes ?? null,
        ]
      );
      const row = await this.findById(params.id);
      return row!;
    } else {
      return this.create(
        params.chatId,
        params.pendingTopicId,
        params.messageId,
        params.receivedAt,
        params.notes ?? undefined
      );
    }
  }

  async findById(id: number): Promise<TransactionRow | undefined> {
    const row = await this.db.first<TransactionRow>(
      'SELECT * FROM transactions WHERE id = ?',
      [id]
    );
    return row ?? undefined;
  }

  async findByMessageId(chatId: string, messageId: number): Promise<TransactionRow | undefined> {
    const row = await this.db.first<TransactionRow>(
      'SELECT * FROM transactions WHERE telegram_chat_id = ? AND original_message_id = ?',
      [chatId, messageId]
    );
    return row ?? undefined;
  }

  /**
   * Finds a transaction by checking original, metadata, confirmation, or history message IDs.
   * Allows replying to an invoice in Pending or Confirmed topics.
   * Handles chat ID prefix differences (with/without -100) and falls back to matching by message ID.
   */
  async findByAnyMessageId(chatId: string, messageId: number): Promise<TransactionRow | undefined> {
    const rawChatId = String(chatId);
    const altChatId = rawChatId.startsWith('-100')
      ? rawChatId.slice(4)
      : rawChatId.startsWith('-')
      ? rawChatId.slice(1)
      : '-100' + rawChatId;

    let row = await this.db.first<TransactionRow>(
      `SELECT * FROM transactions
       WHERE (telegram_chat_id = ? OR telegram_chat_id = ?)
         AND (original_message_id = ? OR metadata_message_id = ? OR confirmation_message_id = ? OR history_message_id = ?)`,
      [rawChatId, altChatId, messageId, messageId, messageId, messageId]
    );

    if (!row) {
      row = await this.db.first<TransactionRow>(
        `SELECT * FROM transactions
         WHERE (original_message_id = ? OR metadata_message_id = ? OR confirmation_message_id = ? OR history_message_id = ?)
         ORDER BY id DESC`,
        [messageId, messageId, messageId, messageId]
      );
    }

    return row ?? undefined;
  }

  async updateNotes(id: number, notesJson: string): Promise<void> {
    await this.db.exec('UPDATE transactions SET notes = ? WHERE id = ?', [notesJson, id]);
  }

  async findByPaymentMessageId(
    chatId: string,
    paymentMessageId: number
  ): Promise<TransactionRow | undefined> {
    const row = await this.db.first<TransactionRow>(
      'SELECT * FROM transactions WHERE telegram_chat_id = ? AND payment_message_id = ?',
      [chatId, paymentMessageId]
    );
    return row ?? undefined;
  }

  async findPendingByDistributor(distributorId: number): Promise<TransactionRow[]> {
    return this.db.query<TransactionRow>(
      'SELECT * FROM transactions WHERE distributor_id = ? AND status = ? ORDER BY received_at DESC',
      [distributorId, 'PENDING']
    );
  }

  async updateDistributor(
    id: number,
    distributorId: number,
    distributorSnapshot: string
  ): Promise<void> {
    await this.db.exec(
      `UPDATE transactions
       SET distributor_id = ?, distributor_snapshot = ?
       WHERE id = ?`,
      [distributorId, distributorSnapshot, id]
    );
  }

  async updateAmount(id: number, amount: number): Promise<void> {
    await this.db.exec('UPDATE transactions SET amount = ? WHERE id = ?', [amount, id]);
  }

  /**
   * Marks a transaction as PAID. Returns true if the status was actually
   * changed from PENDING → PAID (i.e. the row existed and was still PENDING).
   * This serves as the concurrency-safe "compare-and-swap" for confirmation.
   */
  async markPaid(
    id: number,
    paidAt: string,
    paymentMessageId: number,
    confirmationMessageId: number,
    confirmationUrl: string,
    historyMessageId: number
  ): Promise<boolean> {
    const result = await this.db.exec(
      `UPDATE transactions
       SET status = 'PAID',
           paid_at = ?,
           payment_message_id = ?,
           confirmation_message_id = ?,
           confirmation_url = ?,
           history_message_id = ?
       WHERE id = ? AND status = 'PENDING'`,
      [
        paidAt,
        paymentMessageId,
        confirmationMessageId,
        confirmationUrl,
        historyMessageId,
        id,
      ]
    );
    return result.changes > 0;
  }

  async updateMetadataMessageId(id: number, metadataMessageId: number): Promise<void> {
    await this.db.exec(
      'UPDATE transactions SET metadata_message_id = ? WHERE id = ?',
      [metadataMessageId, id]
    );
  }
}
