import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { DistributorSnapshot, InvoiceNote } from '../../types';
import { METADATA_SEPARATOR, MAX_TEXT_LENGTH } from './telegram.helpers';

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
  const bankMatch = text.match(/🏦\s*(?:Bank:\s*)?([^\r\n]+)/i);
  const accountMatch = text.match(/(?:🔢|💳)\s*(?:Account:\s*)?([^\r\n]+)/i);
  const holderMatch = text.match(/👤\s*(?:Holder:\s*)?([^\r\n]+)/i);

  if (nameMatch) {
    let cleanAccount = accountMatch ? accountMatch[1].trim() : '';
    if (cleanAccount.includes('Bank/account details are shown only')) {
      cleanAccount = '';
    }
    distributor = {
      name: nameMatch[1].trim(),
      bankName: bankMatch ? bankMatch[1].trim() : '',
      accountNumber: cleanAccount,
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

export interface InvoiceAdditionEvent {
  amount: number;
  addedAt: string;
  note?: string | null;
}

export interface PaymentEvent {
  amount: number;
  paidAt: string;
  receiptUrl?: string | null;
  note?: string | null;
}

export interface InvoiceFinancialSummary {
  originalAmount: number | null;
  additionsTotal: number;
  currentInvoiceTotal: number;
  totalPaid: number;
  balanceDue: number;
  status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID';
}

/**
 * Single authoritative financial calculation:
 * - current invoice total = original invoice amount + all valid additions
 * - total paid = sum of recorded payments
 * - balance due = max(0, current invoice total - total paid)
 */
export function computeInvoiceFinancialSummary(params: {
  initialAmount?: number | null;
  currentAmount?: number | null;
  additions: Array<{ amount: number }>;
  payments: Array<{ amount: number }>;
}): InvoiceFinancialSummary {
  const additionsTotal = params.additions.reduce((sum, a) => sum + a.amount, 0);

  let originalAmount: number | null = null;
  if (params.initialAmount !== undefined && params.initialAmount !== null) {
    originalAmount = params.initialAmount;
  } else if (params.currentAmount !== undefined && params.currentAmount !== null) {
    originalAmount = Math.max(0, params.currentAmount - additionsTotal);
  }

  const currentInvoiceTotal = (originalAmount ?? 0) + additionsTotal;
  const totalPaid = params.payments.reduce((sum, p) => sum + p.amount, 0);
  const balanceDue = Math.max(0, currentInvoiceTotal - totalPaid);

  let status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' = 'PENDING';
  if (totalPaid > 0 && balanceDue === 0 && currentInvoiceTotal > 0) {
    status = 'PAID';
  } else if (totalPaid > 0) {
    status = 'PARTIALLY_PAID';
  }

  return {
    originalAmount,
    additionsTotal,
    currentInvoiceTotal,
    totalPaid,
    balanceDue,
    status,
  };
}

/**
 * Strips duplicate total lines, invoice headers, dividers, distributor details,
 * action history, and financial summaries from raw text so the authoritative
 * caption emits each section strictly once.
 */
export function stripDuplicateTotalLines(text: string): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^(?:💰\s*)?(?:Grand\s+)?Total:\s*₩?[\d,\s]+/i.test(trimmed)) return false;
      if (/^(?:🧾|🥩|💰)?\s*(?:MEAT\s+)?INVOICE\b/i.test(trimmed)) return false;
      if (/^(?:🆔\s*)?#?INV\d+\b/i.test(trimmed)) return false;
      if (/^━+$/.test(trimmed) || /^─+$/.test(trimmed) || /^-+$/.test(trimmed)) return false;
      if (/^(?:🏢|🏦|💳|👤|🔢)/.test(trimmed)) return false;
      if (/^(?:📜\s*)?ACTION HISTORY/i.test(trimmed)) return false;
      if (/^(?:📥{1,3}|➕{1,3}|➖{1,3}|📊{1,3}|📄{1,3})/.test(trimmed)) return false;
      if (
        /^(?:📥\s*Original Registration|➕\s*Invoice Addition|➖\s*Partial payment|✅\s*Full payment|📝\s*Note:|💵\s*Registered Amount|💵\s*Amount Added|💵\s*Amount paid|🧾\s*Receipt URL|🔗\s*Receipt URL|🕧)/i.test(
          trimmed
        )
      )
        return false;
      if (/^└─>/.test(trimmed)) return false;
      if (/^(?:📊\s*)?FINANCIAL SUMMARY/i.test(trimmed)) return false;
      if (/^(?:💰\s*Invoice Total|💵\s*Total Paid|⚖️\s*Need to Pay|📊\s*Status)/i.test(trimmed))
        return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Checks if raw text contains an itemized invoice item list
 * (product names, quantities, unit prices, line totals, or meat invoice lines).
 */
export function isItemizedInvoiceText(text: string): boolean {
  if (!text || !text.trim()) return false;
  const trimmed = text.trim();

  if (/MEAT INVOICE/i.test(trimmed)) return true;

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let itemLineCount = 0;
  for (const line of lines) {
    if (/^━+$/.test(line) || /^─+$/.test(line) || /^-+$/.test(line)) continue;
    if (/^(?:🏢|🏦|💳|👤|🔢|🆔)/.test(line)) continue;
    if (/^(?:📜|📊|📥|➕|➖|✅|📝|💰|💵|⚖️|📄|🕧|🔗)/.test(line)) continue;
    if (/^(?:ACTION HISTORY|FINANCIAL SUMMARY|INVOICE)/i.test(line)) continue;
    if (/^└─>/.test(line)) continue;
    if (/^\/(?:baraka|ikhlas|koreta|amount|add|note|paid|edit)\b/i.test(line)) continue;

    // Pattern: '1. ...' or '1) ...' or '• ...'
    if (/^(?:\d+[\.\)]|[•\-])\s+\S+/.test(line)) {
      itemLineCount++;
    } else if (/\b\d+(?:[.,]\d+)?\s*(?:kg|ta|g|pcs|box|개|근|박스)?\s*(?:[xX×\*]|@)\s*[₩\d]/i.test(line)) {
      itemLineCount++;
    } else if (/\b\d+(?:[.,]\d+)?\s*(?:kg|ta|g|pcs|box|개|근|박스)\s*=\s*[₩\d]/i.test(line)) {
      itemLineCount++;
    } else if (/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:kg|ta)?\s*(?:[xX×\*])\s*(\d+(?:[.,]\d+)?)/i.test(line)) {
      itemLineCount++;
    }
  }
  return itemLineCount > 0;
}

