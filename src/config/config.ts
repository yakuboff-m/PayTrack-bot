import 'dotenv/config';

export interface Config {
  botToken: string;
  telegramGroupId: number;
  pendingTopicId: number;
  confirmedTopicId: number;
  adminUserIds: number[];
}

export function getBotIdFromToken(token: string): number {
  const rawId = token.split(':')[0];
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    throw new Error('Invalid BOT_TOKEN format; cannot extract bot ID from token.');
  }
  return id;
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

export function parseAdminIds(raw: string | undefined | null): number[] {
  if (!raw || typeof raw !== 'string') {
    return [];
  }
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return entries.map((s) => {
    if (!/^\d+$/.test(s)) {
      throw new Error(`Invalid admin user ID: "${s}"`);
    }
    const id = parseInt(s, 10);
    if (isNaN(id) || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid admin user ID: "${s}"`);
    }
    return id;
  });
}

function parseRequiredInt(val: string | number | undefined, name: string): number {
  if (val === undefined || val === null || String(val).trim() === '') {
    throw new Error(`Missing ${name} in environment`);
  }
  const parsed = parseInt(String(val).trim(), 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: "${val}"`);
  }
  return parsed;
}

export function parseConfigFromEnv(env: {
  BOT_TOKEN?: string;
  TELEGRAM_GROUP_ID?: string | number;
  TELEGRAM_PENDING_TOPIC_ID?: string | number;
  TELEGRAM_CONFIRMED_TOPIC_ID?: string | number;
  TELEGRAM_ADMIN_USER_IDS?: string;
}): Config {
  if (!env.BOT_TOKEN || env.BOT_TOKEN.trim() === '') {
    throw new Error('Missing BOT_TOKEN in environment');
  }
  if (!env.TELEGRAM_ADMIN_USER_IDS || env.TELEGRAM_ADMIN_USER_IDS.trim() === '') {
    throw new Error('Missing TELEGRAM_ADMIN_USER_IDS in environment');
  }

  const adminUserIds = parseAdminIds(String(env.TELEGRAM_ADMIN_USER_IDS));
  if (adminUserIds.length === 0) {
    throw new Error('TELEGRAM_ADMIN_USER_IDS must contain at least one user ID');
  }

  return {
    botToken: env.BOT_TOKEN.trim(),
    telegramGroupId: parseRequiredInt(env.TELEGRAM_GROUP_ID, 'TELEGRAM_GROUP_ID'),
    pendingTopicId: parseRequiredInt(env.TELEGRAM_PENDING_TOPIC_ID, 'TELEGRAM_PENDING_TOPIC_ID'),
    confirmedTopicId: parseRequiredInt(env.TELEGRAM_CONFIRMED_TOPIC_ID, 'TELEGRAM_CONFIRMED_TOPIC_ID'),
    adminUserIds,
  };
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
