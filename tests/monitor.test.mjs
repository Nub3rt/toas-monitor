import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MONITORED_HEADING, STATE_KEY } from '../src/constants.ts';
import { normalizeText, parseTableRows } from '../src/parser.ts';
import { buildState, containsMikontalo, stateHash, getPreviousStateHash } from '../src/state.ts';
import { formatState, formatTable } from '../src/format.ts';
import { checkToas } from '../src/monitor.ts';

const sampleTables = [
  { headers: ['Address', 'Area'], rows: [['Mikontalo', '12 m²']] },
  { headers: ['Address', 'Area'], rows: [['Other', '20 m²']] },
];

function makeEnv(initialHash = null) {
  const saved = new Map(initialHash === null ? [] : [[STATE_KEY, JSON.stringify({ value: initialHash })]]);
  let puts = 0;
  return {
    TELEGRAM_BOT_TOKEN: 'fake-token',
    TELEGRAM_CHAT_ID: '123',
    TOAS_STATE: {
      get: async (key) => saved.get(key) ?? null,
      put: async (key, value) => { saved.set(key, value); puts += 1; },
    },
    saved,
    get puts() { return puts; },
  };
}

function makeDependencies(tables, messages) {
  return {
    fetchPage: async () => '<html>test</html>',
    parseMonitoredTables: async () => tables,
    sendTelegram: async (_env, message) => { messages.push(message); },
  };
}

test('normalizes whitespace and pads/truncates table rows just like Python', () => {
  assert.equal(normalizeText('  Mikontalo\u00a0  17\n m²  '), 'Mikontalo 17 m²');
  assert.deepEqual(parseTableRows([
    ['', ''], ['Street', 'Size', 'Rent'], ['A', '32'], ['B', '25', '650', 'extra'], ['', '', ''],
  ]), {
    headers: ['Street', 'Size', 'Rent'],
    rows: [['A', '32', ''], ['B', '25', '650']],
  });
  assert.deepEqual(parseTableRows([]), { headers: [], rows: [] });
});

test('state hash matches existing Python canonical SHA-256 (migration)', async () => {
  const state = buildState([sampleTables[0]]);
  assert.equal(state.heading, MONITORED_HEADING);
  assert.equal(await stateHash(state), 'f5c3f2b474d808fcbe1ca68e1370df69b9315007e63a6ddd854f336db1be8b8d');
});

test('Mikontalo detection searches rows, not headers', () => {
  assert.equal(containsMikontalo(buildState(sampleTables)), true);
  assert.equal(containsMikontalo(buildState([{ headers: ['Mikontalo'], rows: [['Other']] }])), false);
});

test('formatting follows original Telegram output', () => {
  assert.equal(formatTable({ headers: ['Address'], rows: [] }, 2), '\nTable 2 (0 listings):\nAddress | [no apartments]');
  assert.match(formatState(buildState([])), /No flats available\.$/);
  assert.match(formatState(buildState(sampleTables)), /Table 2 \(1 listings\):/);
});

test('first successful run initializes KV silently', async () => {
  const env = makeEnv();
  const messages = [];
  await checkToas(env, makeDependencies(sampleTables, messages));
  assert.equal(messages.length, 0);
  assert.equal(env.puts, 1);
  assert.equal(JSON.parse(env.saved.get(STATE_KEY)).value, await stateHash(buildState(sampleTables)));
  assert.equal(JSON.parse(env.saved.get(STATE_KEY)).apartment_tables, 2);
  assert.equal(JSON.parse(env.saved.get(STATE_KEY)).listings, 2);
  assert.match(JSON.parse(env.saved.get(STATE_KEY)).last_checked_at, /^20\d\d-/);
});

test('unchanged state produces no alert even when Mikontalo is present', async () => {
  const env = makeEnv(await stateHash(buildState(sampleTables)));
  const messages = [];
  await checkToas(env, makeDependencies(sampleTables, messages));
  assert.equal(messages.length, 0);
  assert.equal(env.puts, 1);
});

test('changed tables send one message and save the new state', async () => {
  const env = makeEnv('previous-hash');
  const messages = [];
  await checkToas(env, makeDependencies(sampleTables, messages));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /TOAS ALERT — monitored content changed; Mikontalo is present/);
  assert.match(messages[0], /Mikontalo \| 12 m²/);
  assert.equal(env.puts, 1);
});

test('Telegram failure never overwrites the saved hash', async () => {
  const env = makeEnv('previous-hash');
  const deps = makeDependencies(sampleTables, []);
  deps.sendTelegram = async () => { throw new Error('Telegram unavailable'); };
  await assert.rejects(checkToas(env, deps), /Telegram unavailable/);
  assert.equal(env.puts, 0);
  assert.equal(JSON.parse(env.saved.get(STATE_KEY)).value, 'previous-hash');
});

test('fetch/parse failure never overwrites the saved hash', async () => {
  const env = makeEnv('previous-hash');
  const deps = makeDependencies([], []);
  deps.parseMonitoredTables = async () => { throw new Error('Invalid document'); };
  await assert.rejects(checkToas(env, deps), /Invalid document/);
  assert.equal(env.puts, 0);
});

test('invalid persisted JSON fails rather than silently overwriting KV', async () => {
  const env = makeEnv();
  env.saved.set(STATE_KEY, 'not-json');
  await assert.rejects(getPreviousStateHash(env), /invalid state JSON/);
});
