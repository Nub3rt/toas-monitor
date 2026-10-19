import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isApartmentTable, parseMonitoredTables } from '../src/parser.ts';

// Minimal event-driven HTMLRewriter stand-in to test selector registration,
// scoped text callbacks, streaming chunks, and end-tag state transitions.
// The actual Workers native parser is used in deployment.
class MockHTMLRewriter {
  handlers = [];

  on(selector, handler) {
    if (selector.includes(',')) throw new Error(`unsupported selector: ${selector}`);
    this.handlers.push({ selector, handler });
    return this;
  }

  transform(response) {
    return {
      text: async () => {
        const html = await response.text();
        const stack = [];
        const tokens = /<\/?[A-Za-z][^>]*>|[^<]+/g;
        for (const match of html.matchAll(tokens)) {
          const token = match[0];
          if (token.startsWith('</')) {
            const tag = token.match(/^<\/([A-Za-z][\w-]*)/)[1].toLowerCase();
            let node;
            do {
              node = stack.pop();
              if (!node) throw new Error(`unbalanced HTML: ${tag}`);
              for (const onEndTag of node.endCallbacks) onEndTag();
            } while (node.tag !== tag);
          } else if (token.startsWith('<')) {
            const tag = token.match(/^<([A-Za-z][\w-]*)/)[1].toLowerCase();
            const node = { tag, endCallbacks: [], handlers: this.handlers.filter((h) => h.selector === tag) };
            stack.push(node);
            for (const { handler } of node.handlers) {
              handler.element?.({ onEndTag: (callback) => node.endCallbacks.push(callback) });
            }
          } else {
            const decoded = token.replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
            // Split one text node to simulate streaming by HTMLRewriter.
            const middle = Math.max(1, Math.floor(decoded.length / 2));
            const chunks = [decoded.slice(0, middle), decoded.slice(middle)];
            for (const node of stack) {
              for (const { handler } of node.handlers) {
                chunks.forEach((chunk, i) => handler.text?.({ text: chunk, lastInTextNode: i === 1 }));
              }
            }
          }
        }
        if (stack.length) throw new Error('unbalanced mock HTML');
        return html;
      },
    };
  }
}

globalThis.HTMLRewriter = MockHTMLRewriter;

const fixture = readFileSync(new URL('./fixture-toas-2026-10-19.html', import.meta.url), 'utf8');

const wrap = (content) => `<html><head><title>Quickly Available - TOAS</title></head><body>${content}</body></html>`;

test('actual 19 Oct 2026 TOAS table is parsed: all five listings', async () => {
  const tables = await parseMonitoredTables(fixture);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['Location', 'Apartment type', 'Square meters', 'Floor', 'Rent €/month']);
  assert.equal(tables[0].rows.length, 5);
  assert.deepEqual(tables[0].rows.map(row => row[0]), [
    'Velinterassit', 'Lukonkruuti', 'Rantalinna', 'Erkkila', 'Trikootalo',
  ]);
  assert.deepEqual(tables[0].rows[0], [
    'Velinterassit', '1 room, kitchen/living room, balcony , family apartment',
    '48,5', '4.', '782,45 + 35',
  ]);
});

test('dated headings change without disabling apartment detection', async () => {
  const immediate = fixture.replace('Tenancy agreement beginning 1st of November 2026', 'Tenancy agreement beginning immediately');
  const december = fixture.replace('Tenancy agreement beginning 1st of November 2026', 'Tenancy agreement beginning 1st of December 2026');
  assert.deepEqual(await parseMonitoredTables(immediate), await parseMonitoredTables(december));
});

test('all apartment tables are collected, other HTML tables are ignored', async () => {
  const extra = `<table><tr><td>Location</td><td>Apartment type</td><td>Rent €/month</td></tr><tr><td>Mikontalo</td><td>Room</td><td>350</td></tr></table>`;
  const html = fixture.replace('</body>', `${extra}<table><tr><td>Blog post</td></tr></table></body>`);
  const tables = await parseMonitoredTables(html);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].rows.length, 5);
  assert.equal(tables[1].rows[0][0], 'Mikontalo');
});

test('recognizes rental listing columns only', () => {
  assert.equal(isApartmentTable({ headers: ['Location', 'Apartment type', 'Rent €/month'], rows: [] }), true);
  assert.equal(isApartmentTable({ headers: ['Name', 'Country', 'Population'], rows: [] }), false);
});

test('legitimate TOAS page without any tables means no apartments', async () => {
  assert.deepEqual(await parseMonitoredTables(wrap('<h2>No apartments currently available</h2>')), []);
});

test('bot-block / unexpected page does not get saved as an empty state', async () => {
  await assert.rejects(parseMonitoredTables('<html><title>Access denied</title><body>Cloudflare check</body></html>'), /Unexpected TOAS page title/);
});

test('table layout changes cause an error rather than silently saving []', async () => {
  await assert.rejects(parseMonitoredTables(wrap('<table><tr><td>Property</td><td>Size</td></tr></table>')), /none matched/);
});

test('end-to-end: actual TOAS HTML saves five listings and alerts on a changed row', async () => {
  const { checkToas } = await import('../src/monitor.ts');
  const store = new Map();
  const messages = [];
  const env = {
    TELEGRAM_BOT_TOKEN: 'mock', TELEGRAM_CHAT_ID: 'mock',
    TOAS_STATE: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => { store.set(key, value); },
    },
  };
  let page = fixture;
  const deps = {
    fetchPage: async () => page,
    parseMonitoredTables,
    sendTelegram: async (_env, message) => { messages.push(message); },
  };
  await checkToas(env, deps);
  assert.equal(messages.length, 0); // First run: baseline, no alert
  assert.equal(JSON.parse(store.get('state')).listings, 5);
  assert.equal(JSON.parse(store.get('state')).apartment_tables, 1);

  page = page.replace('Velinterassit', 'Mikontalo');
  await checkToas(env, deps);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Mikontalo is present/);
  assert.match(messages[0], /5 listings/);

  const saved = store.get('state');
  page = '<html><title>Access denied</title></html>';
  await assert.rejects(checkToas(env, deps), /Unexpected TOAS page title/);
  assert.equal(store.get('state'), saved); // A challenge page must not reset the baseline.
});
