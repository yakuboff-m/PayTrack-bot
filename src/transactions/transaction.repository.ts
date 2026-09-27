import { getDatabase } from '../database/database';
import type { TransactionRow } from '../types';

export class TransactionRepository {
  private get db() {
    return getDatabase();
  }

  create(chatId: string, topicId: number, messageId: number, receivedAt: string): TransactionRow {
    const stmt = this.db.prepare(`
      INSERT INTO transactions (telegram_chat_id, pending_topic_id, original_message_id, received_at)
      VALUES (@chatId, @topicId, @messageId, @receivedAt)
    `);
    const result = stmt.run({
      chatId,
      topicId,
      messageId,
      receivedAt,
    });
    return this.findById(result.lastInsertRowid as number)!;
  }

  findById(id: number): TransactionRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM transactions WHERE id = ?');
    return stmt.get(id) as TransactionRow | undefined;
  }

  findByMessageId(chatId: string, messageId: number): TransactionRow | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM transactions WHERE telegram_chat_id = ? AND original_message_id = ?'
    );
    return stmt.get(chatId, messageId) as TransactionRow | undefined;
  }

  /**
   * Finds a transaction by checking both original_message_id and metadata_message_id.
   * After the bot re-sends user media, the metadata_message_id becomes the visible
   * message that users reply to. This method checks both.
   */
  findByAnyMessageId(chatId: string, messageId: number): TransactionRow | undefined {
    const stmt = this.db.prepare(
      `SELECT * FROM transactions
       WHERE telegram_chat_id = ?
         AND (original_message_id = ? OR metadata_message_id = ?)`
    );
    return stmt.get(chatId, messageId, messageId) as TransactionRow | undefined;
  }

  findByPaymentMessageId(chatId: string, paymentMessageId: number): TransactionRow | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM transactions WHERE telegram_chat_id = ? AND payment_message_id = ?'
    );
    return stmt.get(chatId, paymentMessageId) as TransactionRow | undefined;
  }

  findPendingByDistributor(distributorId: number): TransactionRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM transactions WHERE distributor_id = ? AND status = ? ORDER BY received_at DESC'
    );
    return stmt.all(distributorId, 'PENDING') as TransactionRow[];
  }

  updateDistributor(
    id: number,
    distributorId: number,
    distributorSnapshot: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET distributor_id = ?, distributor_snapshot = ?
      WHERE id = ?
    `);
    stmt.run(distributorId, distributorSnapshot, id);
  }

  updateAmount(id: number, amount: number): void {
    const stmt = this.db.prepare('UPDATE transactions SET amount = ? WHERE id = ?');
    stmt.run(amount, id);
  }

  /**
   * Marks a transaction as PAID. Returns true if the status was actually
   * changed from PENDING → PAID (i.e. the row existed and was still PENDING).
   * This serves as the concurrency-safe "compare-and-swap" for confirmation.
   */
  markPaid(
    id: number,
    paidAt: string,
    paymentMessageId: number,
    confirmationMessageId: number,
    confirmationUrl: string,
    historyMessageId: number
  ): boolean {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET status = 'PAID',
          paid_at = ?,
          payment_message_id = ?,
          confirmation_message_id = ?,
          confirmation_url = ?,
          history_message_id = ?
      WHERE id = ? AND status = 'PENDING'
    `);
    const result = stmt.run(
      paidAt,
      paymentMessageId,
      confirmationMessageId,
      confirmationUrl,
      historyMessageId,
      id
    );
    return result.changes > 0;
  }

  updateMetadataMessageId(id: number, metadataMessageId: number): void {
    const stmt = this.db.prepare(
      'UPDATE transactions SET metadata_message_id = ? WHERE id = ?'
    );
    stmt.run(metadataMessageId, id);
  }
}
