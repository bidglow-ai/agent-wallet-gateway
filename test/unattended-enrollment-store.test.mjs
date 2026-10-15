import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { EnrollmentStore } from '../src/unattended/enrollment-store.mjs';
import { PaymentStore } from '../src/unattended/store.mjs';
import { NETWORK, TOKEN } from '../src/unattended/intent.mjs';

const code = expected => error => error.code === expected && error.message === expected;
function data() {
  const now = Date.now(), wallet = '0x2222222222222222222222222222222222222222';
  const config = { projectId: randomUUID(), expectedWallet: wallet };
  const identity = { userId: randomUUID(), wallet, delegationExpiresAt: now + 3600000 };
  const grant = { grantId: randomUUID(), userId: identity.userId, wallet, network: NETWORK, asset: TOKEN, payTo: '0x1111111111111111111111111111111111111111', merchantOrigin: 'https://merchant.example', perCallAtomic: '5000000', totalAtomic: '10000000', expiresAt: now + 600000 };
  return { config, identity, grant };
}
function order(grant) {
  const id = randomUUID(), now = Date.now();
  return { version: 1, id, grantId: grant.grantId, salt: '0x' + randomBytes(32).toString('hex'), merchantOrigin: grant.merchantOrigin, merchantAccount: 'acct_syntheticmerchant', resourceURL: grant.merchantOrigin + '/orders/' + id, listingId: 'synthetic_listing', board: 'all', quoteId: randomUUID(), wallet: grant.wallet, payTo: grant.payTo, network: grant.network, asset: grant.asset, amountAtomic: '5000000', createdAt: now, expiresAt: now + 240000 };
}
function fixture(t) {
  const input = data(), dir = mkdtempSync(join(tmpdir(), 'enrollment-store-')), root = join(dir, 'operator');
  const store = new EnrollmentStore(root, input.config), opened = [store];
  t.after(() => { for (const entry of opened) try { entry.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { ...input, dir, root, store, reopen() { const entry = new EnrollmentStore(root, input.config); opened.push(entry); return entry; } };
}
function childRun(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('close', status => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

test('enrollment creates one immutable grant and one fixed budget path', t => {
  const f = fixture(t);
  assert.equal(f.store.get(), null);
  assert.equal(existsSync(f.store.budgetStateDir), false);
  const result = f.store.enroll(f.identity, f.grant);
  assert.equal(result.created, true);
  assert.equal(result.budgetStateDir, join(f.root, 'payer'));
  assert.deepEqual(result.grant, f.grant);
  assert.ok(Object.isFrozen(result.grant));
  assert.deepEqual(f.store.get(), f.grant);
  assert.equal(f.reopen().enroll(f.identity, f.grant).created, false);
});

test('relogin and restart preserve unknown reservations, ids, expiry and the total budget', t => {
  const f = fixture(t), enrolled = f.store.enroll(f.identity, f.grant), payer = new PaymentStore(enrolled.budgetStateDir, f.grant);
  const first = order(f.grant);
  payer.reserve(first); payer.transition(first.id, 'reserved', 'unknown'); payer.close();
  const again = f.reopen().enroll({ ...f.identity, delegationExpiresAt: f.identity.delegationExpiresAt + 1000 }, { ...f.grant });
  assert.equal(again.created, false);
  const reopened = new PaymentStore(again.budgetStateDir, again.grant);
  try {
    assert.equal(reopened.get(first.id).state, 'unknown');
    assert.equal(reopened.summary().remainingAtomic, '5000000');
    reopened.reserve(order(f.grant));
    assert.equal(reopened.summary().remainingAtomic, '0');
  } finally { reopened.close(); }
});

test('changed UUID, subject, expiry, limits or merchant cannot replace an existing mandate', t => {
  const f = fixture(t); f.store.enroll(f.identity, f.grant);
  const changes = [{ grantId: randomUUID() }, { expiresAt: f.grant.expiresAt + 1 }, { expiresAt: f.grant.expiresAt - 1 }, { totalAtomic: '9000000' }, { perCallAtomic: '10000' }, { merchantOrigin: 'https://other.example' }, { payTo: f.grant.wallet }];
  for (const change of changes) assert.throws(() => f.store.enroll(f.identity, { ...f.grant, ...change }), code('ENROLLMENT_GRANT_MISMATCH'));
  const subject = randomUUID();
  assert.throws(() => f.store.enroll({ ...f.identity, userId: subject }, { ...f.grant, userId: subject }), code('ENROLLMENT_GRANT_MISMATCH'));
  assert.deepEqual(f.store.get(), f.grant);
});

test('invalid trusted configuration and changed project or fixed wallet are rejected', t => {
  const f = fixture(t);
  for (const changed of [{ projectId: randomUUID() }, { expectedWallet: f.grant.payTo }]) assert.throws(() => new EnrollmentStore(f.root, { ...f.config, ...changed }), code('ENROLLMENT_CONFIGURATION_MISMATCH'));
  for (const changed of [{ projectId: 'not-uuid' }, { expectedWallet: '0x' + '0'.repeat(40) }, { clientStateDir: '/synthetic' }]) assert.throws(() => new EnrollmentStore(join(f.dir, randomUUID()), { ...f.config, ...changed }), code('ENROLLMENT_CONFIGURATION_REQUIRED'));
});

test('identity and mandate validation happen before writing pending enrollment or creating a payer ledger', t => {
  const f = fixture(t);
  for (const identity of [{ ...f.identity, email: 'synthetic@example.invalid' }, { ...f.identity, wallet: f.grant.payTo }, { ...f.identity, userId: randomUUID() }, { ...f.identity, delegationExpiresAt: Date.now() - 1 }, { ...f.identity, delegationExpiresAt: Date.now() + 86401000 }, { ...f.identity, delegationExpiresAt: f.grant.expiresAt - 1 }]) assert.throws(() => f.store.enroll(identity, f.grant));
  assert.throws(() => f.store.enroll({ ...f.identity, get wallet() { throw new Error('getter must not run'); } }, f.grant), code('AUTHENTICATED_ENROLLMENT_REQUIRED'));
  assert.throws(() => f.store.enroll(f.identity, { ...f.grant, network: 'eip155:8453' }), code('ENROLLMENT_GRANT_MISMATCH'));
  assert.throws(() => f.store.enroll(f.identity, { ...f.grant, totalAtomic: '10000001' }), code('ENROLLMENT_GRANT_MISMATCH'));
  assert.equal(f.store.get(), null);
  assert.equal(existsSync(f.store.budgetStateDir), false);
  const db = new DatabaseSync(join(f.root, 'enrollment.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enrollment').get().count, 0); } finally { db.close(); }
});

test('expired and revoked mandates can be inspected but never reenrolled or renewed', t => {
  const f = fixture(t); f.store.enroll(f.identity, f.grant);
  const payer = new PaymentStore(f.store.budgetStateDir, f.grant); payer.revoke(); payer.close();
  assert.deepEqual(f.reopen().get(), f.grant);
  assert.throws(() => f.store.enroll(f.identity, f.grant), code('ENROLLMENT_REVOKED'));
  t.mock.method(Date, 'now', () => f.grant.expiresAt + 1);
  assert.deepEqual(f.store.get(), f.grant);
  assert.throws(() => f.store.enroll(f.identity, f.grant), code('ENROLLMENT_GRANT_MISMATCH'));
});

test('a missing active payer database fails closed without rebuilding it', t => {
  const f = fixture(t); f.store.enroll(f.identity, f.grant);
  const path = join(f.store.budgetStateDir, 'unattended.sqlite');
  renameSync(path, path + '.retained');
  assert.throws(() => f.store.get(), code('ENROLLMENT_LEDGER_MISSING'));
  assert.throws(() => f.reopen(), code('ENROLLMENT_LEDGER_MISSING'));
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(path + '.retained'), true);
});

test('a missing registry with an existing budget fails closed without recreating a registry', t => {
  const f = fixture(t); f.store.enroll(f.identity, f.grant); f.store.close();
  const path = join(f.root, 'enrollment.sqlite'); renameSync(path, path + '.retained');
  assert.throws(() => f.reopen(), code('ENROLLMENT_REGISTRY_MISSING'));
  assert.equal(existsSync(path), false);
});

test('mismatched payer metadata does not authorize a replacement grant or reset reservations', t => {
  const f = fixture(t); f.store.enroll(f.identity, f.grant);
  const payer = new PaymentStore(f.store.budgetStateDir, f.grant); payer.reserve(order(f.grant)); payer.close();
  const path = join(f.store.budgetStateDir, 'unattended.sqlite'), db = new DatabaseSync(path);
  db.prepare('UPDATE grant_state SET grant_json=? WHERE singleton=1').run(JSON.stringify({ ...f.grant, grantId: randomUUID() })); db.close();
  assert.throws(() => f.store.get(), code('ENROLLMENT_GRANT_MISMATCH'));
  const inspected = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(inspected.prepare('SELECT SUM(amount) AS amount FROM orders').get().amount, 5000000); } finally { inspected.close(); }
});

test('unexpected symlinks, hardlinks and unsafe root directories fail closed', t => {
  const f = fixture(t), unsafe = join(f.dir, 'unsafe'); mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => new EnrollmentStore(unsafe, f.config), code('UNSAFE_ENROLLMENT_STORAGE'));
  const alias = join(f.dir, 'alias'); symlinkSync(f.root, alias);
  assert.throws(() => new EnrollmentStore(alias, f.config), code('UNSAFE_ENROLLMENT_STORAGE'));
  const target = join(f.root, 'synthetic-file'); writeFileSync(target, '', { mode: 0o600 });
  symlinkSync(target, join(f.root, 'unexpected-link'));
  assert.throws(() => f.reopen(), code('UNSAFE_ENROLLMENT_STORAGE'));
  const other = join(f.dir, 'hardlinked'); mkdirSync(other, { mode: 0o700 });
  const source = join(other, 'source'); writeFileSync(source, '', { mode: 0o600 }); linkSync(source, join(other, 'alias'));
  assert.throws(() => new EnrollmentStore(other, f.config), code('UNSAFE_ENROLLMENT_STORAGE'));
});

test('a crash after durable pending state never automatically recreates or resumes the budget', async t => {
  const f = fixture(t), root = join(f.dir, 'interrupted'), moduleUrl = new URL('../src/unattended/enrollment-store.mjs', import.meta.url).href;
  const program = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.mkdirSync;fs.mkdirSync=(path,...options)=>{if(path.endsWith('/payer'))throw new Error('synthetic interruption');return original(path,...options);};syncBuiltinESMExports();
    const {EnrollmentStore}=await import(${JSON.stringify(moduleUrl)});const store=new EnrollmentStore(process.argv[1],JSON.parse(process.argv[2]));
    try{store.enroll(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));throw new Error('unexpected success');}
    catch(error){process.stdout.write(JSON.stringify({code:error.code}));}finally{store.close();}`;
  const result = await childRun(program, [root, JSON.stringify(f.config), JSON.stringify(f.identity), JSON.stringify(f.grant)]);
  assert.equal(result.code, 'ENROLLMENT_INITIALIZATION_UNCONFIRMED');
  assert.throws(() => new EnrollmentStore(root, f.config), code('ENROLLMENT_INCOMPLETE'));
  assert.equal(existsSync(join(root, 'payer')), false);
  const db = new DatabaseSync(join(root, 'enrollment.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT state FROM enrollment WHERE singleton=1').get().state, 'pending'); } finally { db.close(); }
});

test('eight concurrent enrollments produce at most one initial mandate and one budget directory', async t => {
  const f = fixture(t), root = join(f.dir, 'parallel'), moduleUrl = new URL('../src/unattended/enrollment-store.mjs', import.meta.url).href;
  const program = `import {EnrollmentStore} from ${JSON.stringify(moduleUrl)};let store;
    try{store=new EnrollmentStore(process.argv[1],JSON.parse(process.argv[2]));const result=store.enroll(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));process.stdout.write(JSON.stringify({created:result.created,grantId:result.grant.grantId}));}
    catch(error){if(error.code!=='ENROLLMENT_INCOMPLETE')throw error;process.stdout.write(JSON.stringify({code:error.code}));}finally{store?.close();}`;
  const results = await Promise.all(Array.from({ length: 8 }, () => childRun(program, [root, JSON.stringify(f.config), JSON.stringify(f.identity), JSON.stringify(f.grant)])));
  assert.equal(results.filter(result => result.created === true).length, 1);
  for (const result of results.filter(value => value.created !== undefined)) assert.equal(result.grantId, f.grant.grantId);
  const store = new EnrollmentStore(root, f.config);
  try {
    assert.deepEqual(store.get(), f.grant);
    const payer = new PaymentStore(store.budgetStateDir, f.grant);
    try { assert.equal(payer.summary().totalAtomic, '10000000'); assert.equal(payer.summary().orders, 0); } finally { payer.close(); }
  } finally { store.close(); }
});
