// ─── Distributor ──────────────────────────────────────────────

export interface Distributor {
  id: number;
  name: string;
  alias: string;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  createdAt: string;
  updatedAt: string;
}

export interface DistributorSnapshot {
  name: string;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
}

export interface CreateDistributorInput {
  name: string;
  alias: string;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
}

export interface UpdateDistributorInput {
  name?: string;
  alias?: string;
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
}

// ─── Transaction ─────────────────────────────────────────────

export type TransactionStatus = 'PENDING' | 'PAID';

export interface Transaction {
  id: number;
  telegramChatId: string;
  pendingTopicId: number;
  originalMessageId: number;
  distributorId: number | null;
  distributorSnapshot: DistributorSnapshot | null;
  amount: number | null;
  currency: string;
  status: TransactionStatus;
  receivedAt: string;
  paidAt: string | null;
  paymentMessageId: number | null;
  confirmationMessageId: number | null;
  confirmationUrl: string | null;
  historyMessageId: number | null;
  metadataMessageId: number | null;
  createdAt: string;
}

export interface TransactionRow {
  id: number;
  telegram_chat_id: string;
  pending_topic_id: number;
  original_message_id: number;
  distributor_id: number | null;
  distributor_snapshot: string | null;
  amount: number | null;
  currency: string;
  status: string;
  received_at: string;
  paid_at: string | null;
  payment_message_id: number | null;
  confirmation_message_id: number | null;
  confirmation_url: string | null;
  history_message_id: number | null;
  metadata_message_id: number | null;
  created_at: string;
}

export interface DistributorRow {
  id: number;
  name: string;
  alias: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  created_at: string;
  updated_at: string;
}

// ─── Conversation State (Distributor CRUD flow) ──────────────

export type ConversationStep = 'name' | 'alias' | 'bank' | 'account' | 'holder' | 'confirm';

export interface ConversationState {
  step: ConversationStep;
  action: 'add' | 'edit';
  distributorId?: number;
  data: Partial<CreateDistributorInput>;
  startedAt: number;
}

/** Key for conversation state map: `${chatId}:${userId}` */
export type ConversationKey = string;

export function makeConversationKey(chatId: number | string, userId: number): ConversationKey {
  return `${chatId}:${userId}`;
}

// ─── Confirmation result ─────────────────────────────────────

export interface ConfirmationResult {
  success: boolean;
  confirmationUrl?: string;
  error?: string;
}
