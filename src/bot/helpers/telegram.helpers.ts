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
  const sepIndex = text.indexOf(METADATA_SEPARATOR);
  if (sepIndex === -1) {
    return { original: text, metadata: null };
  }
  // Original is everything before the separator (trimmed of trailing whitespace)
  const original = text.substring(0, sepIndex).trimEnd();
  // Metadata is everything from the separator onward
  const metadata = text.substring(sepIndex);
  return { original, metadata };
}

/**
 * Composes final message text by joining original content with new metadata.
 * Always preserves the original text exactly.
 */
export function composeMessageText(originalText: string, metadataBlock: string): string {
  return `${originalText}\n\n${metadataBlock}`;
}

/**
 * Checks if a message is a reply to another message (has reply_to_message).
 */
export function isReply(msg: Message): boolean {
  return msg.reply_to_message !== undefined;
}

/** Telegram's maximum message text/caption length */
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;
