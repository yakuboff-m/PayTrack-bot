import { getDatabase } from '../database/database';
import { IDatabase, SqliteDatabaseAdapter } from '../database/adapter';
import type { DistributorRow, CreateDistributorInput, UpdateDistributorInput } from '../types';

export class DistributorRepository {
  private db: IDatabase;

  constructor(db?: IDatabase) {
    this.db = db ?? new SqliteDatabaseAdapter(getDatabase());
  }

  async create(input: CreateDistributorInput): Promise<DistributorRow> {
    const result = await this.db.exec(
      `INSERT INTO distributors (name, alias, bank_name, account_number, account_holder)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.name,
        input.alias.toLowerCase(),
        input.bankName,
        input.accountNumber,
        input.accountHolder,
      ]
    );
    const created = await this.findById(result.lastInsertRowid as number);
    if (!created) {
      throw new Error('Failed to retrieve newly created distributor.');
    }
    return created;
  }

  async findAll(): Promise<DistributorRow[]> {
    return this.db.query<DistributorRow>('SELECT * FROM distributors ORDER BY name ASC');
  }

  async findById(id: number): Promise<DistributorRow | undefined> {
    const row = await this.db.first<DistributorRow>('SELECT * FROM distributors WHERE id = ?', [id]);
    return row ?? undefined;
  }

  async findByAlias(alias: string): Promise<DistributorRow | undefined> {
    const row = await this.db.first<DistributorRow>('SELECT * FROM distributors WHERE alias = ?', [
      alias.toLowerCase(),
    ]);
    return row ?? undefined;
  }

  async update(id: number, input: UpdateDistributorInput): Promise<DistributorRow | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;

    const updated = {
      name: input.name ?? current.name,
      alias: input.alias ? input.alias.toLowerCase() : current.alias,
      bankName: input.bankName ?? current.bank_name,
      accountNumber: input.accountNumber ?? current.account_number,
      accountHolder: input.accountHolder ?? current.account_holder,
    };

    await this.db.exec(
      `UPDATE distributors
       SET name = ?,
           alias = ?,
           bank_name = ?,
           account_number = ?,
           account_holder = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [
        updated.name,
        updated.alias,
        updated.bankName,
        updated.accountNumber,
        updated.accountHolder,
        id,
      ]
    );
    return this.findById(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.exec('DELETE FROM distributors WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /** Returns all aliases for dynamic command matching */
  async getAllAliases(): Promise<string[]> {
    const rows = await this.db.query<{ alias: string }>('SELECT alias FROM distributors ORDER BY alias ASC');
    return rows.map((r) => r.alias);
  }
}
