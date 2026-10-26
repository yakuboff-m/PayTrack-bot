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
      if (/^#?INV\d+\b/i.test(trimmed)) return false;
      if (/^━+$/.test(trimmed) || /^─+$/.test(trimmed) || /^-+$/.test(trimmed)) return false;
      if (/^(?:🏢|🏦|💳|👤|🔢)/.test(trimmed)) return false;
      if (/^(?:📜\s*)?ACTION HISTORY/i.test(trimmed)) return false;
      if (
        /^(?:📥\s*Original Registration|➕\s*Invoice Addition|➖\s*Partial payment|✅\s*Full payment|📝\s*Note:|💵\s*Registered Amount|💵\s*Amount Added|💵\s*Amount paid|🧾\s*Receipt URL)/i.test(
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

export interface BuildUnifiedInvoiceCaptionParams {
  invoiceId: number;
  title?: string;
  distributor?: DistributorSnapshot | null;
  itemsBreakdown?: string;
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
 * Builds the authoritative, append-only invoice caption with:
 * A. Invoice identity/header
 * B. Append-only action history (Registration, additions, payments with receipt links)
 * C. Current financial summary (Updated invoice total, total paid, balance due, status)
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

  // ── A. Invoice identity/header ────────────────────────────
  const headerLines: string[] = [METADATA_SEPARATOR];
  const invoiceTitle = params.title || '🧾 INVOICE';
  headerLines.push(`${invoiceTitle} • ${formatInvoiceId(params.invoiceId)}`);
  headerLines.push(METADATA_SEPARATOR);

  if (params.distributor) {
    if (!params.hasSeparateAccountControlMessage) {
      const bankLines: string[] = [];
      const bankName = params.distributor.bankName?.trim();
      const accountNumber = params.distributor.accountNumber?.trim();
      const accountHolder = params.distributor.accountHolder?.trim();

      if (bankName) {
        bankLines.push(`🏦 Bank: ${bankName}`);
      }
      if (accountNumber) {
        bankLines.push(`🔢 Account: ${accountNumber}`);
      }
      if (accountHolder) {
        bankLines.push(`👤 Holder: ${accountHolder}`);
      }
      if (bankLines.length > 0) {
        headerLines.push(...bankLines);
        headerLines.push('');
        headerLines.push(METADATA_SEPARATOR);
      }
    }

    headerLines.push(`🏢 ${params.distributor.name}`);
  }

  // ── Items breakdown (stripped of duplicate totals & header) ─
  const cleanItems = params.itemsBreakdown ? stripDuplicateTotalLines(params.itemsBreakdown) : '';
  if (cleanItems) {
    headerLines.push(cleanItems);
  }

  // ── B. Append-only action history ─────────────────────────
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
    eventList.push({
      type: 'note',
      date: n.createdAt,
      text: n.text,
    });
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

  // Chronological sort
  eventList.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const formatRegistrationBlock = (): string => {
    const regAmt = summary.originalAmount !== null ? formatAmount(summary.originalAmount) : 'Not set';
    return [
      '📥 Original Registration:',
      `└─> 🕧 ${formatTimestamp(params.receivedAt)}`,
      '💵 Registered Amount:',
      `└─> 💰 ${regAmt}`,
    ].join('\n');
  };

  const formatEventBlock = (item: HistoryItem, isLastPayment?: boolean): string => {
    if (item.type === 'addition') {
      const lines = [
        '➕ Invoice Addition',
        `└─> 🕧 ${formatTimestamp(item.date)}`,
        '💵 Amount Added:',
        `└─> 💰 ${formatAmount(item.amount)}`,
      ];
      if (item.note) {
        lines.push(`📝 Note: ${item.note}`);
      }
      return lines.join('\n');
    }
    if (item.type === 'note') {
      return `📝 Note: ${item.text}`;
    }
    if (item.type === 'payment') {
      const isFull = summary.status === 'PAID' && isLastPayment;
      const pLabel = isFull ? '✅ Full payment' : '➖ Partial payment';
      const lines = [
        pLabel,
        `└─> 🕧 ${formatTimestamp(item.date)}`,
        '💵 Amount paid:',
        `└─> 💰 ${formatAmount(item.amount)}`,
      ];
      if (item.receiptUrl) {
        lines.push('🧾 Receipt URL:');
        lines.push(`└─> 🔗 ${item.receiptUrl}`);
      }
      if (item.note) {
        lines.push(`📝 Note: ${item.note}`);
      }
      return lines.join('\n');
    }
    return '';
  };

  const paymentEvents = eventList.filter((e) => e.type === 'payment');
  const lastPayment = paymentEvents.length > 0 ? paymentEvents[paymentEvents.length - 1] : null;

  const allActionBlocks = [
    formatRegistrationBlock(),
    ...eventList.map((e) => formatEventBlock(e, e === lastPayment)),
  ];

  // ── C. Current financial summary ──────────────────────────
  const statusStr =
    summary.status === 'PAID'
      ? '✅ PAID'
      : summary.status === 'PARTIALLY_PAID'
      ? '⏳ PARTIALLY PAID'
      : '⏳ PENDING';

  const summaryLines: string[] = [
    METADATA_SEPARATOR,
    '📊 FINANCIAL SUMMARY',
    METADATA_SEPARATOR,
    `💰 Invoice Total: ${formatAmount(summary.currentInvoiceTotal)}`,
    `💵 Total Paid: ${formatAmount(summary.totalPaid)}`,
    `⚖️ Need to Pay: ${formatAmount(summary.balanceDue)}`,
    `📊 Status: ${statusStr}`,
  ];

  const assemble = (actions: string[]): string => {
    return [
      headerLines.join('\n'),
      METADATA_SEPARATOR,
      '📜 ACTION HISTORY',
      METADATA_SEPARATOR,
      actions.join('\n\n'),
      summaryLines.join('\n'),
    ].join('\n');
  };

  const fullCaption = assemble(allActionBlocks);
  if (fullCaption.length <= maxLen) {
    return fullCaption;
  }

  // Length overflow compaction: preserve registration and latest events
  for (let keep = eventList.length - 1; keep >= 0; keep--) {
    const hidden = eventList.length - keep;
    const keptEvents = eventList.slice(hidden);
    const compactedBlocks = [
      formatRegistrationBlock(),
      `... (${hidden} earlier events preserved in history) ...`,
      ...keptEvents.map((e) => formatEventBlock(e, e === lastPayment)),
    ];
    const compacted = assemble(compactedBlocks);
    if (compacted.length <= maxLen) {
      return compacted;
    }
  }

  const minimalBlocks = [
    formatRegistrationBlock(),
    `... (${eventList.length} earlier events preserved in history) ...`,
  ];
  return assemble(minimalBlocks);
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