/**
 * Extracts the itemized content section from a raw message or bot-rendered text invoice.
 */
export function extractItemizedTextFromMessage(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();

  if (trimmed.includes('📄📄📄') || trimmed.includes('📥📥📥') || /ACTION HISTORY/i.test(trimmed)) {
    const cleaned = extractCleanItemizedItems(trimmed);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  // If text contains ACTION HISTORY, items are before ACTION HISTORY
  const historyIdx = trimmed.search(/(?:^|\n)━+\s*\n📜\s*ACTION HISTORY/i);
  const content = historyIdx !== -1 ? trimmed.substring(0, historyIdx).trim() : trimmed;

  const lines = content.split(/\r?\n/).map((l) => l.trimEnd());
  const itemLines: string[] = [];
  let pastHeader = false;

  // Check if content starts with bot header
  if (lines.length > 0 && /^━+$/.test(lines[0].trim())) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!pastHeader) {
        if (/^🏢/.test(line)) {
          pastHeader = true;
        }
        continue;
      }
      if (/^━+$/.test(line)) break;
      itemLines.push(lines[i]);
    }
    const result = itemLines.join('\n').trim();
    if (result.length > 0) return result;
  }

  return content;
}

export interface BuildUnifiedInvoiceCaptionParams {
  invoiceId: number;
  title?: string;
  distributor?: DistributorSnapshot | null;
  itemsBreakdown?: string | null;
  originalText?: string | null;
  isItemized?: boolean;
  isMedia?: boolean;
  receivedAt: string;
  initialAmount?: number | null;
  currentAmount?: number | null;
  additions?: InvoiceAdditionEvent[];
  payments?: PaymentEvent[];
  notes?: InvoiceNote[];
  maxCaptionLength?: number;
  hasSeparateAccountControlMessage?: boolean;
}

