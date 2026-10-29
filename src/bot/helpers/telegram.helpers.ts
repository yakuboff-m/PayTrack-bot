import type { Message } from 'grammy/types';

/**
 * Builds a clickable Telegram message link for a supergroup message.
 * Format: https://t.me/c/{numericId}/{messageId}
 * The numericId is the supergroup ID without the -100 prefix.
 */
export function buildMessageLink(chatId: number | string, messageId: number): string {
  const chatIdStr = String(chatId);
  // Supergroup IDs look like -100XXXXXXXXXX — strip the "-100" prefix
  const numericId = chatIdStr.replace(/^-100/, '');
  return `https://t.me/c/${numericId}/${messageId}`;
}

/**
 * Detects the type of a Telegram message for handling purposes.
 */
export function detectMessageType(msg: Message): 'photo' | 'document' | 'text' {
  if (msg.photo && msg.photo.length > 0) return 'photo';
  if (msg.document) return 'document';
  return 'text';
}

/**
 * Extracts media file ID and type from a Telegram message if present.
 */
export function extractMediaInfo(msg?: Message | null): {
  mediaFileId: string | null;
  mediaType: 'photo' | 'document' | null;
} {
  if (!msg) return { mediaFileId: null, mediaType: null };
  if (msg.photo && msg.photo.length > 0) {
    return {
      mediaFileId: msg.photo[msg.photo.length - 1].file_id,
      mediaType: 'photo',
    };
  }
  if (msg.document) {
    return {
      mediaFileId: msg.document.file_id,
      mediaType: 'document',
    };
  }
  return { mediaFileId: null, mediaType: null };
}

/**
 * Gets the user-visible text content of a message (text or caption).
 */
export function getMessageText(msg: Message): string | undefined {
  return msg.text ?? msg.caption ?? undefined;
}

/**
 * Checks if a message is from a bot.
 */
export function isFromBot(msg: Message): boolean {
  return msg.from?.is_bot === true;
}

/**
 * Checks if a message text starts with a / command.
 */
export function isCommand(msg: Message): boolean {
  const text = msg.text ?? msg.caption ?? '';
  return text.trimStart().startsWith('/');
}

/**
 * The sentinel separator used to delimit original content from bot-appended metadata.
 * This must be consistent across all edits to allow deterministic replacement.
 */
export const METADATA_SEPARATOR = '━━━━━━━━━━━━';

/**
 * Splits a text/caption into the original content and the bot-appended metadata block.
 * Returns { original, metadata } where metadata may be null if no separator exists.
 */
export function splitOriginalAndMetadata(text: string): {
  original: string;
  metadata: string | null;
} {
  if (!text) return { original: '', metadata: null };

  // First, look for ACTION HISTORY separator (common in bot-rendered messages)
  const actionHistoryPattern = /\n(━━━━━━━━━━━━\s*\n(?:📜\s*)?ACTION HISTORY[\s\S]*)$/i;
  const ahMatch = text.match(actionHistoryPattern);
  if (ahMatch && ahMatch.index !== undefined) {
    const sepIndex = ahMatch.index + 1;
    const original = text.substring(0, sepIndex).trimEnd();
    const metadata = text.substring(sepIndex);
    return { original, metadata };
  }

  // Delimiter for metadata block: METADATA_SEPARATOR preceded by newline and followed by an invoice identifier/field
  const metadataBlockPattern = /\n(━━━━━━━━━━━━\s*\n(?:🆔|🏢|🏦|💳|👤|💰|📅|📝)[\s\S]*)$/;
  const match = text.match(metadataBlockPattern);
  if (match && match.index !== undefined) {
    const sepIndex = match.index + 1;
    const original = text.substring(0, sepIndex).trimEnd();
    const metadata = text.substring(sepIndex);
    return { original, metadata };
  }

  // Exact single line of 12 chars (METADATA_SEPARATOR) preceded by newline
  const exactLinePattern = /\n(━━━━━━━━━━━━)(?:\r?\n|$)/;
  const lineMatch = text.match(exactLinePattern);
  if (lineMatch && lineMatch.index !== undefined) {
    const sepIndex = lineMatch.index + 1;
    const original = text.substring(0, sepIndex).trimEnd();
    const metadata = text.substring(sepIndex);
    return { original, metadata };
  }

  return { original: text, metadata: null };
}

/**
 * Composes final message text by joining original content with new metadata.
 * Always preserves the original text exactly.
 */
