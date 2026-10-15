import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { NETWORK, TOKEN, orderNonce } from '../src/unattended/intent.mjs';
import { PaymentStore } from '../src/unattended/store.mjs';

function grant() {
  return { grantId: randomUUID(), userId: randomUUID(), wallet: '0x2222222222222222222222222222222222222222', network: NETWORK, asset: TOKEN,
    payTo: '0x1111111111111111111111111111111111111111', merchantOrigin: 'https://merchant.example', perCallAtomic: '5000000', totalAtomic: '10000000', expiresAt: Date.now() + 600000 };
}
function order(g, amountAtomic = '5000000') {
  const id = randomUUID(), now = Date.now();
  return { version: 1, id, grantId: g.grantId, salt: '0x' + randomBytes(32).toString('hex'), merchantOrigin: g.merchantOrigin,
    merchantAccount: 'acct_syntheticstore', resourceURL: `${g.merchantOrigin}/orders/${id}`, listingId: 'synthetic_listing', board: 'all', quoteId: randomUUID(),
    wallet: g.wallet, payTo: g.payTo, network: g.network, asset: g.asset, amountAtomic, createdAt: now, expiresAt: now + 240000 };
}
const code = expected => error => error.code === expected && error.message === expected;
// Child failures report only synthetic file kind and stat checks, never paths,
// wallet identifiers, grant contents or credentials.
const statDiagnostics = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  const originalStat=fs.lstatSync;
  fs.lstatSync=(path,...options)=>{
    const stat=originalStat(path,...options),file=typeof path==='string'?path.match(/unattended\\.sqlite(-wal|-shm|-journal)?$/):null;
    if(file&&(stat.nlink!==1||(stat.mode&0o777)!==0o600||!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()))
      process.stderr.write(JSON.stringify({file:file[1]||'database',nlink:stat.nlink,mode:(stat.mode&0o777).toString(8),regular:stat.isFile(),symlink:stat.isSymbolicLink(),sameOwner:stat.uid===process.getuid()})+'\\n');
    return stat;
  };syncBuiltinESMExports();`;
function fixture(t, g = grant()) {
  const dir = mkdtempSync(join(tmpdir(), 'testnet-payment-store-')), stateDir = join(dir, 'state');
  const store = new PaymentStore(stateDir, g), stores = [store];
  t.after(() => { for (const opened of stores) try { opened.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { dir, stateDir, grant: g, store, reopen() { const next = new PaymentStore(stateDir, g); stores.push(next); return next; } };
}
function settle(store, o, transactionHash) {
  store.transition(o.id, 'reserved', 'signed');
  store.transition(o.id, 'signed', 'settling');
  return store.transition(o.id, 'settling', 'settled', { transactionHash });
}

test('reserve persists a frozen order and order-bound nonce before signing', t => {
  const f = fixture(t), o = order(f.grant);
  const result = f.store.reserve(o);
  assert.deepEqual(result.order, o);
  assert.equal(result.nonce, orderNonce(o));
  assert.equal(result.state, 'reserved');
  assert.deepEqual(result.evidence, {});
  result.order.amountAtomic = '1';
  assert.equal(f.store.get(o.id).order.amountAtomic, '5000000');
  assert.equal(f.reopen().get(o.id).state, 'reserved');
});

test('every existing id rejects replay even with changed, expired or invalid content', t => {
  const f = fixture(t), o = order(f.grant);
  f.store.reserve(o);
  for (const input of [o, { ...o, listingId: 'changed' }, { ...o, amountAtomic: '1' }, { ...o, expiresAt: 1 }]) assert.throws(() => f.store.reserve(input), code('ORDER_ALREADY_EXISTS'));
  f.store.revoke();
  assert.throws(() => f.store.reserve(o), code('ORDER_ALREADY_EXISTS'));
  assert.equal(f.store.summary().orders, 1);
});

test('one business quote cannot be repurchased with a new order, salt or amount after unknown and restart', t => {
  const f = fixture(t), first = order(f.grant, '10000');
  f.store.reserve(first);
  f.store.transition(first.id, 'reserved', 'unknown', { reasonCode: 'RESPONSE_LOST' });
  const reopened = f.reopen();
  for (const amount of ['10000', '20000']) {
    const retry = { ...order(f.grant, amount), quoteId: first.quoteId };
    assert.notEqual(retry.id, first.id);
    assert.notEqual(retry.salt, first.salt);
    assert.throws(() => reopened.reserve(retry), code('QUOTE_ALREADY_EXISTS'));
  }
  const nextQuote = order(f.grant, '10000');
  assert.equal(reopened.reserve(nextQuote).state, 'reserved');
  assert.equal(reopened.summary().orders, 2);
  assert.equal(reopened.summary().allocatedAtomic, '20000');
});

test('incompatible pre-quote schema fails closed without deleting existing orders', t => {
  const f = fixture(t), stateDir = join(f.dir, 'old-schema');
  mkdirSync(stateDir, { mode: 0o700 });
  const path = join(stateDir, 'unattended.sqlite');
  writeFileSync(path, '', { mode: 0o600 });
  const original = new DatabaseSync(path);
  original.exec('CREATE TABLE orders(id TEXT PRIMARY KEY, amount INTEGER NOT NULL);');
  original.prepare('INSERT INTO orders(id,amount) VALUES(?,?)').run('retained-order', 5000000);
  original.close();
  assert.throws(() => new PaymentStore(stateDir, f.grant), code('STORAGE_SCHEMA_INCOMPATIBLE'));
  const inspected = new DatabaseSync(path);
  try { assert.equal(inspected.prepare('SELECT amount FROM orders WHERE id = ?').get('retained-order').amount, 5000000); } finally { inspected.close(); }
});

test('full reserved and unknown amounts remain allocated forever', t => {
  const f = fixture(t), first = order(f.grant), second = order(f.grant);
  f.store.reserve(first);
  f.store.transition(first.id, 'reserved', 'unknown', { reasonCode: 'SIGNER_TIMEOUT' });
  f.store.reserve(second);
  assert.throws(() => f.store.reserve(order(f.grant, '10000')), code('TOTAL_BUDGET_EXCEEDED'));
  assert.equal(f.store.summary().remainingAtomic, '0');
  assert.equal(f.reopen().summary().reservedAtomic, '10000000');
  for (const next of ['signed', 'settling', 'settled', 'confirmed', 'unknown']) assert.throws(() => f.store.transition(first.id, 'unknown', next), code('INVALID_TRANSITION'));
});

test('settled and confirmed orders consume their full amount without releasing budget', t => {
  const f = fixture(t), first = order(f.grant), second = order(f.grant);
  f.store.reserve(first);
  settle(f.store, first, '0x' + 'ab'.repeat(32));
  f.store.transition(first.id, 'settled', 'confirmed', { paymentIntentId: 'pi_synthetic123' });
  f.store.reserve(second);
  assert.throws(() => f.store.reserve(order(f.grant, '10000')), code('TOTAL_BUDGET_EXCEEDED'));
  const summary = f.store.summary();
  assert.equal(summary.allocatedAtomic, '10000000');
  assert.equal(summary.confirmedAtomic, '5000000');
  assert.equal(summary.reservedAtomic, '5000000');
  assert.equal(summary.remainingAtomic, '0');
});

test('CAS transitions reject stale states, skips and missing orders', t => {
  const f = fixture(t), o = order(f.grant);
  f.store.reserve(o);
  assert.throws(() => f.store.transition(o.id, 'reserved', 'settling'), code('INVALID_TRANSITION'));
  f.store.transition(o.id, 'reserved', 'signed');
  assert.throws(() => f.store.transition(o.id, 'reserved', 'signed'), code('STATE_CONFLICT'));
  assert.throws(() => f.store.transition(randomUUID(), 'reserved', 'signed'), code('ORDER_NOT_FOUND'));
  assert.throws(() => f.store.transition(o.id, 'signed', 'settling', { signature: 'secret' }), code('INVALID_EVIDENCE'));
});

test('settlement and confirmation require globally unique public evidence', t => {
  const f = fixture(t), first = order(f.grant), second = order(f.grant), hash = '0x' + 'ab'.repeat(32);
  f.store.reserve(first); f.store.reserve(second);
  settle(f.store, first, hash);
  f.store.transition(first.id, 'settled', 'confirmed', { paymentIntentId: 'pi_synthetic123' });
  f.store.transition(second.id, 'reserved', 'signed'); f.store.transition(second.id, 'signed', 'settling');
  assert.throws(() => f.store.transition(second.id, 'settling', 'settled'), code('INVALID_TRANSACTION_HASH'));
  assert.throws(() => f.store.transition(second.id, 'settling', 'settled', { transactionHash: '0x123' }), code('INVALID_TRANSACTION_HASH'));
  assert.throws(() => f.store.transition(second.id, 'settling', 'settled', { transactionHash: hash.toUpperCase().replace('0X', '0x') }), code('TRANSACTION_ALREADY_EXISTS'));
  f.store.transition(second.id, 'settling', 'settled', { transactionHash: '0x' + 'cd'.repeat(32) });
  assert.throws(() => f.store.transition(second.id, 'settled', 'confirmed'), code('INVALID_PAYMENT_INTENT_ID'));
  assert.throws(() => f.store.transition(second.id, 'settled', 'confirmed', { paymentIntentId: 'pi_synthetic123' }), code('PAYMENT_INTENT_ALREADY_EXISTS'));
  assert.throws(() => f.store.transition(second.id, 'settled', 'confirmed', { paymentIntentId: 'pi_other', secret: 'forbidden' }), code('INVALID_EVIDENCE'));
  assert.equal(f.store.get(second.id).state, 'settled');
});

test('revocation persists and prevents reservations and further signing or submission', t => {
  const f = fixture(t), reserved = order(f.grant), signed = order(f.grant);
  f.store.reserve(reserved); f.store.reserve(signed);
  f.store.transition(signed.id, 'reserved', 'signed');
  f.store.revoke();
  const reopened = f.reopen();
  assert.equal(reopened.summary().revoked, true);
  assert.throws(() => reopened.assertActive(), code('GRANT_REVOKED'));
  assert.throws(() => reopened.reserve(order(f.grant)), code('GRANT_REVOKED'));
  assert.throws(() => reopened.transition(reserved.id, 'reserved', 'signed'), code('GRANT_REVOKED'));
  assert.throws(() => reopened.transition(signed.id, 'signed', 'settling'), code('GRANT_REVOKED'));
  reopened.transition(reserved.id, 'reserved', 'unknown');
  assert.equal(reopened.summary().remainingAtomic, '0');
});

test('trusted public settlement evidence may be recorded after revocation', t => {
  const f = fixture(t), o = order(f.grant);
  f.store.reserve(o); f.store.transition(o.id, 'reserved', 'signed'); f.store.transition(o.id, 'signed', 'settling');
  f.store.revoke();
  f.store.transition(o.id, 'settling', 'settled', { transactionHash: '0x' + 'ab'.repeat(32) });
  f.store.transition(o.id, 'settled', 'confirmed', { paymentIntentId: 'pi_postrevoke' });
  assert.equal(f.store.summary().allocatedAtomic, '5000000');
});

test('trusted reconciliation records unknown settlements after expiry and revocation without releasing budget', t => {
  const f = fixture(t), first = order(f.grant), second = order(f.grant);
  for (const o of [first, second]) {
    f.store.reserve(o);
    f.store.transition(o.id, 'reserved', 'signed');
    f.store.transition(o.id, 'signed', 'settling');
    f.store.transition(o.id, 'settling', 'unknown', { reasonCode: 'SETTLEMENT_RESPONSE_LOST' });
  }
  f.store.revoke();
  t.mock.method(Date, 'now', () => f.grant.expiresAt + 1);
  const hash = '0x' + 'ab'.repeat(32);
  const settled = f.store.reconcileSettlement(first.id, { transactionHash: hash });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.evidence.transactionHash, hash);
  assert.equal(settled.evidence.reasonCode, 'SETTLEMENT_RESPONSE_LOST');
  assert.throws(() => f.store.reconcileSettlement(first.id, { transactionHash: hash }), code('STATE_CONFLICT'));
  assert.throws(() => f.store.reconcileSettlement(second.id, { transactionHash: hash.toUpperCase().replace('0X', '0x') }), code('TRANSACTION_ALREADY_EXISTS'));
  assert.throws(() => f.store.reconcileSettlement(second.id, { transactionHash: '0x' + 'cd'.repeat(32), signature: 'forbidden' }), code('INVALID_EVIDENCE'));
  assert.throws(() => f.store.reconcileSettlement(second.id, {}), code('INVALID_TRANSACTION_HASH'));
  assert.throws(() => f.store.transition(second.id, 'unknown', 'settled', { transactionHash: '0x' + 'cd'.repeat(32) }), code('INVALID_TRANSITION'));
  f.store.transition(first.id, 'settled', 'confirmed', { paymentIntentId: 'pi_reconciled123' });
  const reopened = f.reopen();
  assert.equal(reopened.get(first.id).state, 'confirmed');
  assert.equal(reopened.get(second.id).state, 'unknown');
  assert.equal(reopened.summary().allocatedAtomic, '10000000');
  assert.equal(reopened.summary().remainingAtomic, '0');
  assert.equal(reopened.summary().revoked, true);
  assert.throws(() => reopened.assertActive(), code('GRANT_REVOKED'));
});

test('reconciliation accepts only unknown orders and cannot act as a normal transition', t => {
  const f = fixture(t), o = order(f.grant), evidence = { transactionHash: '0x' + 'ab'.repeat(32) };
  f.store.reserve(o);
  assert.throws(() => f.store.reconcileSettlement(o.id, evidence), code('STATE_CONFLICT'));
  assert.throws(() => f.store.reconcileSettlement(randomUUID(), evidence), code('ORDER_NOT_FOUND'));
  assert.equal(f.store.get(o.id).state, 'reserved');
  assert.equal(f.store.summary().allocatedAtomic, '5000000');
});

test('reconciliation preserves a known transaction and permits recovery with its own identical hash', t => {
  const f = fixture(t), o = order(f.grant), hash = '0x' + 'ab'.repeat(32);
  f.store.reserve(o);
  settle(f.store, o, hash);
  f.store.transition(o.id, 'settled', 'unknown', { reasonCode: 'EVIDENCE_UNCONFIRMED' });
  f.store.revoke();
  t.mock.method(Date, 'now', () => f.grant.expiresAt + 1);
  const reopened = f.reopen();
  assert.throws(() => reopened.reconcileSettlement(o.id, { transactionHash: '0x' + 'cd'.repeat(32) }), code('TRANSACTION_HASH_CONFLICT'));
  assert.equal(reopened.get(o.id).state, 'unknown');
  assert.equal(reopened.get(o.id).evidence.transactionHash, hash);
  const recovered = reopened.reconcileSettlement(o.id, { transactionHash: hash.toUpperCase().replace('0X', '0x') });
  assert.equal(recovered.state, 'settled');
  assert.equal(recovered.evidence.transactionHash, hash);
  reopened.transition(o.id, 'settled', 'confirmed', { paymentIntentId: 'pi_knownrecovered' });
  assert.equal(reopened.summary().allocatedAtomic, '5000000');
  assert.equal(reopened.summary().remainingAtomic, '5000000');
  assert.equal(reopened.summary().revoked, true);
});

test('expired grants remain inspectable and active checks have no writes', t => {
  const g = { ...grant(), expiresAt: Date.now() - 1 }, f = fixture(t, g);
  const before = f.store.summary();
  assert.equal(f.store.get(randomUUID()), null);
  assert.throws(() => f.store.assertActive(), code('GRANT_EXPIRED'));
  assert.throws(() => f.store.reserve(order(g)), code('GRANT_EXPIRED'));
  assert.deepEqual(f.store.summary(), before);
  assert.equal(f.reopen().summary().orders, 0);
});

test('an expired order cannot move into signing or settlement', t => {
  const f = fixture(t), reserved = order(f.grant), signed = order(f.grant);
  f.store.reserve(reserved); f.store.reserve(signed);
  f.store.transition(signed.id, 'reserved', 'signed');
  t.mock.method(Date, 'now', () => Math.max(reserved.expiresAt, signed.expiresAt));
  assert.throws(() => f.store.transition(reserved.id, 'reserved', 'signed'), code('INVALID_ORDER'));
  assert.throws(() => f.store.transition(signed.id, 'signed', 'settling'), code('INVALID_ORDER'));
  assert.equal(f.store.summary().allocatedAtomic, '10000000');
});

test('read failures expose fixed codes without storage paths or database diagnostics', t => {
  const f = fixture(t);
  assert.throws(() => f.store.get({ secret: 'forbidden' }), code('INVALID_ORDER_ID'));
  f.store.close();
  assert.throws(() => f.store.summary(), code('STORAGE_ERROR'));
  assert.throws(() => f.store.get(randomUUID()), code('STORAGE_ERROR'));
});

test('changing any grant identity, address or budget cannot reset its store', t => {
  const f = fixture(t);
  f.store.reserve(order(f.grant));
  for (const patch of [{ grantId: randomUUID() }, { userId: randomUUID() }, { wallet: f.grant.payTo }, { payTo: f.grant.wallet }, { totalAtomic: '9000000' }, { expiresAt: f.grant.expiresAt + 1 }]) {
    assert.throws(() => new PaymentStore(f.stateDir, { ...f.grant, ...patch }), code('GRANT_MISMATCH'));
  }
  assert.equal(f.store.summary().allocatedAtomic, '5000000');
});

test('non-testnet, invalid amounts and grant/order mismatches fail before reservation', t => {
  const f = fixture(t), o = order(f.grant);
  assert.throws(() => new PaymentStore(join(f.dir, 'invalid'), { ...f.grant, network: 'eip155:8453' }), code('INVALID_GRANT'));
  for (const patch of [{ amountAtomic: '5000001' }, { amountAtomic: 1 }, { amountAtomic: '01' }, { amountAtomic: '0' }, { network: 'eip155:8453' }, { wallet: f.grant.payTo }, { expiresAt: Date.now() - 1 }]) assert.throws(() => f.store.reserve({ ...o, ...patch }), code('INVALID_ORDER'));
  assert.equal(f.store.summary().orders, 0);
});

test('state directory, database and sidecars reject permissions, symlinks and hardlinks', t => {
  const f = fixture(t), unsafe = join(f.dir, 'unsafe');
  mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => new PaymentStore(unsafe, f.grant), code('UNSAFE_STATE_STORAGE'));
  const alias = join(f.dir, 'alias'); symlinkSync(f.stateDir, alias);
  assert.throws(() => new PaymentStore(alias, f.grant), code('UNSAFE_STATE_STORAGE'));
  const hardlinked = join(f.dir, 'hardlinked'); mkdirSync(hardlinked, { mode: 0o700 });
  const target = join(f.dir, 'target'); writeFileSync(target, '', { mode: 0o600 });
  linkSync(target, join(hardlinked, 'unattended.sqlite'));
  assert.throws(() => new PaymentStore(hardlinked, f.grant), code('UNSAFE_STATE_STORAGE'));
  const sidecar = join(f.dir, 'sidecar'); mkdirSync(sidecar, { mode: 0o700 });
  writeFileSync(join(sidecar, 'unattended.sqlite'), '', { mode: 0o600 });
  symlinkSync(join(f.dir, 'missing'), join(sidecar, 'unattended.sqlite-wal'));
  assert.throws(() => new PaymentStore(sidecar, f.grant), code('UNSAFE_STATE_STORAGE'));
  assert.equal(lstatSync(f.stateDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.stateDir, 'unattended.sqlite')).mode & 0o777, 0o600);
  const perms = join(f.dir, 'perms'); mkdirSync(perms, { mode: 0o700 });
  writeFileSync(join(perms, 'unattended.sqlite'), '', { mode: 0o600 }); chmodSync(join(perms, 'unattended.sqlite'), 0o644);
  assert.throws(() => new PaymentStore(perms, f.grant), code('UNSAFE_STATE_STORAGE'));
});

test('an unlinked optional sidecar is allowed only with safe type, owner and permissions', async t => {
  const f = fixture(t), moduleUrl = new URL('../src/unattended/store.mjs', import.meta.url).href;
  const program = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.lstatSync,scenario=process.argv[3];let observed=0;
    fs.lstatSync=(path,...options)=>{
      const stat=original(path,...options);
      if(path.endsWith(scenario==='database'?'unattended.sqlite':'unattended.sqlite-shm')){
        observed++;stat.nlink=scenario==='hardlink'?2:0;
        if(scenario==='permissions')stat.mode=(stat.mode&~0o777)|0o640;
        if(scenario==='owner')stat.uid=process.getuid()+1;
      }
      return stat;
    };syncBuiltinESMExports();
    const {PaymentStore}=await import(${JSON.stringify(moduleUrl)});
    try{const store=new PaymentStore(process.argv[1],JSON.parse(process.argv[2]));store.close();process.stdout.write(JSON.stringify({accepted:true,observed}));}
    catch(error){process.stdout.write(JSON.stringify({code:error.code,observed}));}`;
  for (const scenario of ['safe', 'database', 'hardlink', 'permissions', 'owner', 'symlink']) {
    const stateDir = join(f.dir, 'unlinked-' + scenario);
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(join(stateDir, 'unattended.sqlite'), '', { mode: 0o600 });
    const sidecar = join(stateDir, 'unattended.sqlite-shm');
    if (scenario === 'symlink') {
      const target = join(stateDir, 'synthetic-target'); writeFileSync(target, '', { mode: 0o600 }); symlinkSync(target, sidecar);
    } else writeFileSync(sidecar, '', { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, stateDir, JSON.stringify(f.grant), scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
      child.on('error', reject); child.on('close', exitCode => exitCode === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    });
    assert.ok(result.observed > 0, scenario);
    if (scenario === 'safe') assert.equal(result.accepted, true);
    else assert.equal(result.code, 'UNSAFE_STATE_STORAGE', scenario);
  }
});

