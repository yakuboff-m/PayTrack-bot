import type { Composer } from 'grammy';
import type { Context } from 'grammy';

export function registerHelpHandler(bot: Composer<Context>): void {
  bot.command('help', async (ctx) => {
    const helpText = `📦 *Transaction Workflow*

1\\. Send the invoice/transaction to Pending\\.
2\\. Reply to it with the distributor command\\.
   Example: \`/abc\`
3\\. Reply to it with the amount\\.
   Example: \`/amount 280,700\`
4\\. When payment is made, reply to the transaction with the payment message\\.
5\\. Add \`/paid\` to the payment message\\.
6\\. The bot copies the transaction \\+ payment evidence to Confirmed\\.
7\\. Pending keeps a small history record with a link to the confirmation\\.

*Payment can be:*
• Bank transfer receipt \\(screenshot\\)
• PDF
• Text message
• Cash note

*Distributor Management:*
\`/distributors\` — List all distributors
\`/add\\_distributor\` — Add a new distributor

*Notes:*
\`/note <text>\` — Attach a note to an invoice \\(reply to the invoice\\)`;

    await ctx.reply(helpText, { parse_mode: 'MarkdownV2' });
  });
}
