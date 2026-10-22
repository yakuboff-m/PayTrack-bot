import { formatAmount } from '../bot/helpers/format.helpers';

export interface MeatInvoiceItem {
  name: string;
  quantity: number;
  unit: 'kg' | 'ta';
  unitPriceKrw: number;
  lineTotal: number;
  rawLine: string;
}

export interface MeatInvoice {
  items: MeatInvoiceItem[];
  grandTotal: number;
  formattedDisplay: string;
}

export interface ParseMeatInvoiceResult {
  success: boolean;
  invoice?: MeatInvoice;
  error?: string;
}

/**
 * Parses shorthand price in thousands of KRW to integer KRW.
 * Examples:
 *   "12.7" -> 12,700
 *   "3.2"  -> 3,200
 *   "14.6" -> 14,600
 *   "12.5" -> 12,500
 *   "5.1"  -> 5,100
 *   "5"    -> 5,000
 *   "12.75"-> 12,750
 */
export function parseShorthandPrice(priceStr: string): number {
  const normalized = priceStr.replace(',', '.').trim();
  const parts = normalized.split('.');
  const whole = parseInt(parts[0], 10);
  if (isNaN(whole) || whole < 0) return 0;

  if (parts.length === 1) {
    return whole * 1000;
  }

  // Fraction part scaled to 3 digits (thousands)
  const frac = parts[1].padEnd(3, '0').slice(0, 3);
  const extraFrac = parts[1].slice(3);
  let result = whole * 1000 + parseInt(frac, 10);
  if (extraFrac.length > 0 && parseInt(extraFrac[0], 10) >= 5) {
    result += 1;
  }
  return result;
}

/**
 * Regex matching an invoice line:
 * <Item Name> <Quantity>[unit] [x|×|*] <Price>[=]
 */
const LINE_REGEX = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(kg|ta)?\s*(?:[xX×\*])\s*(\d+(?:[.,]\d+)?)\s*=?$/i;

/**
 * Parses a single meat invoice line.
 */
export function parseMeatInvoiceLine(
  rawLine: string,
  lineNumber: number
): { item?: MeatInvoiceItem; error?: string } {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return { error: `Line ${lineNumber} is empty.` };
  }

  const match = trimmed.match(LINE_REGEX);
  if (!match) {
    return {
      error: `Line ${lineNumber} is invalid: "${trimmed}". Expected format: <Item name> <quantity>[kg|ta] x <price>`,
    };
  }

  const rawItemName = match[1].trim();
  const rawQuantity = match[2].replace(',', '.');
  const rawUnit = match[3]?.toLowerCase();
  const rawPrice = match[4].replace(',', '.');

  // Check for ambiguous multiple multiplication symbols in the item name
  if (/\s+[xX×\*]\s+/.test(rawItemName) || /\b[xX×\*]\b/.test(rawItemName)) {
    return {
      error: `Line ${lineNumber} is ambiguous: "${trimmed}". Multiple multiplication signs detected.`,
    };
  }

  // Item name must not be purely numeric
  if (/^\d+$/.test(rawItemName)) {
    return {
      error: `Line ${lineNumber} is invalid: "${trimmed}". Item name cannot be purely numeric.`,
    };
  }

  const quantity = parseFloat(rawQuantity);
  if (isNaN(quantity) || quantity <= 0) {
    return {
      error: `Line ${lineNumber} is invalid: "${trimmed}". Quantity must be greater than zero.`,
    };
  }

  const unitPriceKrw = parseShorthandPrice(rawPrice);
  if (unitPriceKrw <= 0) {
    return {
      error: `Line ${lineNumber} is invalid: "${trimmed}". Price must be greater than zero.`,
    };
  }

  // Default unit is 'kg' if omitted
  const unit: 'kg' | 'ta' = rawUnit === 'ta' ? 'ta' : 'kg';

  // Calculate line total in integer KRW using safe decimal arithmetic
  const lineTotal = Math.round(quantity * unitPriceKrw);

  return {
    item: {
      name: rawItemName,
      quantity,
      unit,
      unitPriceKrw,
      lineTotal,
      rawLine: trimmed,
    },
  };
}

/**
 * Formats parsed items and total into a clean, human-readable invoice string.
 */
export function formatMeatInvoice(items: MeatInvoiceItem[], grandTotal: number): string {
  const lines: string[] = ['🧾 MEAT INVOICE', '━━━━━━━━━━━━━━━━'];

  items.forEach((item, index) => {
    const qtyStr = `${item.quantity} ${item.unit}`;
    const unitPriceStr = formatAmount(item.unitPriceKrw);
    const lineTotalStr = formatAmount(item.lineTotal);

    lines.push(`${index + 1}. ${item.name} — ${qtyStr}`);
    lines.push(`　${qtyStr} × ${unitPriceStr}`);
    lines.push(`　= ${lineTotalStr}`);
    lines.push('');
  });

  lines.push(`💰 Total: ${formatAmount(grandTotal)}`);

  return lines.join('\n');
}

/**
 * Parses multiple lines of a plain-text meat invoice.
 * Rejects if any line is malformed or ambiguous.
 */
export function parseMeatInvoice(text: string): ParseMeatInvoiceResult {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length === 0) {
    return { success: false, error: 'No invoice lines provided.' };
  }

  const items: MeatInvoiceItem[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const parsed = parseMeatInvoiceLine(rawLines[i], i + 1);
    if (parsed.error || !parsed.item) {
      return { success: false, error: parsed.error };
    }
    items.push(parsed.item);
  }

  const grandTotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const formattedDisplay = formatMeatInvoice(items, grandTotal);

  return {
    success: true,
    invoice: {
      items,
      grandTotal,
      formattedDisplay,
    },
  };
}
