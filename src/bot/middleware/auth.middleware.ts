import { getConfig } from '../../config/config';
import type { Context, NextFunction } from 'grammy';

/**
 * Checks whether a user ID is in the admin allowlist.
 */
export function isAdmin(userId: number): boolean {
  const config = getConfig();
  return config.adminUserIds.includes(userId);
}

/**
 * Middleware that rejects non-admin users with a silent ignore.
 * Use this to guard admin-only handlers.
 */
export async function requireAdmin(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    // Silently ignore unauthorized attempts — don't leak info about admin commands
    return;
  }
  await next();
}