export function composeMessageText(originalText: string, metadataBlock: string): string {
  return `${originalText}\n\n${metadataBlock}`;
}

/**
 * Checks if a message is a forum topic action/service message (e.g. topic creation message).
 */
export function isTopicServiceMessage(msg: Message): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMsg = msg as any;
  return Boolean(
    anyMsg.forum_topic_created !== undefined ||
    anyMsg.forum_topic_edited !== undefined ||
    anyMsg.forum_topic_closed !== undefined ||
    anyMsg.forum_topic_reopened !== undefined ||
    anyMsg.general_forum_topic_hidden !== undefined ||
    anyMsg.general_forum_topic_unhidden !== undefined
  );
}

/**
 * Returns the genuine replied message targeted by the user.
 * In Telegram supergroups with forum topics enabled, Telegram automatically populates
 * `reply_to_message` with the topic creation message (where message_id === message_thread_id
 * or forum_topic_created is present) when a user posts directly into a topic thread without
 * replying to any message.
 * This helper filters out such container/service messages so handlers never treat the topic
 * root as an invoice or transaction message.
 */
export function getEffectiveRepliedMessage(msg: Message): Message | undefined {
  const replied = msg.reply_to_message;
  if (!replied) return undefined;

  // If the replied message is the topic creation message itself, it is not a genuine reply
  if (msg.message_thread_id !== undefined && replied.message_id === msg.message_thread_id) {
    return undefined;
  }

  // If the replied message is a forum topic action/service message
  if (isTopicServiceMessage(replied)) {
    return undefined;
  }

  return replied;
}

/**
 * Checks if a message is a genuine reply to another user message (not a topic container).
 */
export function isReply(msg: Message): boolean {
  return getEffectiveRepliedMessage(msg) !== undefined;
}


/** Telegram's maximum message text/caption length */
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;

/**
 * Cleans the original invoice caption/text by preserving ONLY the invoice identifier
 * and appending the new payment/status text, removing everything else (no unwanted manual-deletion text).
 */
export function cleanInvoiceCaption(
  originalCaptionOrText: string,
  statusText: string,
  maxLen: number = MAX_CAPTION_LENGTH
): string {
  const invoiceIdMatch =
    originalCaptionOrText.match(/(?:🆔\s*)?#?INV-?\d+\b/i) ||
    originalCaptionOrText.match(/(?:^|[^\w])#\d+\b/);
  const idPrefix = invoiceIdMatch ? invoiceIdMatch[0].trim() : '';

  let cleaned: string;
  if (idPrefix) {
    cleaned = idPrefix.startsWith('🆔')
      ? `${idPrefix} • ${statusText}`
      : `🆔 ${idPrefix} • ${statusText}`;
  } else {
    cleaned = statusText;
  }

  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return cleaned.substring(0, maxLen);
}

/**
 * Splits a text message cleanly into sequential chunks that strictly respect Telegram's MAX_TEXT_LENGTH (4096 code units).
 * Attempts to break on paragraph boundaries (\n\n), then line breaks (\n), then spaces, avoiding slicing words.
 */
export function splitTextMessage(
  text: string,
  maxLen: number = MAX_TEXT_LENGTH
): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx === -1 || splitIdx < Math.floor(maxLen / 2)) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx === -1 || splitIdx < Math.floor(maxLen / 2)) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx === -1 || splitIdx === 0) {
      splitIdx = maxLen;
    }

    // Guard against splitting inside a UTF-16 surrogate pair
    if (splitIdx > 0 && splitIdx < remaining.length) {
      const code = remaining.charCodeAt(splitIdx - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        splitIdx--;
      }
    }

    chunks.push(remaining.substring(0, splitIdx).trimEnd());
    remaining = remaining.substring(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Formats combined text for Confirmed topic by joining the PAID header with original invoice content.
 */
export function formatConfirmedInvoiceContent(
  headerText: string,
  originalContent?: string | null
): string {
  const trimmedOriginal = (originalContent ?? '').trim();
  if (!trimmedOriginal) {
    return headerText;
  }
  return `${headerText}\n\n${trimmedOriginal}`;
}

/**
 * Classifies whether a Telegram API error reliably indicates that the message
 * lacks editable text (i.e. it is a media message such as a photo or document).
 * Telegram Bot API returns "Bad Request: there is no text in the message to edit".
 */
export function isNoTextMessageError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('there is no text in the message to edit') ||
    msg.includes('message to edit has no text') ||
    msg.includes('no text in the message')
  );
}
