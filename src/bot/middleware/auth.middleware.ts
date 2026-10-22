import { getConfig, type Config } from '../../config/config';
import type { Context, NextFunction } from 'grammy';

/**
 * Checks whether a user ID is in the admin allowlist.
 */
export function isAdmin(userId: number, customConfig?: Config): boolean {
  const config = customConfig ?? getConfig();
  return config.adminUserIds.includes(userId);
}

/**
 * Middleware that rejects non-admin users with a silent ignore.
 * Supports being used directly as `requireAdmin` or as a factory `requireAdmin(config)`.
 */
export function requireAdmin(
  ctxOrConfig?: Context | Config,
  next?: NextFunction
): any {
  if (ctxOrConfig && next && 'from' in ctxOrConfig) {
    const ctx = ctxOrConfig as Context;
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) {
      return;
    }
    return next();
  }

  const customConfig = ctxOrConfig as Config | undefined;
  return async (ctx: Context, nextFn: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId, customConfig)) {
      return;
    }
    await nextFn();
  };
}
