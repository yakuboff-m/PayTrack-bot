import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { DistributorSnapshot, InvoiceNote } from '../../types';
import { METADATA_SEPARATOR } from './telegram.helpers';

const TIMEZONE = 'Asia/Seoul';

/**
 * Formats a Date or ISO string into "d MMM, HH:mm" in Asia/Seoul timezone.
 * Example: 2026-10-22T01:30:00Z -> "22 Oct, 10:30"
 */
export function formatNoteTimestamp(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const seoulTime = toZonedTime(d, TIMEZONE);
  return format(seoulTime, 'd MMM, HH:mm');
}

/**
 * Formats a list of invoice notes chronologically.
 */
export function formatNotesBlock(notes: InvoiceNote[]): string {
  if (!notes || notes.length === 0) return '';
  const lines: string[] = ['📝 NOTES:'];
  notes.forEach((n) => {
    lines.push(`• ${formatNoteTimestamp(n.createdAt)} — ${n.text}`);
  });
  return lines.join('\n');
}

/**
 * Parses and extracts an optional note directive (/note <text> or Note: <text>)
 * from a message or invoice text.
 */
export function extractNoteFromText(text: string): { cleanText: string; note: string | null } {
  if (!text) return { cleanText: '', note: null };

  const lines = text.split(/\r?\n/);
  const remainingLines: string[] = [];
  let extractedNote: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const noteMatch = trimmed.match(/^(?:\/note|note:)\s*(.+)$/i);
    if (noteMatch && !extractedNote) {
      extractedNote = noteMatch[1].trim();
    } else {
      remainingLines.push(line);
    }
  }

  if (!extractedNote) {
    const inlineMatch = text.match(/\s+(?:\/note|note:)\s*(.+)$/i);
    if (inlineMatch && inlineMatch.index !== undefined) {
      extractedNote = inlineMatch[1].trim();
      const clean = text.substring(0, inlineMatch.index).trim();
      return { cleanText: clean, note: extractedNote };
    }
  }

  return {
    cleanText: remainingLines.join('\n').trim(),
    note: extractedNote,
  };
}

/**
 * Formats a transaction ID as a readable unique invoice code.
 * Example: 1 -> "#INV-0001", 42 -> "#INV-0042"
 */
export function formatInvoiceId(id: number): string {
  return `#INV${String(id).padStart(4, '0')}`;
}

/**
 * Extracts a numeric invoice ID from arbitrary text or captions.
 * Supports patterns like "🆔 #INV0009", "#INV0009", "#INV-0009", "INV0009", "INV-0009", or "#9".
 */
export function extractInvoiceIdFromText(text: string): number | null {
  if (!text) return null;
  const match =
    text.match(/(?:🆔\s*)?#?INV-?(\d+)\b/i) ||
    text.match(/(?:^|[^\w])#(\d+)\b/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Extracts a numeric invoice ID from user input.
 * Supports "#INV-0001", "INV-0001", "INV-1", "#1", "1", "🆔 #INV0001",
 * and fallback extraction from caption/text strings.
 */
export function parseInvoiceId(input: string): number | null {
  const trimmed = input.trim();
  const directMatch = trimmed.match(/^(?:🆔\s*)?(?:#?INV-?|#)?(\d+)$/i);
  if (directMatch) {
    const num = parseInt(directMatch[1], 10);
    return isNaN(num) || num <= 0 ? null : num;
  }
  return extractInvoiceIdFromText(trimmed);
}

/**
 * Extracts invoice ID, distributor snapshot, and amount from an invoice caption/text.
 */
export function parseInvoiceMetadataFromText(text: string): {
  invoiceId: number | null;
  distributor: DistributorSnapshot | null;
  amount: number | null;
} {
  const invoiceId = extractInvoiceIdFromText(text);

  let distributor: DistributorSnapshot | null = null;
  const nameMatch = text.match(/🏢\s*([^\r\n]+)/);
  const bankMatch = text.match(/🏦\s*([^\r\n]+)/);
  const accountMatch = text.match(/💳\s*([^\r\n]+)/);
  const holderMatch = text.match(/👤\s*([^\r\n]+)/);

  if (nameMatch) {
    distributor = {
      name: nameMatch[1].trim(),
      bankName: bankMatch ? bankMatch[1].trim() : '',
      accountNumber: accountMatch ? accountMatch[1].trim() : '',
      accountHolder: holderMatch ? holderMatch[1].trim() : '',
    };
  }

  let amount: number | null = null;
  const totalMatch = text.match(/(?:💰\s*Total:\s*|💰\s*)₩?([\d,]+)/i);
  if (totalMatch) {
    const rawVal = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(rawVal) && rawVal > 0) {
      amount = rawVal;
    }
  }

  return { invoiceId, distributor, amount };
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
  invoiceId?: number,
  notes?: InvoiceNote[]
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

  if (notes && notes.length > 0) {
    lines.push('');
    lines.push(formatNotesBlock(notes));
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
  note?: string,
  notes?: InvoiceNote[]
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

  if (notes && notes.length > 0) {
    lines.push('');
    lines.push(formatNotesBlock(notes));
  }

  if (note) {
    lines.push('');
    lines.push(`📝 Payment Note: ${note}`);
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
  note?: string,
  notes?: InvoiceNote[]
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

  if (notes && notes.length > 0) {
    lines.push('');
    lines.push(formatNotesBlock(notes));
  }

  if (note) {
    lines.push('');
    lines.push(`📝 Payment Note: ${note}`);
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
