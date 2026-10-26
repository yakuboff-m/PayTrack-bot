import type { Message, PhotoSize, Document } from 'grammy/types';

export interface TrackedMessage {
  message_id: number;
  chat_id: number | string;
  message_thread_id?: number;
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: Document;
  date: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reply_to_message?: any;
}

export class MessageTracker {
  private messages = new Map<string, TrackedMessage>();
  private readonly maxEntries = 500;

  private makeKey(chatId: number | string, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  record(msg: Message): void {
    if (!msg || !msg.message_id || !msg.chat) return;
    const key = this.makeKey(msg.chat.id, msg.message_id);
    this.messages.set(key, {
      message_id: msg.message_id,
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      from: msg.from,
      text: msg.text,
      caption: msg.caption,
      photo: msg.photo,
      document: msg.document,
      date: msg.date,
      reply_to_message: msg.reply_to_message,
    });

    if (this.messages.size > this.maxEntries) {
      const oldestKey = this.messages.keys().next().value;
      if (oldestKey) this.messages.delete(oldestKey);
    }
  }

  get(chatId: number | string, messageId: number): TrackedMessage | undefined {
    return this.messages.get(this.makeKey(chatId, messageId));
  }

  delete(chatId: number | string, messageId: number): void {
    this.messages.delete(this.makeKey(chatId, messageId));
  }

  findPrecedingMessage(
    chatId: number | string,
    threadId: number | undefined,
    beforeMessageId: number,
    fromUserId?: number
  ): TrackedMessage | undefined {
    const candidates: TrackedMessage[] = [];
    for (const msg of this.messages.values()) {
      if (String(msg.chat_id) === String(chatId) && msg.message_id < beforeMessageId) {
        if (threadId === undefined || msg.message_thread_id === threadId) {
          if (!fromUserId || msg.from?.id === fromUserId) {
            candidates.push(msg);
          }
        }
      }
    }

    if (candidates.length === 0 && fromUserId) {
      for (const msg of this.messages.values()) {
        if (String(msg.chat_id) === String(chatId) && msg.message_id < beforeMessageId) {
          if (threadId === undefined || msg.message_thread_id === threadId) {
            candidates.push(msg);
          }
        }
      }
    }

    candidates.sort((a, b) => b.message_id - a.message_id);
    return candidates[0];
  }

  clear(): void {
    this.messages.clear();
  }
}

export const globalMessageTracker = new MessageTracker();
