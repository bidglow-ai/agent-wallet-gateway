import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateGrant, validateOrder, orderNonce } from './intent.mjs';

const STATES = new Set(['reserved', 'signed', 'settling', 'settled', 'confirmed', 'unknown']);
const NEXT = { reserved: 'signed', signed: 'settling', settling: 'settled', settled: 'confirmed' };
const HASH = /^0x[0-9a-fA-F]{64}$/;

export class PaymentStoreError extends Error {
  constructor(code) { super(code); this.name = 'PaymentStoreError'; this.code = code; }
}
function fail(code) { throw new PaymentStoreError(code); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function secure(path, directory = false, optional = false) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_STATE_STORAGE');
  // macOS lstat may return a valid inode with nlink=0 during concurrent unlink.
  // Only an otherwise-safe optional SQLite sidecar may disappear this way.
  // The database remains mandatory, and multiple links are always rejected.
  if (!directory && stat.nlink !== 1 && !(optional && stat.nlink === 0)) fail('UNSAFE_STATE_STORAGE');
}
function publicEvidence(to, value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_EVIDENCE');
  const allowed = to === 'settled' ? ['transactionHash'] : to === 'confirmed' ? ['paymentIntentId'] : to === 'unknown' ? ['reasonCode'] : [];
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_EVIDENCE');
  if (to === 'settled' && (typeof value.transactionHash !== 'string' || !HASH.test(value.transactionHash))) fail('INVALID_TRANSACTION_HASH');
  if (to === 'confirmed' && (typeof value.paymentIntentId !== 'string' || !/^pi_[A-Za-z0-9]{1,128}$/.test(value.paymentIntentId))) fail('INVALID_PAYMENT_INTENT_ID');
  if (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.reasonCode))) fail('INVALID_EVIDENCE');
  return to === 'settled' ? { transactionHash: value.transactionHash.toLowerCase() } : { ...value };
}
function validated(fn, fallback) {
  try { return fn(); } catch { fail(fallback); }
}