test('eight independent processes cold-start without overspending across ten fresh stores', async t => {
  const f = fixture(t), moduleUrl = new URL('../src/unattended/store.mjs', import.meta.url).href;
  const program = `${statDiagnostics}\nimport {PaymentStore} from ${JSON.stringify(moduleUrl)};
    const store=new PaymentStore(process.argv[1],JSON.parse(process.argv[2]));
    try{store.reserve(JSON.parse(process.argv[3]));process.stdout.write('reserved');}
    catch(error){if(error.code!=='TOTAL_BUDGET_EXCEEDED')throw error;process.stdout.write('denied');}
    finally{store.close();}`;
  for (let iteration = 0; iteration < 10; iteration++) {
    const stateDir = join(f.dir, `cold-${iteration}`);
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, stateDir, JSON.stringify(f.grant), JSON.stringify(order(f.grant, '3000000'))], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
      child.on('error', reject); child.on('close', exitCode => exitCode === 0 ? resolve(out) : reject(new Error(err)));
    })));
    assert.equal(results.filter(result => result === 'reserved').length, 3);
    assert.equal(results.filter(result => result === 'denied').length, 5);
    const reopened = new PaymentStore(stateDir, f.grant);
    try { assert.equal(reopened.summary().allocatedAtomic, '9000000'); assert.equal(reopened.summary().remainingAtomic, '1000000'); } finally { reopened.close(); }
  }
});