/**
 * Extracts clean itemized content without redundant titles, headers, or action history.
 */
export function extractCleanItemizedItems(rawText: string): string {
  if (!rawText) return '';
  const trimmed = rawText.trim();

  // If already contains 📄📄📄, extract what is under 📄📄📄
  const docIdx = trimmed.search(/(?:^|\n)📄📄📄/);
  let content = trimmed;
  if (docIdx !== -1) {
    content = trimmed.substring(docIdx).replace(/^(?:\r?\n)?📄📄📄\s*/, '');
  }

  // Cut off at action history or financial summary if present
  const stopIdx = content.search(/(?:^|\n)(?:📥📥📥|➕➕➕|➖➖➖|📊📊📊|━+\s*\n(?:📜\s*)?ACTION HISTORY)/);
  if (stopIdx !== -1) {
    content = content.substring(0, stopIdx).trim();
  }

  const lines = content.split(/\r?\n/).map((l) => l.trimEnd());
  const itemLines: string[] = [];
  let started = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTrimmed = line.trim();

    if (!started) {
      if (!lineTrimmed) continue;
      if (/^🥩\s*MEAT INVOICE/i.test(lineTrimmed)) continue;
      if (/^🧾\s*INVOICE/i.test(lineTrimmed)) continue;
      if (/^📄{1,3}/i.test(lineTrimmed)) continue;
      if (/^[━─—═-]+$/.test(lineTrimmed)) continue;
      if (/^🆔\s*#?INV/i.test(lineTrimmed)) continue;
      if (/^🏦\s*Bank:/i.test(lineTrimmed)) continue;
      if (/^🔢\s*Account:/i.test(lineTrimmed)) continue;
      if (/^👤\s*Holder:/i.test(lineTrimmed)) continue;
      if (/^🏢/.test(lineTrimmed)) continue;
      started = true;
    }

    if (/^[━─—═-]+$/.test(lineTrimmed) && i > 0 && /Total/i.test(lines[i - 1] ?? '')) {
      break;
    }

    itemLines.push(line);
  }

  while (itemLines.length > 0 && /^[━─—═-]+$/.test(itemLines[itemLines.length - 1].trim())) {
    itemLines.pop();
  }

  return itemLines.join('\n').trim();
}

/**
 * Builds the unified invoice message/caption format for BOTH media-based and text-only invoices.
 *
 * Layout:
 * 1. 🆔 <b>#INV0034 • 🏢 Ikhlas Market</b> (Bold)
 * 2. Bank details (Bank, Account, Holder) if present and not in separate control message
 * 3. 📄📄📄 + itemized list (ONLY if text-only itemized invoice; omitted for media)
 *    OR clean invoice-specific text for text-only non-itemized invoices
 * 4. 📥📥📥 (Registration event)
 * 5. ➕➕➕ (Invoice additions)
 * 6. ➖➖➖ (Payments)
 * 7. 📊📊📊 (Financial summary with <b>⚖️ Need to Pay: ...</b> bold)
 */
