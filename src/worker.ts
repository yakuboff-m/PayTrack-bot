import { webhookCallback } from 'grammy';
import type { Env } from './database/d1.types';
import { parseConfigFromEnv } from './config/config';
import { D1DatabaseAdapter } from './database/adapter';
import { DatabaseConversationStore } from './distributors/conversation.store';
import { createBot } from './bot/bot';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'paytrack-bot',
          runtime: 'cloudflare-workers',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Telegram Webhook endpoint (/webhook or /)
    if (request.method === 'POST') {
      // Validate webhook secret token — mandatory in production
      if (!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.trim() === '') {
        console.error('Server configuration error: WEBHOOK_SECRET is missing or empty.');
        return new Response('Webhook secret is not configured on server.', { status: 500 });
      }

      const receivedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!receivedSecret || receivedSecret !== env.WEBHOOK_SECRET.trim()) {
        console.warn('Unauthorized webhook request: secret token mismatch or missing header.');
        return new Response('Unauthorized', { status: 403 });
      }

      try {
        const config = parseConfigFromEnv(env);
        const db = new D1DatabaseAdapter(env.paytrack_bot_db);
        const conversationStore = new DatabaseConversationStore(db);

        const { bot } = createBot({
          config,
          db,
          conversationStore,
          executionContext: ctx,
        });

        // Use grammY's cloudflare-mod adapter to process the webhook
        const handler = webhookCallback(bot, 'cloudflare-mod');
        return await handler(request);
      } catch (err: unknown) {
        console.error('Webhook processing error:', (err as Error).message);
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};
