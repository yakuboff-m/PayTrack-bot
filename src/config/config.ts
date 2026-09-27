import 'dotenv/config';

export interface Config {
  botToken: string;
  telegramGroupId: number;
  pendingTopicId: number;
  confirmedTopicId: number;
  adminUserIds: number[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseIntEnv(name: string): number {
  const raw = requireEnv(name);
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
  }
  return parsed;
}

function parseAdminIds(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const id = parseInt(s, 10);
      if (isNaN(id)) {
        throw new Error(`Invalid admin user ID: "${s}"`);
      }
      return id;
    });
}

export function loadConfig(): Config {
  const adminRaw = requireEnv('TELEGRAM_ADMIN_USER_IDS');
  const adminUserIds = parseAdminIds(adminRaw);

  if (adminUserIds.length === 0) {
    throw new Error('TELEGRAM_ADMIN_USER_IDS must contain at least one user ID');
  }

  return {
    botToken: requireEnv('BOT_TOKEN'),
    telegramGroupId: parseIntEnv('TELEGRAM_GROUP_ID'),
    pendingTopicId: parseIntEnv('TELEGRAM_PENDING_TOPIC_ID'),
    confirmedTopicId: parseIntEnv('TELEGRAM_CONFIRMED_TOPIC_ID'),
    adminUserIds,
  };
}

// Singleton config instance — loaded once at startup
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