export function buildUnifiedInvoiceCaption(params: BuildUnifiedInvoiceCaptionParams): string {
  const maxLen = params.maxCaptionLength ?? 1024;
  const additions = params.additions ?? [];
  const payments = params.payments ?? [];
  const notes = params.notes ?? [];

  const summary = computeInvoiceFinancialSummary({
    initialAmount: params.initialAmount,
    currentAmount: params.currentAmount,
    additions,
    payments,
  });

  // ── 1. Header (Bold) ──────────────────────────────────────
  const invIdStr = formatInvoiceId(params.invoiceId);
  const distName = params.distributor?.name?.trim();
  const header = distName
    ? `🆔 <b>${invIdStr} • 🏢 ${escapeHtml(distName)}</b>`
    : `🆔 <b>${invIdStr}</b>`;

  // ── 2. Bank Details ───────────────────────────────────────
  const bankLines: string[] = [];
  if (params.distributor && !params.hasSeparateAccountControlMessage) {
    const bankName = params.distributor.bankName?.trim();
    const accountNumber = params.distributor.accountNumber?.trim();
    const accountHolder = params.distributor.accountHolder?.trim();
    if (bankName) bankLines.push(`🏦 Bank: ${escapeHtml(bankName)}`);
    if (accountNumber) bankLines.push(`🔢 Account: ${escapeHtml(accountNumber)}`);
    if (accountHolder) bankLines.push(`👤 Holder: ${escapeHtml(accountHolder)}`);
  }

  // ── 3. Invoice-Specific Content (ONLY for text-only invoices) ─
  let itemSection: string | null = null;
  if (!params.isMedia) {
    const rawItems = params.originalText || params.itemsBreakdown || '';
    if (params.isItemized) {
      const cleanItems = extractCleanItemizedItems(rawItems);
      if (cleanItems.length > 0) {
        itemSection = `📄📄📄\n\n${cleanItems}`;
      }
    } else if (rawItems) {
      const clean = stripDuplicateTotalLines(rawItems);
      if (clean.length > 0) {
        itemSection = clean;
      }
    }
  }

  // ── 4. Action History ─────────────────────────────────────
  const regAmt = summary.originalAmount !== null ? formatAmount(summary.originalAmount) : 'Not set';
  const regLines: string[] = [
    '📥📥📥',
    '',
    `🕧 ${formatTimestamp(params.receivedAt)}`,
    `💰 ${regAmt}`,
  ];
  const regNote = notes.find((n) => n.createdAt === params.receivedAt || !n.createdAt);
  if (regNote) {
    regLines.push(`📝 Note: ${escapeHtml(regNote.text)}`);
  }
  const registrationBlock = regLines.join('\n');

  type HistoryItem =
    | { type: 'addition'; date: string; amount: number; note?: string | null }
    | { type: 'note'; date: string; text: string }
    | { type: 'payment'; date: string; amount: number; note?: string | null; receiptUrl?: string | null };

  const eventList: HistoryItem[] = [];

  for (const a of additions) {
    eventList.push({
      type: 'addition',
      date: a.addedAt,
      amount: a.amount,
      note: a.note,
    });
  }

  for (const n of notes) {
    if (n !== regNote) {
      eventList.push({
        type: 'note',
        date: n.createdAt,
        text: n.text,
      });
    }
  }

  for (const p of payments) {
    eventList.push({
      type: 'payment',
      date: p.paidAt,
      amount: p.amount,
      note: p.note,
      receiptUrl: p.receiptUrl,
    });
  }

  eventList.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const formatEventBlock = (item: HistoryItem): string => {
    if (item.type === 'addition') {
      const lines = [
        '➕➕➕',
        '',
        `🕧 ${formatTimestamp(item.date)}`,
        `💰 ${formatAmount(item.amount)}`,
      ];
      if (item.note) {
        lines.push(`📝 Note: ${escapeHtml(item.note)}`);
      }
      return lines.join('\n');
    }
    if (item.type === 'note') {
      return `📝 Note: ${escapeHtml(item.text)}`;
    }
    if (item.type === 'payment') {
      const lines = [
        '➖➖➖',
        '',
        `🕧 ${formatTimestamp(item.date)}`,
        `💰 ${formatAmount(item.amount)}`,
      ];
      if (item.receiptUrl) {
        lines.push(`🔗 Receipt URL: ${item.receiptUrl}`);
      }
      if (item.note) {
        lines.push(`📝 Note: ${escapeHtml(item.note)}`);
      }
      return lines.join('\n');
    }
    return '';
  };

  const allEventBlocks = eventList.map(formatEventBlock).filter((b) => b.length > 0);

  // ── 5. Financial Summary (Need to Pay in bold) ─────────────
  const summaryLines = [
    '📊📊📊',
    '',
    `💰 Invoice Total: ${formatAmount(summary.currentInvoiceTotal)}`,
    `💵 Total Paid: ${formatAmount(summary.totalPaid)}`,
    `<b>⚖️ Need to Pay: ${formatAmount(summary.balanceDue)}</b>`,
  ];
  const summaryBlock = summaryLines.join('\n');

  const assemble = (eventBlocks: string[]): string => {
    const parts: string[] = [header];
    if (bankLines.length > 0) {
      parts.push(bankLines.join('\n'));
    }
    if (itemSection) {
      parts.push(itemSection);
    }
    parts.push(registrationBlock);
    if (eventBlocks.length > 0) {
      parts.push(...eventBlocks);
    }
    parts.push(summaryBlock);
    return parts.join('\n\n');
  };

  const fullCaption = assemble(allEventBlocks);
  if (fullCaption.length <= maxLen) {
    return fullCaption;
  }

  // Length overflow compaction: preserve registration and latest events
  for (let keep = eventList.length - 1; keep >= 0; keep--) {
    const hidden = eventList.length - keep;
    const keptEvents = eventList.slice(hidden);
    const compactedBlocks = [
      `... (${hidden} earlier events preserved in history) ...`,
      ...keptEvents.map(formatEventBlock).filter((b) => b.length > 0),
    ];
    const compacted = assemble(compactedBlocks);
    if (compacted.length <= maxLen) {
      return compacted;
    }
  }

  const minimalBlocks = [
    `... (${eventList.length} earlier events preserved in history) ...`,
  ];
  return assemble(minimalBlocks);
}

