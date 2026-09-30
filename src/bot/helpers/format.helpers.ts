import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { DistributorSnapshot } from '../../types';
import { METADATA_SEPARATOR } from './telegram.helpers';

const TIMEZONE = 'Asia/Seoul';

/**
 * Formats a transaction ID as a readable unique invoice code.
 * Example: 1 -> "#INV-0001", 42 -> "#INV-0042"
 */
export function formatInvoiceId(id: number): string {
  return `#INV${String(id).padStart(4, '0')}`;
}

/**
 * Extracts a numeric invoice ID from user input.
 * Supports "#INV-0001", "INV-0001", "INV-1", "#1", "1".
 */
export function parseInvoiceId(input: string): number | null {
  const match = input.trim().match(/^(?:#?INV-?|#)?(\d+)$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Formats an amount in KRW with comma separators and ₩ prefix.
 * Example: 280700 → "₩280,700"
 */
export function formatAmount(amount: number): string {
  return `₩${amount.toLocaleString('en-US')}`;
}

/**
 * Formats a Date or ISO string into "YYYY-MM-DD HH:mm" in Asia/Seoul timezone.
 */
export function formatTimestamp(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const seoulTime = toZonedTime(d, TIMEZONE);
  return format(seoulTime, 'yyyy-MM-dd HH:mm');
}

/**
 * Returns the current time as an ISO string.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Parses a user-provided amount string into a positive integer (in KRW).
 * Accepts: "280700", "280,700", "₩280,700", "₩ 280,700"
 * Returns null if the input is invalid.
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[₩\s,]/g, '');
  if (cleaned.length === 0) return null;

  if (!/^\d+$/.test(cleaned)) return null;

  const value = parseInt(cleaned, 10);
  if (isNaN(value) || value <= 0) return null;

  return value;
}

/**
 * Builds the metadata block for the bot's transaction message caption.
 * Every line has an emoji prefix for visual richness, with unique invoice ID at the top.
 */
export function buildMetadataBlock(
  distributor: DistributorSnapshot | null,
  amount: number | null,
  receivedAt?: string,
  invoiceId?: number
): string {
  const lines: string[] = [METADATA_SEPARATOR];

  if (invoiceId !== undefined) {
    lines.push(`🆔 ${formatInvoiceId(invoiceId)}`);
  }

  if (distributor) {
    lines.push(`🏢 ${distributor.name}`);
    lines.push(`🏦 ${distributor.bankName}`);
    lines.push(`💳 ${distributor.accountNumber}`);
    lines.push(`👤 ${distributor.accountHolder}`);
  }

  if (amount !== null) {
    lines.push(`💰 ${formatAmount(amount)}`);
  }

  if (receivedAt) {
    lines.push(`📅 ${formatTimestamp(receivedAt)}`);
  }

  lines.push(METADATA_SEPARATOR);
  return lines.join('\n');
}

/**
 * Formats the PAID header message sent to the Confirmed topic.
 */
export function formatConfirmedHeader(
  distributorName: string | null,
  amount: number | null,
  receivedAt: string,
  paidAt: string,
  invoiceId?: number,
  note?: string
): string {
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━');
  lines.push(invoiceId ? `✅ PAID • ${formatInvoiceId(invoiceId)}` : '✅ PAID');
  lines.push('');
  lines.push(`🏢 ${distributorName ?? 'Not specified'}`);
  lines.push(`💰 ${amount !== null ? formatAmount(amount) : 'Not specified'}`);
  lines.push('');
  lines.push(`📥 Received: ${formatTimestamp(receivedAt)}`);
  lines.push(`💸 Paid: ${formatTimestamp(paidAt)}`);
  if (note) {
    lines.push('');
    lines.push(`📝 Note: ${note}`);
  }
  lines.push('━━━━━━━━━━━━');

  return lines.join('\n');
}

/**
 * Formats the lightweight history record left in the Pending topic after confirmation.
 */
export function formatHistoryRecord(
  distributorName: string | null,
  amount: number | null,
  receivedAt: string,
  paidAt: string,
  confirmationUrl: string,
  invoiceId?: number,
  note?: string
): string {
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━');
  lines.push(invoiceId ? `✅ PAID • ${formatInvoiceId(invoiceId)}` : '✅ PAID');
  lines.push('');
  lines.push(`🏢 ${distributorName ?? 'Not specified'}`);
  lines.push(`💰 ${amount !== null ? formatAmount(amount) : 'Not specified'}`);
  lines.push('');
  lines.push(`📥 Received: ${formatTimestamp(receivedAt)}`);
  lines.push(`💸 Paid: ${formatTimestamp(paidAt)}`);
  if (note) {
    lines.push('');
    lines.push(`📝 Note: ${note}`);
  }
  lines.push('');
  lines.push(`🔗 Confirmation`);
  lines.push(confirmationUrl);
  lines.push('━━━━━━━━━━━━');

  return lines.join('\n');
}

/**
 * Formats a pending transaction summary for display.
 */
export function formatPendingSummary(
  distributorName: string | null,
  amount: number | null,
  receivedAt: string,
  invoiceId?: number
): string {
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━');
  lines.push(invoiceId ? `⏳ PENDING • ${formatInvoiceId(invoiceId)}` : '⏳ PENDING');
  lines.push('');
  lines.push(`🏢 ${distributorName ?? 'Not specified'}`);
  lines.push(`💰 ${amount !== null ? formatAmount(amount) : 'Not specified'}`);
  lines.push('');
  lines.push(`📅 Received: ${formatTimestamp(receivedAt)}`);
  lines.push('━━━━━━━━━━━━');

  return lines.join('\n');
}
