import { getConfig, type Config } from '../../config/config';
import type { Context, NextFunction } from 'grammy';

/**
 * Checks whether a user ID is in the admin allowlist.
 * Accepts numeric or string user IDs and normalizes them safely.
 */
export function isAdmin(
  userId: number | string | undefined | null,
  customConfig?: Config
): boolean {
  if (userId === undefined || userId === null) {
    return false;
  }
  const numId = typeof userId === 'number' ? userId : parseInt(String(userId).trim(), 10);
  if (isNaN(numId) || numId <= 0) {
    return false;
  }

  let config: Config | null = null;
  try {
    config = customConfig ?? getConfig();
  } catch {
    return false;
  }

  if (!config || !Array.isArray(config.adminUserIds) || config.adminUserIds.length === 0) {
    return false;
  }

  return config.adminUserIds.includes(numId);
}

/**
 * Middleware that rejects non-admin users with a silent ignore or callback alert.
 * Supports being used directly as `requireAdmin` or as a factory `requireAdmin(config)`.
 */
export function requireAdmin(
  ctxOrConfig?: Context | Config,
  next?: NextFunction
): any {
  if (ctxOrConfig && next && 'from' in ctxOrConfig) {
    const ctx = ctxOrConfig as Context;
    const userId = ctx.from?.id;
    if (!isAdmin(userId)) {
      if (ctx.callbackQuery) {
        ctx.answerCallbackQuery({ text: '⛔ Unauthorized: Admin access required.', show_alert: true }).catch(() => {});
      }
      return;
    }
    return next();
  }

  const customConfig = ctxOrConfig as Config | undefined;
  return async (ctx: Context, nextFn: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;
    if (!isAdmin(userId, customConfig)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: '⛔ Unauthorized: Admin access required.', show_alert: true }).catch(() => {});
      }
      return;
    }
    await nextFn();
  };
}