export interface BuildItemizedInvoiceParams {
  invoiceId: number;
  distributor?: DistributorSnapshot | null;
  originalText: string;
  receivedAt: string;
  initialAmount?: number | null;
  currentAmount?: number | null;
  additions?: InvoiceAdditionEvent[];
  payments?: PaymentEvent[];
  notes?: InvoiceNote[];
  hasSeparateAccountControlMessage?: boolean;
}

export function buildItemizedTextInvoiceMessage(params: BuildItemizedInvoiceParams): string {
  return buildUnifiedInvoiceCaption({
    invoiceId: params.invoiceId,
    distributor: params.distributor,
    originalText: params.originalText,
    isItemized: true,
    receivedAt: params.receivedAt,
    initialAmount: params.initialAmount,
    currentAmount: params.currentAmount,
    additions: params.additions,
    payments: params.payments,
    notes: params.notes,
    maxCaptionLength: MAX_TEXT_LENGTH,
    hasSeparateAccountControlMessage: params.hasSeparateAccountControlMessage,
  });
}

export interface AdditionsBreakdown {
  initialAmount: number;
  initialTimestamp?: string;
  additions: Array<{ amount: number; addedAt: string; note?: string | null }>;
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
  },
  additionsBreakdown?: AdditionsBreakdown,
  payments?: PaymentEvent[]
): string {
  if (invoiceId !== undefined && receivedAt) {
    return buildUnifiedInvoiceCaption({
      invoiceId,
      distributor,
      receivedAt,
      initialAmount: additionsBreakdown?.initialAmount ?? amount,
      currentAmount: amount,
      additions: additionsBreakdown?.additions?.map((a) => ({
        amount: a.amount,
        addedAt: a.addedAt,
        note: a.note,
      })),
      payments,
      notes,
    });
  }

  // Fallback for calls without invoiceId
  const lines: string[] = [METADATA_SEPARATOR];
  if (distributor) {
    lines.push(`🏢 ${distributor.name}`);
    lines.push(`🏦 ${distributor.bankName}`);
    lines.push(`💳 ${distributor.accountNumber}`);
    lines.push(`👤 ${distributor.accountHolder}`);
  }
  if (amount !== null) {
    lines.push(`💰 ${formatAmount(amount)}`);
  }
  lines.push(METADATA_SEPARATOR);
  return lines.join('\n');
}

