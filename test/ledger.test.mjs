import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { BudgetLedger } from '../src/ledger.mjs';

const policy = () => ({ totalAtomic: '10000000', perCallAtomic: '5000000', expiresAt: Date.now() + 60000, allowedOrigins: ['https://merchant.example'], allowedPaths: ['/pay'] });
const request = (id, amountAtomic = '5000000') => ({ id, url: 'https://merchant.example/pay', method: 'POST', body: { order: id }, amountAtomic });
function fixture(t, suppliedPolicy = policy()) {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-ledger-'));
  const stateDir = join(dir, 'state');
  const ledger = new BudgetLedger(stateDir, suppliedPolicy);
  t.after(() => { try { ledger.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { dir, stateDir, ledger, policy: suppliedPolicy };
}

test('reservations and unknown outcomes retain the aggregate budget', t => {
  const { ledger } = fixture(t);
  ledger.reserve(request('first'));
  ledger.markUnknown('first');
  ledger.reserve(request('second'));
  assert.throws(() => ledger.reserve(request('third', '1')), /Aggregate budget/);
  assert.equal(ledger.get('first').state, 'unknown');
  assert.deepEqual([ledger.summary().spentAtomic, ledger.summary().reservedAtomic, ledger.summary().remainingAtomic], ['0', '10000000', '0']);
});

test('confirmation accounts for actual spending and cannot be changed', t => {
  const { ledger } = fixture(t);
  ledger.reserve(request('first'));
  ledger.markUnknown('first');
  assert.throws(() => ledger.confirm('first', '5000001'), /exceeds/);
  ledger.confirm('first', '2000000');
  assert.equal(ledger.summary().remainingAtomic, '8000000');
  assert.equal(ledger.summary().reservedAtomic, '0');
  assert.throws(() => ledger.confirm('first', '0'), /already confirmed/);
  assert.throws(() => ledger.markUnknown('first'), /Confirmed/);
});

test('existing ids never replay and canonical JSON identifies changed payloads', t => {
  const { ledger } = fixture(t);
  const first = { ...request('first'), body: { z: 1, a: { y: 2, x: 3 } } };
  ledger.reserve(first);
  assert.throws(() => ledger.reserve({ ...first, body: { a: { x: 3, y: 2 }, z: 1 } }), /already exists/);
  assert.throws(() => ledger.reserve({ ...first, body: { z: 2 } }), /changed request/);
  assert.throws(() => ledger.reserve({ ...first, amountAtomic: '1' }), /changed request/);
  assert.equal(ledger.summary().payments, 1);
});

test('a new id or changed amount cannot repay the same canonical request', t => {
  const { ledger } = fixture(t);
  const first = { ...request('first'), body: { z: 1, a: 2 } };
  ledger.reserve(first);
  ledger.markUnknown('first');
  assert.throws(() => ledger.reserve({ ...first, id: 'second', body: { a: 2, z: 1 }, amountAtomic: '1' }), /request already exists/);
  ledger.confirm('first', '5000000');
  assert.throws(() => ledger.reserve({ ...first, id: 'third' }), /request already exists/);
  assert.equal(ledger.summary().payments, 1);
});

test('ledger persists across reopen and policy changes never reset spending', t => {
  const f = fixture(t);
  f.ledger.reserve(request('first'));
  f.ledger.markUnknown('first');
  f.ledger.close();
  const reopened = new BudgetLedger(f.stateDir, f.policy);
  t.after(() => reopened.close());
  assert.equal(reopened.get('first').state, 'unknown');
  assert.equal(reopened.summary().reservedAtomic, '5000000');
  assert.throws(() => new BudgetLedger(f.stateDir, { ...f.policy, totalAtomic: '9000000' }), /durable ledger policy/);
});

test('expired policies allow inspection but block new reservations', t => {
  const { ledger } = fixture(t, { ...policy(), expiresAt: Date.now() - 1 });
  assert.throws(() => ledger.reserve(request('first')), /expired/);
  assert.equal(ledger.summary().payments, 0);
  assert.equal(ledger.get('missing'), null);
});

test('integer strings, per-call caps, methods and JSON are strictly checked', t => {
  const { ledger } = fixture(t);
  for (const value of [5000000, '01', '-1', '1.0', '1e6', ' 1', '0', '10000000000000000000000']) assert.throws(() => ledger.reserve(request('bad', value)), /integer|range/);
  assert.throws(() => ledger.reserve(request('bad', '5000001')), /Per-call/);
  assert.throws(() => ledger.reserve({ ...request('bad'), method: 'post' }), /HTTP method/);
  assert.throws(() => ledger.reserve({ ...request('bad'), body: { x: undefined } }), /plain JSON/);
  assert.throws(() => ledger.reserve({ ...request('bad'), body: { x: 1.1 } }), /safe integers/);
  assert.equal(ledger.summary().payments, 0);
});

test('only exact HTTPS origin and path are admitted', t => {
  const { ledger } = fixture(t);
  for (const url of ['http://merchant.example/pay', 'https://merchant.example.evil/pay', 'https://merchant.example/pay/extra', 'https://merchant.example:444/pay', 'https://user@merchant.example/pay', 'https://merchant.example/pay#fragment', 'https://merchant.example/%70ay']) {
    assert.throws(() => ledger.reserve({ ...request('bad'), url }), /allowlist/);
  }
  ledger.reserve({ ...request('good'), url: 'https://merchant.example/pay?order=1' });
  assert.throws(() => ledger.reserve({ ...request('good'), url: 'https://merchant.example/pay?order=2' }), /changed request/);
});

test('policy validation rejects invalid limits, origins, paths and expiry', t => {
  const { dir } = fixture(t);
  const invalid = [{ totalAtomic: '10000001' }, { perCallAtomic: '5000001' }, { totalAtomic: 10000000 }, { expiresAt: '123' }, { expiresAt: 1.2 }, { allowedOrigins: ['https://merchant.example/'] }, { allowedOrigins: ['http://merchant.example'] }, { allowedPaths: ['/pay?x=1'] }, { allowedPaths: ['/foo/../pay'] }, { allowedPaths: ['/pay', '/pay'] }, { extra: true }];
  for (const patch of invalid) assert.throws(() => new BudgetLedger(join(dir, 'invalid'), { ...policy(), ...patch }));
});

test('inspection does not alter reservations, and exposed policy is immutable', t => {
  const { ledger } = fixture(t);
  ledger.reserve(request('first'));
  const before = ledger.summary();
  assert.throws(() => { ledger.policy.totalAtomic = '10000000'; }, TypeError);
  assert.throws(() => ledger.policy.allowedOrigins.push('https://evil.example'), TypeError);
  for (let n = 0; n < 10; n++) { ledger.get('first'); ledger.get('missing'); ledger.summary(); }
  assert.deepEqual(ledger.summary(), before);
});

test('state directory, database and sidecars reject unsafe permissions and symlinks', t => {
  const { dir } = fixture(t);
  const unsafeDir = join(dir, 'unsafe');
  mkdirSync(unsafeDir, { mode: 0o755 });
  assert.throws(() => new BudgetLedger(unsafeDir, policy()), /Unsafe state directory/);
  const alias = join(dir, 'alias');
  symlinkSync(unsafeDir, alias);
  assert.throws(() => new BudgetLedger(alias, policy()), /Unsafe state directory/);
  const state = join(dir, 'unsafe-file');
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, 'ledger.sqlite'), '', { mode: 0o644 });
  assert.throws(() => new BudgetLedger(state, policy()), /Unsafe state file/);
  chmodSync(join(state, 'ledger.sqlite'), 0o600);
  symlinkSync(join(dir, 'nonexistent-target'), join(state, 'ledger.sqlite-wal'));
  assert.throws(() => new BudgetLedger(state, policy()), /Unsafe state file/);
});

test('created state is owner-only', t => {
  const { stateDir } = fixture(t);
  assert.equal(lstatSync(stateDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(stateDir, 'ledger.sqlite')).mode & 0o777, 0o600);
});

test('independent concurrent processes cannot exceed the shared budget', async t => {
  const f = fixture(t);
  const sharedStateDir = join(f.dir, 'cold-start-state');
  const moduleUrl = new URL('../src/ledger.mjs', import.meta.url).href;
  const worker = `import { BudgetLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = new BudgetLedger(process.argv[1], JSON.parse(process.argv[2]));
    try { ledger.reserve({ id: process.argv[3], url: 'https://merchant.example/pay', method: 'POST', body: { order: process.argv[3] }, amountAtomic: '3000000' }); process.stdout.write('reserved'); }
    catch(error) { if (!error.message.includes('Aggregate budget')) throw error; process.stdout.write('denied'); }
    finally { ledger.close(); }`;
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, sharedStateDir, JSON.stringify(f.policy), `worker-${index}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(errors)));
  })));
  assert.equal(outcomes.filter(value => value === 'reserved').length, 3);
  assert.equal(outcomes.filter(value => value === 'denied').length, 5);
  const reopened = new BudgetLedger(sharedStateDir, f.policy);
  try {
    assert.equal(reopened.summary().reservedAtomic, '9000000');
    assert.equal(reopened.summary().remainingAtomic, '1000000');
  } finally { reopened.close(); }
});
