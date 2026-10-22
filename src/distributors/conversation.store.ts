import type { IDatabase } from '../database/adapter';
import type { ConversationKey, ConversationState, ConversationStep } from '../types';

export interface IConversationStore {
  get(key: ConversationKey): Promise<ConversationState | null>;
  set(key: ConversationKey, state: ConversationState): Promise<void>;
  delete(key: ConversationKey): Promise<void>;
}

const CONVERSATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory conversation store (useful for local development and fallback)
 */
export class MemoryConversationStore implements IConversationStore {
  private map = new Map<ConversationKey, ConversationState>();

  async get(key: ConversationKey): Promise<ConversationState | null> {
    const state = this.map.get(key);
    if (!state) return null;
    if (Date.now() - state.startedAt > CONVERSATION_TIMEOUT_MS) {
      this.map.delete(key);
      return null;
    }
    return state;
  }

  async set(key: ConversationKey, state: ConversationState): Promise<void> {
    this.map.set(key, state);
  }

  async delete(key: ConversationKey): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * Persistent conversation store using D1/SQLite table: conversation_states
 */
export class DatabaseConversationStore implements IConversationStore {
  constructor(private db: IDatabase) {}

  async initTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_states (
        key             TEXT PRIMARY KEY,
        step            TEXT NOT NULL,
        action          TEXT NOT NULL,
        distributor_id  INTEGER,
        data            TEXT NOT NULL,
        started_at      INTEGER NOT NULL
      )
    `);
  }

  async get(key: ConversationKey): Promise<ConversationState | null> {
    const row = await this.db.first<{
      key: string;
      step: string;
      action: string;
      distributor_id: number | null;
      data: string;
      started_at: number;
    }>('SELECT * FROM conversation_states WHERE key = ?', [key]);

    if (!row) return null;

    if (Date.now() - row.started_at > CONVERSATION_TIMEOUT_MS) {
      await this.delete(key);
      return null;
    }

    try {
      return {
        step: row.step as ConversationStep,
        action: row.action as 'add' | 'edit',
        distributorId: row.distributor_id ?? undefined,
        data: JSON.parse(row.data),
        startedAt: row.started_at,
      };
    } catch {
      await this.delete(key);
      return null;
    }
  }

  async set(key: ConversationKey, state: ConversationState): Promise<void> {
    await this.db.exec(
      `INSERT INTO conversation_states (key, step, action, distributor_id, data, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         step = excluded.step,
         action = excluded.action,
         distributor_id = excluded.distributor_id,
         data = excluded.data,
         started_at = excluded.started_at`,
      [
        key,
        state.step,
        state.action,
        state.distributorId ?? null,
        JSON.stringify(state.data),
        state.startedAt,
      ]
    );
  }

  async delete(key: ConversationKey): Promise<void> {
    await this.db.exec('DELETE FROM conversation_states WHERE key = ?', [key]);
  }
}
