import { loadConfig } from './config/config';
import { initDatabase, closeDatabase } from './database/database';
import { createBot } from './bot/bot';

async function main(): Promise<void> {
  console.log('🚀 PayTrack Bot V1 starting...');

  // ─── Load configuration ────────────────────────────────────
  try {
    const config = loadConfig();
    console.log(`✅ Config loaded (Group: ${config.telegramGroupId}, Admins: ${config.adminUserIds.length})`);
  } catch (err: unknown) {
    console.error('❌ Configuration error:', (err as Error).message);
    process.exit(1);
  }

  // ─── Initialize database ───────────────────────────────────
  try {
    initDatabase();
  } catch (err: unknown) {
    console.error('❌ Database error:', (err as Error).message);
    process.exit(1);
  }

  // ─── Create and start bot ──────────────────────────────────
  const { bot, start } = createBot();

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`);
    bot.stop();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await start();
  } catch (err: unknown) {
    console.error('❌ Failed to start bot:', (err as Error).message);
    closeDatabase();
    process.exit(1);
  }
}

main();