test('eight processes using different order ids can reserve a business quote only once', async t => {
  const f = fixture(t), stateDir = join(f.dir, 'same-quote'), quoteId = randomUUID();
  const moduleUrl = new URL('../src/unattended/store.mjs', import.meta.url).href;
  const program = `${statDiagnostics}\nimport {PaymentStore} from ${JSON.stringify(moduleUrl)};
    const store=new PaymentStore(process.argv[1],JSON.parse(process.argv[2]));
    try{store.reserve(JSON.parse(process.argv[3]));process.stdout.write('reserved');}
    catch(error){if(error.code!=='QUOTE_ALREADY_EXISTS')throw error;process.stdout.write('duplicate');}
    finally{store.close();}`;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const candidate = { ...order(f.grant, '10000'), quoteId };
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, stateDir, JSON.stringify(f.grant), JSON.stringify(candidate)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('close', exitCode => exitCode === 0 ? resolve(out) : reject(new Error(err)));
  })));
  assert.equal(results.filter(result => result === 'reserved').length, 1);
  assert.equal(results.filter(result => result === 'duplicate').length, 7);
  const reopened = new PaymentStore(stateDir, f.grant);
  try { assert.equal(reopened.summary().orders, 1); assert.equal(reopened.summary().allocatedAtomic, '10000'); } finally { reopened.close(); }
});