export class PaymentStore {
  #db;
  constructor(stateDir, grant) {
    const canonical = validated(() => validateGrant(grant, 0), 'INVALID_GRANT');
    Object.defineProperty(this, 'grant', { value: canonical, enumerable: true });
    if (typeof stateDir !== 'string' || !stateDir) fail('UNSAFE_STATE_STORAGE');
    try {
      const directory = resolve(stateDir);
      if (!exists(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
      secure(directory, true);
      const path = join(directory, 'unattended.sqlite');
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        closeSync(fd);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      // SQLite may remove sidecars when the last connection closes. Inspect
      // each once, tolerating only absence, rather than racing exists/lstat.
      for (const suffix of ['', '-wal', '-shm', '-journal']) secure(path + suffix, false, suffix !== '');
      this.#db = new DatabaseSync(path);
      this.#db.exec('PRAGMA busy_timeout=10000;');
      // Concurrent first opens may return SQLITE_BUSY while changing journal
      // mode despite busy_timeout. Retry only this idempotent setup statement.
      // Reservations, transitions and external money operations are never retried.
      for (let attempt = 0; ; attempt++) {
        try { this.#db.exec('PRAGMA journal_mode=WAL;'); break; }
        catch (error) {
          if (error.errcode !== 5 || attempt >= 4) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      this.#db.exec('PRAGMA synchronous=FULL;');
      this.#db.exec(`CREATE TABLE IF NOT EXISTS grant_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), grant_json TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, order_json TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE,
          merchant_account TEXT NOT NULL, quote_id TEXT NOT NULL,
          amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 5000000),
          state TEXT NOT NULL CHECK(state IN ('reserved','signed','settling','settled','confirmed','unknown')),
          transaction_hash TEXT UNIQUE, payment_intent_id TEXT UNIQUE, evidence_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );`);
      const columns = new Set(this.#db.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
      if (!columns.has('merchant_account') || !columns.has('quote_id')) fail('STORAGE_SCHEMA_INCOMPATIBLE');
      this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_business_quote ON orders(merchant_account,quote_id);');
      this.#transaction(() => {
        const encoded = stable(canonical);
        const row = this.#db.prepare('SELECT grant_json FROM grant_state WHERE singleton = 1').get();
        if (row && row.grant_json !== encoded) fail('GRANT_MISMATCH');
        if (!row) this.#db.prepare('INSERT INTO grant_state(singleton,grant_json) VALUES(1,?)').run(encoded);
      });
      for (const suffix of ['', '-wal', '-shm']) secure(path + suffix, false, suffix !== '');
    } catch (error) {
      try { this.#db?.close(); } catch {}
      if (error instanceof PaymentStoreError) throw error;
      fail('STORAGE_ERROR');
    }
  }

  #transaction(fn) {
    let started = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); started = true;
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (started) { try { this.#db.exec('ROLLBACK'); } catch {} }
      if (error instanceof PaymentStoreError) throw error;
      fail('STORAGE_ERROR');
    }
  }

  #read(fn) {
    try { return fn(); } catch (error) {
      if (error instanceof PaymentStoreError) throw error;
      fail('STORAGE_ERROR');
    }
  }

  assertActive(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_TIME');
    const row = this.#read(() => this.#db.prepare('SELECT revoked FROM grant_state WHERE singleton = 1').get());
    if (row.revoked) fail('GRANT_REVOKED');
    if (now >= this.grant.expiresAt) fail('GRANT_EXPIRED');
    return true;
  }

  reserve(order) {
    return this.#transaction(() => {
      const descriptor = order && typeof order === 'object' ? Object.getOwnPropertyDescriptor(order, 'id') : undefined;
      const requestedId = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (typeof requestedId === 'string' && this.#db.prepare('SELECT id FROM orders WHERE id = ?').get(requestedId)) fail('ORDER_ALREADY_EXISTS');
      this.assertActive();
      const canonical = validated(() => validateOrder(order, this.grant, Date.now()), 'INVALID_ORDER');
      const nonce = validated(() => orderNonce(canonical), 'INVALID_ORDER');
      if (typeof nonce !== 'string' || !HASH.test(nonce)) fail('INVALID_ORDER');
      if (this.#db.prepare('SELECT id FROM orders WHERE merchant_account = ? AND quote_id = ?').get(canonical.merchantAccount, canonical.quoteId)) fail('QUOTE_ALREADY_EXISTS');
      if (this.#db.prepare('SELECT id FROM orders WHERE nonce = ?').get(nonce.toLowerCase())) fail('NONCE_ALREADY_EXISTS');
      const used = this.#db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM orders').get().amount;
      const amount = Number(canonical.amountAtomic);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Number(this.grant.perCallAtomic)) fail('PER_CALL_BUDGET_EXCEEDED');
      if (used + amount > Number(this.grant.totalAtomic)) fail('TOTAL_BUDGET_EXCEEDED');
      const now = Date.now();
      this.#db.prepare("INSERT INTO orders(id,order_json,nonce,merchant_account,quote_id,amount,state,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved','{}',?,?)").run(canonical.id, stable(canonical), nonce.toLowerCase(), canonical.merchantAccount, canonical.quoteId, amount, now, now);
      return this.get(canonical.id);
    });
  }

  transition(id, from, to, evidence = {}) {
    if (!STATES.has(from) || !STATES.has(to) || from === 'confirmed' || from === 'unknown' || !(NEXT[from] === to || to === 'unknown')) fail('INVALID_TRANSITION');
    const safeEvidence = publicEvidence(to, evidence);
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!row) fail('ORDER_NOT_FOUND');
      if (row.state !== from) fail('STATE_CONFLICT');
      if (to === 'signed' || to === 'settling') {
        this.assertActive();
        validated(() => validateOrder(JSON.parse(row.order_json), this.grant, Date.now()), 'INVALID_ORDER');
      }
      if (to === 'settled' && this.#db.prepare('SELECT id FROM orders WHERE transaction_hash = ?').get(safeEvidence.transactionHash)) fail('TRANSACTION_ALREADY_EXISTS');
      if (to === 'confirmed' && this.#db.prepare('SELECT id FROM orders WHERE payment_intent_id = ?').get(safeEvidence.paymentIntentId)) fail('PAYMENT_INTENT_ALREADY_EXISTS');
      const merged = { ...JSON.parse(row.evidence_json), ...safeEvidence };
      this.#db.prepare('UPDATE orders SET state = ?, evidence_json = ?, transaction_hash = ?, payment_intent_id = ?, updated_at = ? WHERE id = ?').run(to, stable(merged), merged.transactionHash ?? null, merged.paymentIntentId ?? null, Date.now(), id);
      return this.get(id);
    });
  }

  // Trusted reconciliation only: the caller must independently verify the exact
  // order/nonce receipt. This records existing money movement; it never signs,
  // submits, releases a reservation, or reactivates the grant.
  reconcileSettlement(id, evidence) {
    const safeEvidence = publicEvidence('settled', evidence);
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!row) fail('ORDER_NOT_FOUND');
      if (row.state !== 'unknown') fail('STATE_CONFLICT');
      if (row.transaction_hash && row.transaction_hash !== safeEvidence.transactionHash) fail('TRANSACTION_HASH_CONFLICT');
      if (this.#db.prepare('SELECT id FROM orders WHERE transaction_hash = ? AND id <> ?').get(safeEvidence.transactionHash, id)) fail('TRANSACTION_ALREADY_EXISTS');
      const merged = { ...JSON.parse(row.evidence_json), ...safeEvidence };
      this.#db.prepare("UPDATE orders SET state = 'settled', evidence_json = ?, transaction_hash = ?, updated_at = ? WHERE id = ?").run(stable(merged), safeEvidence.transactionHash, Date.now(), id);
      return this.get(id);
    });
  }

  get(id) {
    return this.#read(() => {
      if (typeof id !== 'string') fail('INVALID_ORDER_ID');
      const row = this.#db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      return row ? { order: JSON.parse(row.order_json), nonce: row.nonce, state: row.state, evidence: JSON.parse(row.evidence_json), createdAt: row.created_at, updatedAt: row.updated_at } : null;
    });
  }

  summary() {
    return this.#read(() => {
    const rows = this.#db.prepare('SELECT state,COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount FROM orders GROUP BY state').all();
    const states = Object.fromEntries([...STATES].map(state => [state, 0]));
    let allocated = 0, confirmed = 0, orders = 0;
    for (const row of rows) { states[row.state] = row.count; orders += row.count; allocated += row.amount; if (row.state === 'confirmed') confirmed += row.amount; }
    const revoked = Boolean(this.#db.prepare('SELECT revoked FROM grant_state WHERE singleton = 1').get().revoked);
    return { grantId: this.grant.grantId, revoked, totalAtomic: this.grant.totalAtomic, allocatedAtomic: String(allocated), reservedAtomic: String(allocated - confirmed), confirmedAtomic: String(confirmed), remainingAtomic: String(Number(this.grant.totalAtomic) - allocated), orders, states };
    });
  }

  revoke() {
    this.#transaction(() => { this.#db.prepare('UPDATE grant_state SET revoked = 1 WHERE singleton = 1').run(); });
    return this.summary();
  }

  close() { this.#read(() => this.#db.close()); }
}