/**
 * Formats the superseded caption for the original invoice message in the Pending topic
 * after /add creates a new updated invoice message.
 * Removes all keyboards and shows only invoice ID, link/status, and the warning text:
 * ⚠️ Should be deleted manually!
 */
export function formatSupersededInvoiceCaption(
  invoiceId: number,
  updatedInvoiceUrl: string
): string {
  const invStr = formatInvoiceId(invoiceId);
  return `⚠️ Invoice ${invStr} was updated.\n\n🔗 Updated invoice: <a href="${updatedInvoiceUrl}">View updated invoice</a>\n\n🗑 Please delete this original message manually if no longer needed.`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats the separate account-control message in the Pending topic.
 * Contains only the bank details and no duplicate invoice caption.
 */
export function formatAccountControlMessage(
  invoiceId: number,
  distributor: DistributorSnapshot
): string {
  const invStr = formatInvoiceId(invoiceId);
  const lines: string[] = [`💳 <b>Account details for ${invStr}:</b>`];
  if (distributor.bankName) {
    lines.push(`🏦 Bank: <b>${escapeHtml(distributor.bankName)}</b>`);
  }
  if (distributor.accountNumber) {
    lines.push(`🔢 Account: <code>${escapeHtml(distributor.accountNumber)}</code>`);
  }
  if (distributor.accountHolder) {
    lines.push(`👤 Holder: <b>${escapeHtml(distributor.accountHolder)}</b>`);
  }
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
 * Formats the identifiable caption for receipt media copied to Confirmed topic,
 * ensuring no orphaned, unidentifiable media records are ever created.
 */
export function formatReceiptCaption(params: {
  invoiceId: number;
  distributorName: string | null;
  bankDetails?: string | null;
  originalAmount?: number | null;
  additionsTotal?: number | null;
  currentInvoiceTotal?: number | null;
  paymentAmount: number;
  cumulativePaid: number;
  remainingBalance: number;
  status: 'PARTIALLY_PAID' | 'PAID';
  paidAt: string;
  note?: string;
}): string {
  const isPartial = params.status === 'PARTIALLY_PAID';
  const statusStr = isPartial ? '⏳ PARTIALLY PAID' : '✅ PAID';
  const lines: string[] = [];

  if (params.note) {
    lines.push(`🧾 Payment Receipt: ${params.note} • ${formatInvoiceId(params.invoiceId)}`);
  } else {
    lines.push(`🧾 Payment Receipt • ${formatInvoiceId(params.invoiceId)}`);
  }

  if (params.distributorName) {
    const bankStr = params.bankDetails ? ` • ${params.bankDetails}` : '';
    lines.push(`🏢 ${params.distributorName}${bankStr}`);
  }

  if (params.originalAmount !== undefined && params.originalAmount !== null) {
    const addStr =
      params.additionsTotal && params.additionsTotal > 0
        ? ` | ➕ Additions: ${formatAmount(params.additionsTotal)}`
        : '';
    lines.push(`📥 Original: ${formatAmount(params.originalAmount)}${addStr}`);
  }

  if (params.currentInvoiceTotal !== undefined && params.currentInvoiceTotal !== null) {
    lines.push(`💰 Invoice Total: ${formatAmount(params.currentInvoiceTotal)}`);
  }

  lines.push(`💵 Amount Received: ${formatAmount(params.paymentAmount)}`);
  lines.push(`📊 Total Paid: ${formatAmount(params.cumulativePaid)}`);
  lines.push(`⚖️ Remaining Balance: ${formatAmount(params.remainingBalance)}`);
  lines.push(`⏳ Status: ${statusStr}`);
  lines.push(`💸 Paid At: ${formatTimestamp(params.paidAt)}`);

  return lines.join('\n');
}

/**
 * Formats the confirmation record message sent to the Confirmed topic.
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
    originalAmount?: number | null;
    additionsTotal?: number | null;
    bankDetails?: string | null;
    accountHolder?: string | null;
    receiptUrl?: string | null;
  }
): string {
  const isPartial = paymentDetails?.status === 'PARTIALLY_PAID';
  const lines: string[] = ['━━━━━━━━━━━━'];
  if (isPartial) {
    lines.push(invoiceId ? `⏳ PARTIALLY PAID • ${formatInvoiceId(invoiceId)}` : '⏳ PARTIALLY PAID');
  } else {
    lines.push(invoiceId ? `✅ PAID • ${formatInvoiceId(invoiceId)}` : '✅ PAID');
  }
  lines.push('━━━━━━━━━━━━');
  lines.push('');
  lines.push(`🏢 ${distributorName ?? 'Not specified'}`);
  if (paymentDetails?.bankDetails) {
    const bankStr =
      paymentDetails.bankDetails.startsWith('💳') || paymentDetails.bankDetails.startsWith('🏦')
        ? paymentDetails.bankDetails
        : `💳 ${paymentDetails.bankDetails}`;
    lines.push(bankStr);
  }
  if (
    paymentDetails?.accountHolder &&
    (!paymentDetails.bankDetails || !paymentDetails.bankDetails.includes(paymentDetails.accountHolder))
  ) {
    const holderStr = paymentDetails.accountHolder.startsWith('👤')
      ? paymentDetails.accountHolder
      : `👤 ${paymentDetails.accountHolder}`;
    lines.push(holderStr);
  }

  // Invoice amounts breakdown
  if (paymentDetails?.originalAmount !== undefined && paymentDetails.originalAmount !== null) {
    lines.push('');
    lines.push(`📥 Original Invoice: ${formatAmount(paymentDetails.originalAmount)}`);
  }
  if (
    paymentDetails?.additionsTotal !== undefined &&
    paymentDetails.additionsTotal !== null &&
    paymentDetails.additionsTotal > 0
  ) {
    if (paymentDetails.originalAmount === undefined || paymentDetails.originalAmount === null) {
      lines.push('');
    }
    lines.push(`➕ Total Added: ${formatAmount(paymentDetails.additionsTotal)}`);
  }
  if (amount !== null) {
    if (
      (paymentDetails?.originalAmount === undefined || paymentDetails.originalAmount === null) &&
      (!paymentDetails?.additionsTotal || paymentDetails.additionsTotal <= 0)
    ) {
      lines.push('');
    }
    if (paymentDetails?.additionsTotal && paymentDetails.additionsTotal > 0) {
      lines.push(`💰 Updated Total: ${formatAmount(amount)}`);
    } else {
      lines.push(`💰 Total: ${formatAmount(amount)}`);
    }
  }

  lines.push('');
  if (paymentDetails?.paymentAmount !== undefined && paymentDetails.paymentAmount !== null) {
    lines.push(`💵 Payment: ${formatAmount(paymentDetails.paymentAmount)}`);
  }
  if (paymentDetails?.cumulativePaid !== undefined && paymentDetails.cumulativePaid !== null) {
    lines.push(`📊 Total Paid: ${formatAmount(paymentDetails.cumulativePaid)}`);
  }
  if (
    paymentDetails?.remainingBalance !== undefined &&
    paymentDetails.remainingBalance !== null
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

  if (paymentDetails?.receiptUrl) {
    lines.push('');
    lines.push(`🧾 Receipt: [View payment receipt](${paymentDetails.receiptUrl})`);
    lines.push(`└─> 🔗 ${paymentDetails.receiptUrl}`);
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
