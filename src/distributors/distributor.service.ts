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

  async create(input: CreateDistributorInput): Promise<Distributor> {
    const existing = await this.repo.findByAlias(input.alias);
    if (existing) {
      throw new Error(`Alias "/${input.alias}" is already in use by "${existing.name}".`);
    }
    const row = await this.repo.create(input);
    return this.toDomain(row);
  }

  async findAll(): Promise<Distributor[]> {
    const rows = await this.repo.findAll();
    return rows.map((r) => this.toDomain(r));
  }

  async findById(id: number): Promise<Distributor | undefined> {
    const row = await this.repo.findById(id);
    return row ? this.toDomain(row) : undefined;
  }

  async findByAlias(alias: string): Promise<Distributor | undefined> {
    const row = await this.repo.findByAlias(alias);
    return row ? this.toDomain(row) : undefined;
  }

  async update(id: number, input: UpdateDistributorInput): Promise<Distributor> {
    // If alias is changing, check uniqueness
    if (input.alias) {
      const existing = await this.repo.findByAlias(input.alias);
      if (existing && existing.id !== id) {
        throw new Error(`Alias "/${input.alias}" is already in use by "${existing.name}".`);
      }
    }
    const updated = await this.repo.update(id, input);
    if (!updated) {
      throw new Error(`Distributor with ID ${id} not found.`);
    }
    return this.toDomain(updated);
  }

  async delete(id: number): Promise<void> {
    const exists = await this.repo.findById(id);
    if (!exists) {
      throw new Error(`Distributor with ID ${id} not found.`);
    }
    await this.repo.delete(id);
  }

  async getAllAliases(): Promise<string[]> {
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
