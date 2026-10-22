export interface DatabaseResult {
  changes: number;
  lastInsertRowid?: number;
}

export interface IDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string, params?: unknown[]): Promise<DatabaseResult>;
}

/**
 * Adapter for Cloudflare D1 Database
 */
export class D1DatabaseAdapter implements IDatabase {
  constructor(private d1: D1Database) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const result = await stmt.all<T>();
    return result.results ?? [];
  }

  async first<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const result = await stmt.first<T>();
    return result ?? null;
  }

  async exec(sql: string, params: unknown[] = []): Promise<DatabaseResult> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const result = await stmt.run();
    return {
      changes: result.meta?.changes ?? 0,
      lastInsertRowid: result.meta?.last_row_id,
    };
  }
}

/**
 * Adapter for Node.js better-sqlite3 Database
 */
export class SqliteDatabaseAdapter implements IDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private sqlite: any) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.sqlite.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async first<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.sqlite.prepare(sql);
    const row = stmt.get(...params);
    return (row as T) ?? null;
  }

  async exec(sql: string, params: unknown[] = []): Promise<DatabaseResult> {
    const stmt = this.sqlite.prepare(sql);
    const result = stmt.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : undefined,
    };
  }
}
