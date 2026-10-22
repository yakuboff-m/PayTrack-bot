export interface Env {
  paytrack_bot_db: D1Database;
  BOT_TOKEN: string;
  TELEGRAM_GROUP_ID: string;
  TELEGRAM_PENDING_TOPIC_ID: string;
  TELEGRAM_CONFIRMED_TOPIC_ID: string;
  TELEGRAM_ADMIN_USER_IDS: string;
  WEBHOOK_SECRET: string;
}
