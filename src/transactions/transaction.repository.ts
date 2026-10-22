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
    receivedAt: string
  ): Promise<TransactionRow> {
    const result = await this.db.exec(
      `INSERT INTO transactions (telegram_chat_id, pending_topic_id, original_message_id, received_at)
       VALUES (?, ?, ?, ?)`,
      [chatId, topicId, messageId, receivedAt]
    );
    const created = await this.findById(result.lastInsertRowid as number);
    if (!created) {
      throw new Error('Failed to retrieve newly created transaction.');
    }
    return created;
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
   * Finds a transaction by checking both original_message_id and metadata_message_id.
   * After the bot re-sends user media, the metadata_message_id becomes the visible
   * message that users reply to. This method checks both.
   */
  async findByAnyMessageId(chatId: string, messageId: number): Promise<TransactionRow | undefined> {
    const row = await this.db.first<TransactionRow>(
      `SELECT * FROM transactions
       WHERE telegram_chat_id = ?
         AND (original_message_id = ? OR metadata_message_id = ?)`,
      [chatId, messageId, messageId]
    );
    return row ?? undefined;
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
