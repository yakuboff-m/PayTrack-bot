import { getDatabase } from '../database/database';
import type { DistributorRow, CreateDistributorInput, UpdateDistributorInput } from '../types';

export class DistributorRepository {
  private get db() {
    return getDatabase();
  }

  create(input: CreateDistributorInput): DistributorRow {
    const stmt = this.db.prepare(`
      INSERT INTO distributors (name, alias, bank_name, account_number, account_holder)
      VALUES (@name, @alias, @bankName, @accountNumber, @accountHolder)
    `);
    const result = stmt.run({
      name: input.name,
      alias: input.alias.toLowerCase(),
      bankName: input.bankName,
      accountNumber: input.accountNumber,
      accountHolder: input.accountHolder,
    });
    return this.findById(result.lastInsertRowid as number)!;
  }

  findAll(): DistributorRow[] {
    const stmt = this.db.prepare('SELECT * FROM distributors ORDER BY name ASC');
    return stmt.all() as DistributorRow[];
  }

  findById(id: number): DistributorRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM distributors WHERE id = ?');
    return stmt.get(id) as DistributorRow | undefined;
  }

  findByAlias(alias: string): DistributorRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM distributors WHERE alias = ?');
    return stmt.get(alias.toLowerCase()) as DistributorRow | undefined;
  }

  update(id: number, input: UpdateDistributorInput): DistributorRow | undefined {
    const current = this.findById(id);
    if (!current) return undefined;

    const updated = {
      name: input.name ?? current.name,
      alias: input.alias ? input.alias.toLowerCase() : current.alias,
      bankName: input.bankName ?? current.bank_name,
      accountNumber: input.accountNumber ?? current.account_number,
      accountHolder: input.accountHolder ?? current.account_holder,
    };

    const stmt = this.db.prepare(`
      UPDATE distributors
      SET name = @name,
          alias = @alias,
          bank_name = @bankName,
          account_number = @accountNumber,
          account_holder = @accountHolder,
          updated_at = datetime('now')
      WHERE id = @id
    `);
    stmt.run({ id, ...updated });
    return this.findById(id);
  }

  delete(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM distributors WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /** Returns all aliases for dynamic command matching */
  getAllAliases(): string[] {
    const stmt = this.db.prepare('SELECT alias FROM distributors ORDER BY alias ASC');
    const rows = stmt.all() as Array<{ alias: string }>;
    return rows.map((r) => r.alias);
  }
}
