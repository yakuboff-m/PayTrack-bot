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
 * Payload extracted from /paid or /confirmed command messages.
 */
export interface PaidCommandPayload {
  explicitInvoiceId: number | null;
  paymentAmount: number | null;
  userNote: string | null;
}

/**
 * Parses /paid or /confirmed command arguments.
 * Distinguishes optional invoice ID (#INV0001 or 1), optional payment amount (50,000 or ₩50,000),
 * and optional payment note.
 */
export function parsePaidCommandPayload(text: string): PaidCommandPayload {
  let cleaned = text.replace(/^\/(?:paid|confirmed)(?:@\w+)?\s*/i, '').trim();
  if (!cleaned) {
    return { explicitInvoiceId: null, paymentAmount: null, userNote: null };
  }

  // 1. Extract note directive if present (/note <text> or Note: <text>)
  const { cleanText, note: extractedNote } = extractNoteFromText(cleaned);
  cleaned = cleanText;
  let userNote = extractedNote;

  let explicitInvoiceId: number | null = null;
  let paymentAmount: number | null = null;

  // 2. Check for explicit invoice ID with prefix: 🆔, #INV..., INV..., #...
  const invoicePrefixMatch = cleaned.match(/(?:^|\s)(?:🆔\s*)?(?:#INV-?|INV-?|#)(\d+)\b/i);
  if (invoicePrefixMatch && invoicePrefixMatch.index !== undefined) {
    explicitInvoiceId = parseInt(invoicePrefixMatch[1], 10);
    cleaned = (
      cleaned.substring(0, invoicePrefixMatch.index) +
      ' ' +
      cleaned.substring(invoicePrefixMatch.index + invoicePrefixMatch[0].length)
    ).trim();
  }

  // 3. Check for amount with currency symbol or commas: e.g. ₩50,000, 50,000, ₩50000
  const formattedAmountMatch = cleaned.match(
    /(?:^|\s)(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*(?:KRW|원)?(?:\s|$)/i
  );
  if (formattedAmountMatch && formattedAmountMatch.index !== undefined) {
    const rawVal = formattedAmountMatch[1].replace(/,/g, '');
    const num = parseInt(rawVal, 10);
    const hasCommaOrCurrency =
      formattedAmountMatch[0].includes(',') ||
      formattedAmountMatch[0].includes('₩') ||
      /KRW|원/i.test(formattedAmountMatch[0]);
    if (hasCommaOrCurrency || num >= 1000 || explicitInvoiceId !== null) {
      paymentAmount = num;
      cleaned = (
        cleaned.substring(0, formattedAmountMatch.index) +
        ' ' +
        cleaned.substring(formattedAmountMatch.index + formattedAmountMatch[0].length)
      ).trim();
    }
  }

  // 4. If neither or only one found, check remaining tokens
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const remainingTokens: string[] = [];

  for (const token of tokens) {
    const parsedNum = parseAmount(token);
    if (parsedNum !== null && paymentAmount === null && explicitInvoiceId !== null) {
      paymentAmount = parsedNum;
    } else if (parsedNum !== null && explicitInvoiceId === null && paymentAmount === null) {
      if (token.includes(',') || parsedNum >= 1000) {
        paymentAmount = parsedNum;
      } else {
        explicitInvoiceId = parsedNum;
      }
    } else {
      remainingTokens.push(token);
    }
  }

  if (remainingTokens.length > 0) {
    const leftoverText = remainingTokens.join(' ').trim();
    userNote = userNote ? `${userNote} ${leftoverText}` : leftoverText;
  }

  return {
    explicitInvoiceId,
    paymentAmount,
    userNote: userNote || null,
  };
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
  notes?: InvoiceNote[],
  paymentProgress?: {
    cumulativePaid: number;
    remainingBalance: number;
  }
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

  if (paymentProgress) {
    lines.push(`💵 Paid: ${formatAmount(paymentProgress.cumulativePaid)}`);
    lines.push(`⚖️ Balance Due: ${formatAmount(paymentProgress.remainingBalance)}`);
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
 * Formats the cleaned caption for the original invoice message in the Pending topic.
 * As required by Bug 2:
 * Preserves ONLY the invoice number/ID from the original caption, followed by the
 * appropriate payment/status text, removing everything else (no unwanted manual-deletion text).
 */
export function formatCleanedPendingInvoiceCaption(
  invoiceId: number,
  status: 'PAID' | 'PARTIALLY_PAID',
  confirmationUrl?: string,
  cumulativePaid?: number | null,
  totalAmount?: number | null,
  remainingBalance?: number | null
): string {
  const idStr = formatInvoiceId(invoiceId);
  if (status === 'PAID') {
    const lines = [`🆔 ${idStr} • ✅ PAID`];
    if (confirmationUrl) {
      lines.push(`🔗 Confirmation: ${confirmationUrl}`);
    }
    return lines.join('\n');
  } else {
    const lines = [`🆔 ${idStr} • ⏳ PARTIALLY PAID`];
    if (
      totalAmount !== null &&
      totalAmount !== undefined &&
      cumulativePaid !== null &&
      cumulativePaid !== undefined
    ) {
      lines.push(`💰 Paid: ${formatAmount(cumulativePaid)} / ${formatAmount(totalAmount)}`);
    }
    if (remainingBalance !== null && remainingBalance !== undefined && remainingBalance > 0) {
      lines.push(`⚖️ Balance Due: ${formatAmount(remainingBalance)}`);
    }
    if (confirmationUrl) {
      lines.push(`🔗 Receipt: ${confirmationUrl}`);
    }
    return lines.join('\n');
  }
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
  notes?: InvoiceNote[],
  paymentDetails?: {
    status?: 'PAID' | 'PARTIALLY_PAID';
    paymentAmount?: number | null;
    cumulativePaid?: number | null;
    remainingBalance?: number | null;
  }
): string {
  const isPartial = paymentDetails?.status === 'PARTIALLY_PAID';
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━');
  if (isPartial) {
    lines.push(invoiceId ? `⏳ PARTIALLY PAID • ${formatInvoiceId(invoiceId)}` : '⏳ PARTIALLY PAID');
  } else {
    lines.push(invoiceId ? `✅ PAID • ${formatInvoiceId(invoiceId)}` : '✅ PAID');
  }
  lines.push('');
  lines.push(`🏢 ${distributorName ?? 'Not specified'}`);
  lines.push(`💰 Total: ${amount !== null ? formatAmount(amount) : 'Not specified'}`);

  if (paymentDetails?.paymentAmount !== undefined && paymentDetails.paymentAmount !== null) {
    lines.push(`💵 Payment: ${formatAmount(paymentDetails.paymentAmount)}`);
  }
  if (paymentDetails?.cumulativePaid !== undefined && paymentDetails.cumulativePaid !== null) {
    lines.push(`📊 Total Paid: ${formatAmount(paymentDetails.cumulativePaid)}`);
  }
  if (
    paymentDetails?.remainingBalance !== undefined &&
    paymentDetails.remainingBalance !== null &&
    isPartial
  ) {
    lines.push(`⚖️ Remaining Balance: ${formatAmount(paymentDetails.remainingBalance)}`);
  }

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
  notes?: InvoiceNote[],
  paymentDetails?: {
    status?: 'PAID' | 'PARTIALLY_PAID';
    paymentAmount?: number | null;
    cumulativePaid?: number | null;
    remainingBalance?: number | null;
  }
): string {
  const isPartial = paymentDetails?.status === 'PARTIALLY_PAID';
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━');
  if (isPartial) {
    lines.push(invoiceId ? `⏳ PARTIALLY PAID • ${formatInvoiceId(invoiceId)}` : '⏳ PARTIALLY PAID');
  } else {
    lines.push(invoiceId ? `✅ PAID • ${formatInvoiceId(invoiceId)}` : '✅ PAID');
  }
  lines.push('');
  lines.push(`🏢 ${distributorName ?? 'Not specified'}`);
  lines.push(`💰 Total: ${amount !== null ? formatAmount(amount) : 'Not specified'}`);

  if (paymentDetails?.paymentAmount !== undefined && paymentDetails.paymentAmount !== null) {
    lines.push(`💵 Payment: ${formatAmount(paymentDetails.paymentAmount)}`);
  }
  if (paymentDetails?.cumulativePaid !== undefined && paymentDetails.cumulativePaid !== null) {
    lines.push(`📊 Total Paid: ${formatAmount(paymentDetails.cumulativePaid)}`);
  }
  if (
    paymentDetails?.remainingBalance !== undefined &&
    paymentDetails.remainingBalance !== null &&
    isPartial
  ) {
    lines.push(`⚖️ Remaining Balance: ${formatAmount(paymentDetails.remainingBalance)}`);
  }

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
