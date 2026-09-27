import { DistributorRepository } from './distributor.repository';
import type {
  Distributor,
  DistributorRow,
  DistributorSnapshot,
  CreateDistributorInput,
  UpdateDistributorInput,
} from '../types';

export class DistributorService {
  constructor(private repo: DistributorRepository) {}

  // ─── Row → Domain mapping ────────────────────────────────

  private toDomain(row: DistributorRow): Distributor {
    return {
      id: row.id,
      name: row.name,
      alias: row.alias,
      bankName: row.bank_name,
      accountNumber: row.account_number,
      accountHolder: row.account_holder,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ─── CRUD ─────────────────────────────────────────────────

  create(input: CreateDistributorInput): Distributor {
    const existing = this.repo.findByAlias(input.alias);
    if (existing) {
      throw new Error(`Alias "/${input.alias}" is already in use by "${existing.name}".`);
    }
    return this.toDomain(this.repo.create(input));
  }

  findAll(): Distributor[] {
    return this.repo.findAll().map((r) => this.toDomain(r));
  }

  findById(id: number): Distributor | undefined {
    const row = this.repo.findById(id);
    return row ? this.toDomain(row) : undefined;
  }

  findByAlias(alias: string): Distributor | undefined {
    const row = this.repo.findByAlias(alias);
    return row ? this.toDomain(row) : undefined;
  }

  update(id: number, input: UpdateDistributorInput): Distributor {
    // If alias is changing, check uniqueness
    if (input.alias) {
      const existing = this.repo.findByAlias(input.alias);
      if (existing && existing.id !== id) {
        throw new Error(`Alias "/${input.alias}" is already in use by "${existing.name}".`);
      }
    }
    const updated = this.repo.update(id, input);
    if (!updated) {
      throw new Error(`Distributor with ID ${id} not found.`);
    }
    return this.toDomain(updated);
  }

  delete(id: number): void {
    const exists = this.repo.findById(id);
    if (!exists) {
      throw new Error(`Distributor with ID ${id} not found.`);
    }
    this.repo.delete(id);
  }

  getAllAliases(): string[] {
    return this.repo.getAllAliases();
  }

  // ─── Snapshot ─────────────────────────────────────────────

  createSnapshot(distributor: Distributor): DistributorSnapshot {
    return {
      name: distributor.name,
      bankName: distributor.bankName,
      accountNumber: distributor.accountNumber,
      accountHolder: distributor.accountHolder,
    };
  }
}
