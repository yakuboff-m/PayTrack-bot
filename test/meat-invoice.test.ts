import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SqliteDatabaseAdapter } from '../src/database/adapter';
import { DistributorRepository } from '../src/distributors/distributor.repository';
import { DistributorService } from '../src/distributors/distributor.service';
import { TransactionRepository } from '../src/transactions/transaction.repository';
import { TransactionService } from '../src/transactions/transaction.service';
import { createBot } from '../src/bot/bot';
import {
  parseMeatInvoice,
  parseMeatInvoiceLine,
  parseShorthandPrice,
  formatMeatInvoice,
} from '../src/transactions/meat-invoice';
import type { Config } from '../src/config/config';

function createInMemoryDb(): SqliteDatabaseAdapter {
  const sqlite = new Database(':memory:');
  const schemaPath = path.join(__dirname, '../src/database/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  sqlite.exec(schema);
  return new SqliteDatabaseAdapter(sqlite);
}

const testConfig: Config = {
  botToken: '123456789:ABCdefGHI',
  telegramGroupId: -100123456,
  pendingTopicId: 10,
  confirmedTopicId: 20,
  adminUserIds: [111, 222],
};

describe('Plain-Text Meat Invoice Calculator', () => {
  describe('Price Shorthand & Arithmetic', () => {
    it('interprets price shorthand in thousands of KRW', () => {
      assert.equal(parseShorthandPrice('12.7'), 12700);
      assert.equal(parseShorthandPrice('3.2'), 3200);
      assert.equal(parseShorthandPrice('14.6'), 14600);
      assert.equal(parseShorthandPrice('12.5'), 12500);
      assert.equal(parseShorthandPrice('5.1'), 5100);
      assert.equal(parseShorthandPrice('5'), 5000);
      assert.equal(parseShorthandPrice('12.75'), 12750);
      assert.equal(parseShorthandPrice('0.5'), 500);
      assert.equal(parseShorthandPrice('12,7'), 12700);
    });

    it('calculates line totals as quantity × price in integer KRW without scaling quantities', () => {
      // Qozon 62.68 x 12.7
      const l1 = parseMeatInvoiceLine('Qozon 62.68 x 12.7', 1);
      assert.ok(l1.item);
      assert.equal(l1.item.name, 'Qozon');
      assert.equal(l1.item.quantity, 62.68);
      assert.equal(l1.item.unit, 'kg');
      assert.equal(l1.item.unitPriceKrw, 12700);
      assert.equal(l1.item.lineTotal, 796036);

      // Akarachka 30kg x 3.2
      const l2 = parseMeatInvoiceLine('Akarachka 30kg x 3.2', 2);
      assert.ok(l2.item);
      assert.equal(l2.item.name, 'Akarachka');
      assert.equal(l2.item.quantity, 30);
      assert.equal(l2.item.unit, 'kg');
      assert.equal(l2.item.unitPriceKrw, 3200);
      assert.equal(l2.item.lineTotal, 96000);

      // Ichki son 28.3 x 14.6 =
      const l3 = parseMeatInvoiceLine('Ichki son 28.3 x 14.6 =', 3);
      assert.ok(l3.item);
      assert.equal(l3.item.name, 'Ichki son');
      assert.equal(l3.item.quantity, 28.3);
      assert.equal(l3.item.unit, 'kg');
      assert.equal(l3.item.unitPriceKrw, 14600);
      assert.equal(l3.item.lineTotal, 413180);

      // Grudinka 6ta x 12.5
      const l4 = parseMeatInvoiceLine('Grudinka 6ta x 12.5', 4);
      assert.ok(l4.item);
      assert.equal(l4.item.name, 'Grudinka');
      assert.equal(l4.item.quantity, 6);
      assert.equal(l4.item.unit, 'ta');
      assert.equal(l4.item.unitPriceKrw, 12500);
      assert.equal(l4.item.lineTotal, 75000);

      // Drumstick 10kg x 5.1
      const l5 = parseMeatInvoiceLine('Drumstick 10kg x 5.1', 5);
      assert.ok(l5.item);
      assert.equal(l5.item.name, 'Drumstick');
      assert.equal(l5.item.quantity, 10);
      assert.equal(l5.item.unit, 'kg');
      assert.equal(l5.item.unitPriceKrw, 5100);
      assert.equal(l5.item.lineTotal, 51000);
    });

    it('calculates exact grand total for all sample items', () => {
      const sampleText = [
        'Qozon 62.68 x 12.7',
        'Akarachka 30kg x 3.2',
        'Ichki son 28.3 x 14.6 =',
        'Grudinka 6ta x 12.5',
        'Drumstick 10kg x 5.1',
      ].join('\n');

      const result = parseMeatInvoice(sampleText);
      assert.equal(result.success, true);
      assert.ok(result.invoice);
      assert.equal(result.invoice.items.length, 5);
      // 796,036 + 96,000 + 413,180 + 75,000 + 51,000 = 1,431,216
      assert.equal(result.invoice.grandTotal, 1431216);
    });
  });

  describe('Invoice Line Syntax & Variations', () => {
    it('supports optional kg, optional ta, and optional trailing =', () => {
      const r1 = parseMeatInvoiceLine('Mol go\'shti 15kg x 14.0 =', 1);
      assert.ok(r1.item);
      assert.equal(r1.item.unit, 'kg');
      assert.equal(r1.item.unitPriceKrw, 14000);

      const r2 = parseMeatInvoiceLine('Mol go\'shti 15 ta x 14.0', 2);
      assert.ok(r2.item);
      assert.equal(r2.item.unit, 'ta');

      const r3 = parseMeatInvoiceLine('Mol go\'shti 15 x 14.0', 3);
      assert.ok(r3.item);
      assert.equal(r3.item.unit, 'kg'); // default
    });

    it('supports alternate multiplication symbols (X, ×, *) and spacing', () => {
      const r1 = parseMeatInvoiceLine('Qozon 10kg X 12.5', 1);
      assert.ok(r1.item);
      assert.equal(r1.item.unitPriceKrw, 12500);

      const r2 = parseMeatInvoiceLine('Qozon 10kg × 12.5', 2);
      assert.ok(r2.item);
      assert.equal(r2.item.unitPriceKrw, 12500);

      const r3 = parseMeatInvoiceLine('Qozon 10kg*12.5', 3);
      assert.ok(r3.item);
      assert.equal(r3.item.unitPriceKrw, 12500);
    });

    it('produces formatted invoice text with 3 lines per item and blank lines between items', () => {
      const sampleText = [
        'Qozon 62.68 x 12.7',
        'Akarachka 30kg x 3.2',
        'Ichki son 28.3 x 14.6 =',
      ].join('\n');

      const result = parseMeatInvoice(sampleText);
      assert.ok(result.invoice);
      const text = result.invoice.formattedDisplay;

      const expected = [
        '🧾 MEAT INVOICE',
        '━━━━━━━━━━━━━━━━',
        '1. Qozon — 62.68 kg',
        '　62.68 kg × ₩12,700',
        '　= ₩796,036',
        '',
        '2. Akarachka — 30 kg',
        '　30 kg × ₩3,200',
        '　= ₩96,000',
        '',
        '3. Ichki son — 28.3 kg',
        '　28.3 kg × ₩14,600',
        '　= ₩413,180',
        '',
        '💰 Total: ₩1,305,216',
      ].join('\n');

      assert.equal(text, expected);
    });

    it('formats each item into 3 lines: name/qty, multiplication/price, and subtotal', () => {
      const sampleText = [
        'Qozon 62.68 x 12.7',
        'Grudinka 6ta x 12.5',
      ].join('\n');

      const result = parseMeatInvoice(sampleText);
      assert.ok(result.invoice);
      const lines = result.invoice.formattedDisplay.split('\n');

      assert.equal(lines[0], '🧾 MEAT INVOICE');
      assert.equal(lines[1], '━━━━━━━━━━━━━━━━');

      // Item 1
      assert.equal(lines[2], '1. Qozon — 62.68 kg');
      assert.equal(lines[3], '　62.68 kg × ₩12,700');
      assert.equal(lines[4], '　= ₩796,036');
      assert.equal(lines[5], '');

      // Item 2
      assert.equal(lines[6], '2. Grudinka — 6 ta');
      assert.equal(lines[7], '　6 ta × ₩12,500');
      assert.equal(lines[8], '　= ₩75,000');
      assert.equal(lines[9], '');

      // Total
      assert.equal(lines[10], '💰 Total: ₩871,036');
    });
  });

  describe('Malformed & Ambiguous Input Rejection', () => {
    it('rejects line with missing item name', () => {
      const res = parseMeatInvoice('62.68 x 12.7');
      assert.equal(res.success, false);
      assert.match(res.error!, /invalid/i);
    });

    it('rejects line with missing quantity', () => {
      const res = parseMeatInvoice('Qozon x 12.7');
      assert.equal(res.success, false);
      assert.match(res.error!, /invalid/i);
    });

    it('rejects line with missing price', () => {
      const res = parseMeatInvoice('Qozon 10kg x');
      assert.equal(res.success, false);
      assert.match(res.error!, /invalid/i);
    });

    it('rejects line with non-positive quantity or price', () => {
      const res1 = parseMeatInvoice('Qozon 0 x 12.7');
      assert.equal(res1.success, false);
      assert.match(res1.error!, /greater than zero/i);

      const res2 = parseMeatInvoice('Qozon 10kg x 0');
      assert.equal(res2.success, false);
      assert.match(res2.error!, /greater than zero/i);
    });

    it('rejects ambiguous line with multiple multiplication symbols', () => {
      const res = parseMeatInvoice('Item 10 x 5 x 2');
      assert.equal(res.success, false);
      assert.match(res.error!, /ambiguous|multiple/i);
    });

    it('rejects empty input', () => {
      const res = parseMeatInvoice('   \n   ');
      assert.equal(res.success, false);
      assert.match(res.error!, /no invoice lines/i);
    });

    it('never silently omits invalid lines in multi-line input', () => {
      const input = [
        'Qozon 62.68 x 12.7',
        'Not a valid line here',
        'Grudinka 6ta x 12.5',
      ].join('\n');

      const res = parseMeatInvoice(input);
      assert.equal(res.success, false);
      assert.match(res.error!, /Line 2 is invalid/);
    });
  });

  describe('Command Routing & Bot Integration', () => {
    async function setupTestContext() {
      const db = createInMemoryDb();
      const distRepo = new DistributorRepository(db);
      const distService = new DistributorService(distRepo);
      const txRepo = new TransactionRepository(db);
      const txService = new TransactionService(txRepo, testConfig);

      // Seed distributor
      const distributor = await distService.create({
        name: 'Baraka Go\'sht',
        alias: 'baraka',
        bankName: 'Shinhan',
        accountNumber: '110-123-456789',
        accountHolder: 'Kim Min-woo',
      });

      const sentMessages: any[] = [];
      const deletedMessageIds: number[] = [];

      const { bot } = createBot({
        config: testConfig,
        db,
      });

      // Intercept Bot API calls
      bot.api.config.use(async (prev, method, payload: any) => {
        if (method === 'sendMessage') {
          const id = 5000 + sentMessages.length;
          sentMessages.push({ ...payload, message_id: id });
          return {
            ok: true,
            result: {
              message_id: id,
              chat: { id: payload.chat_id },
              date: Math.floor(Date.now() / 1000),
              ...payload,
            } as any,
          };
        }
        if (method === 'deleteMessage') {
          deletedMessageIds.push(payload.message_id);
          return { ok: true, result: true as any };
        }
        return { ok: true, result: {} as any };
      });

      return {
        db,
        distService,
        txRepo,
        txService,
        distributor,
        bot,
        sentMessages,
        deletedMessageIds,
      };
    }

    it('registers a new Pending transaction from a direct meat invoice command', async () => {
      const { bot, txRepo, distributor, sentMessages, deletedMessageIds } = await setupTestContext();

      const meatLines = [
        '/baraka',
        'Qozon 62.68 x 12.7',
        'Akarachka 30kg x 3.2',
        'Ichki son 28.3 x 14.6 =',
        'Grudinka 6ta x 12.5',
        'Drumstick 10kg x 5.1',
      ].join('\n');

      const update = {
        update_id: 1,
        message: {
          message_id: 101,
          from: { id: 111, is_bot: false, first_name: 'Admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: meatLines,
        },
      };

      await bot.handleUpdate(update as any);

      // Verify transaction was registered in database
      const tx = await txRepo.findByMessageId(String(testConfig.telegramGroupId), 101);
      assert.ok(tx);
      assert.equal(tx.status, 'PENDING');
      assert.equal(tx.distributor_id, distributor.id);
      assert.equal(tx.amount, 1431216);

      // Verify bot sent the formatted invoice display with copy button
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /MEAT INVOICE/);
      assert.match(sentMessages[0].text, /₩1,431,216/);
      assert.match(sentMessages[0].text, /Baraka Go'sht/);

      // Verify the command message was deleted
      assert.ok(deletedMessageIds.includes(101));
    });

    it('rejects malformed direct meat invoice with clear error and creates no transaction', async () => {
      const { bot, txRepo, sentMessages } = await setupTestContext();

      const malformedText = [
        '/baraka',
        'Qozon 62.68 x 12.7',
        'Invalid Line Here',
      ].join('\n');

      const update = {
        update_id: 2,
        message: {
          message_id: 102,
          from: { id: 111, is_bot: false, first_name: 'Admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: malformedText,
        },
      };

      await bot.handleUpdate(update as any);

      // Verify NO transaction was registered
      const tx = await txRepo.findByMessageId(String(testConfig.telegramGroupId), 102);
      assert.equal(tx, undefined);

      // Verify error reply was sent
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /❌ Line 2 is invalid/);
    });

    it('preserves existing simple amount command behavior on replies (/baraka 280700)', async () => {
      const { bot, txRepo, distributor, sentMessages } = await setupTestContext();

      // Original invoice message in pending topic
      const originalMessageId = 201;
      await txRepo.create(
        String(testConfig.telegramGroupId),
        testConfig.pendingTopicId,
        originalMessageId,
        new Date().toISOString()
      );

      // Admin replies with /baraka 280700
      const update = {
        update_id: 3,
        message: {
          message_id: 202,
          from: { id: 111, is_bot: false, first_name: 'Admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: '/baraka 280,700',
          reply_to_message: {
            message_id: originalMessageId,
            text: 'Original invoice note',
            chat: { id: testConfig.telegramGroupId },
          },
        },
      };

      await bot.handleUpdate(update as any);

      const tx = await txRepo.findByMessageId(String(testConfig.telegramGroupId), originalMessageId);
      assert.ok(tx);
      assert.equal(tx.distributor_id, distributor.id);
      assert.equal(tx.amount, 280700);
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /₩280,700/);
    });

    it('prevents accidental duplicate registration when Telegram retries the update', async () => {
      const { bot, txRepo, sentMessages } = await setupTestContext();

      const meatLines = [
        '/baraka',
        'Qozon 62.68 x 12.7',
      ].join('\n');

      const update = {
        update_id: 10,
        message: {
          message_id: 301,
          from: { id: 111, is_bot: false, first_name: 'Admin' },
          chat: { id: testConfig.telegramGroupId, type: 'supergroup' },
          message_thread_id: testConfig.pendingTopicId,
          date: Math.floor(Date.now() / 1000),
          text: meatLines,
        },
      };

      // First delivery
      await bot.handleUpdate(update as any);
      assert.equal(sentMessages.length, 1);

      // Telegram retry of the same update
      await bot.handleUpdate(update as any);
      // Ensure no second message was sent and no duplicate row was created
      assert.equal(sentMessages.length, 1);

      const rows = await txRepo.findByMessageId(String(testConfig.telegramGroupId), 301);
      assert.ok(rows);
    });
  });
});
