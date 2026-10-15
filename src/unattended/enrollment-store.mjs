import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, PaymentError, validateGrant } from './intent.mjs';
import { PaymentStore } from './store.mjs';
import { isBoundedDelegationExpiry } from './duration-policy.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIDECAR = /^(enrollment|unattended)\.sqlite-(wal|shm|journal)$/;

export class EnrollmentStoreError extends PaymentError {
  constructor(code) { super(code); this.name = 'EnrollmentStoreError'; }
}
function fail(code) { throw new EnrollmentStoreError(code); }
function plain(input, keys, code) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join('|') !== [...keys].sort().join('|')) fail(code);
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}
function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function secure(path, directory = false, optional = false) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_ENROLLMENT_STORAGE');
  if (!directory && stat.nlink !== 1 && !(optional && stat.nlink === 0)) fail('UNSAFE_ENROLLMENT_STORAGE');
}
function config(input) {
  const result = plain(input, ['projectId', 'expectedWallet'], 'ENROLLMENT_CONFIGURATION_REQUIRED');
  if (typeof result.projectId !== 'string' || !UUID.test(result.projectId) || typeof result.expectedWallet !== 'string' || !ADDRESS.test(result.expectedWallet) || /^0x0{40}$/.test(result.expectedWallet)) fail('ENROLLMENT_CONFIGURATION_REQUIRED');
  return Object.freeze(result);
}

// Internal trusted service only. verifiedIdentity must come directly from the
// configured provider's verifyEnrollment(), never from an HTTP request body.
// Each dedicated private root holds one lifetime mandate and one fixed ledger.
export class EnrollmentStore {
  #db; #root; #config;
  constructor(stateDir, trustedConfig) {
    this.#config = config(trustedConfig);
    if (typeof stateDir !== 'string' || !stateDir) fail('ENROLLMENT_CONFIGURATION_REQUIRED');
    this.#root = resolve(stateDir);
    Object.defineProperty(this, 'budgetStateDir', { value: join(this.#root, 'payer'), enumerable: true });
    try {
      if (!exists(this.#root)) mkdirSync(this.#root, { recursive: true, mode: 0o700 });
      secure(this.#root, true);
      this.#checkFiles();
      const path = join(this.#root, 'enrollment.sqlite');
      // A missing registry is not permission to recreate an existing budget.
      if (!exists(path) && exists(this.budgetStateDir)) fail('ENROLLMENT_REGISTRY_MISSING');
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        closeSync(fd);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      secure(path);
      this.#db = new DatabaseSync(path);
      this.#db.exec('PRAGMA busy_timeout=10000;');
      for (let attempt = 0; ; attempt++) {
        try { this.#db.exec('PRAGMA journal_mode=WAL;'); break; }
        catch (error) {
          if (error.errcode !== 5 || attempt >= 4) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      this.#db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS configuration(singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS enrollment(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          state TEXT NOT NULL CHECK(state IN ('pending','active')), grant_json TEXT NOT NULL, created_at INTEGER NOT NULL);`);
      this.#transaction(() => {
        const row = this.#db.prepare('SELECT config_json FROM configuration WHERE singleton=1').get();
        if (row && row.config_json !== canonical(this.#config)) fail('ENROLLMENT_CONFIGURATION_MISMATCH');
        if (!row) this.#db.prepare('INSERT INTO configuration(singleton,config_json) VALUES(1,?)').run(canonical(this.#config));
        const registered = this.#db.prepare('SELECT * FROM enrollment WHERE singleton=1').get();
        if (registered?.state === 'pending') fail('ENROLLMENT_INCOMPLETE');
        if (registered) this.#checkLedger(this.#grant(registered.grant_json));
        else if (exists(this.budgetStateDir)) fail('ENROLLMENT_ORPHANED_LEDGER');
      });
      this.#checkFiles();
    } catch (error) {
      try { this.#db?.close(); } catch {}
      if (error instanceof EnrollmentStoreError) throw error;
      fail('ENROLLMENT_STORAGE_ERROR');
    }
  }

  #checkFiles() {
    secure(this.#root, true);
    for (const name of readdirSync(this.#root)) {
      if (name === 'payer') {
        secure(this.budgetStateDir, true);
        for (const child of readdirSync(this.budgetStateDir)) secure(join(this.budgetStateDir, child), false, SIDECAR.test(child));
      } else secure(join(this.#root, name), false, SIDECAR.test(name));
    }
  }
  #grant(encoded) {
    try {
      const grant = validateGrant(JSON.parse(encoded));
      if (grant.wallet !== this.#config.expectedWallet) fail('ENROLLMENT_GRANT_MISMATCH');
      return grant;
    } catch (error) { if (error instanceof EnrollmentStoreError) throw error; fail('ENROLLMENT_STORAGE_ERROR'); }
  }
  #checkLedger(grant) {
    if (!exists(this.budgetStateDir) || !exists(join(this.budgetStateDir, 'unattended.sqlite'))) fail('ENROLLMENT_LEDGER_MISSING');
    this.#checkFiles();
    let db;
    try {
      db = new DatabaseSync(join(this.budgetStateDir, 'unattended.sqlite'), { readOnly: true });
      db.exec('PRAGMA busy_timeout=10000;');
      const row = db.prepare('SELECT grant_json,revoked FROM grant_state WHERE singleton=1').get();
      if (!row || canonical(validateGrant(JSON.parse(row.grant_json))) !== canonical(grant)) fail('ENROLLMENT_GRANT_MISMATCH');
      const columns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
      if (!['id', 'merchant_account', 'quote_id', 'nonce', 'amount', 'state'].every(name => columns.has(name))) fail('ENROLLMENT_STORAGE_ERROR');
      return { revoked: Boolean(row.revoked) };
    } catch (error) { if (error instanceof EnrollmentStoreError) throw error; fail('ENROLLMENT_STORAGE_ERROR'); }
    finally { try { db?.close(); } catch {} }
  }
  #transaction(fn) {
    let started = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); started = true;
      const result = fn(); this.#db.exec('COMMIT'); return result;
    } catch (error) {
      if (started) try { this.#db.exec('ROLLBACK'); } catch {}
      if (error instanceof EnrollmentStoreError) throw error;
      fail('ENROLLMENT_STORAGE_ERROR');
    }
  }
  get() {
    try {
      this.#checkFiles();
      const row = this.#db.prepare('SELECT * FROM enrollment WHERE singleton=1').get();
      if (!row) {
        if (exists(this.budgetStateDir)) fail('ENROLLMENT_ORPHANED_LEDGER');
        return null;
      }
      if (row.state !== 'active') fail('ENROLLMENT_INCOMPLETE');
      const grant = this.#grant(row.grant_json);
      this.#checkLedger(grant);
      return grant;
    } catch (error) { if (error instanceof EnrollmentStoreError) throw error; fail('ENROLLMENT_STORAGE_ERROR'); }
  }
  enroll(verifiedIdentity, serverProposedGrant) {
    const identity = plain(verifiedIdentity, ['userId', 'wallet', 'delegationExpiresAt'], 'AUTHENTICATED_ENROLLMENT_REQUIRED');
    const now = Date.now();
    if (typeof identity.userId !== 'string' || !UUID.test(identity.userId) || identity.wallet !== this.#config.expectedWallet || !isBoundedDelegationExpiry(identity.delegationExpiresAt,now)) fail('AUTHENTICATED_ENROLLMENT_REQUIRED');
    let proposed;
    try { proposed = validateGrant(serverProposedGrant); } catch { fail('ENROLLMENT_GRANT_MISMATCH'); }
    if (proposed.userId !== identity.userId || proposed.wallet !== identity.wallet || proposed.expiresAt <= now || proposed.expiresAt > identity.delegationExpiresAt) fail('ENROLLMENT_GRANT_MISMATCH');
    const existing = this.#transaction(() => {
      this.#checkFiles();
      const row = this.#db.prepare('SELECT * FROM enrollment WHERE singleton=1').get();
      if (row) {
        if (row.state !== 'active') fail('ENROLLMENT_INCOMPLETE');
        const grant = this.#grant(row.grant_json);
        if (grant.userId !== identity.userId || canonical(grant) !== canonical(proposed)) fail('ENROLLMENT_GRANT_MISMATCH');
        if (this.#checkLedger(grant).revoked) fail('ENROLLMENT_REVOKED');
        return grant;
      }
      if (exists(this.budgetStateDir)) fail('ENROLLMENT_ORPHANED_LEDGER');
      this.#db.prepare("INSERT INTO enrollment(singleton,state,grant_json,created_at) VALUES(1,'pending',?,?)").run(canonical(proposed), now);
      return null;
    });
    if (existing) return { grant: existing, created: false, budgetStateDir: this.budgetStateDir };
    // Deliberately two-phase. Any interruption leaves durable pending state;
    // no automatic repair, new budget, new grant, expiry extension or retry.
    try {
      const payer = new PaymentStore(this.budgetStateDir, proposed);
      try { this.#checkLedger(proposed); } finally { payer.close(); }
      this.#transaction(() => {
        const row = this.#db.prepare('SELECT * FROM enrollment WHERE singleton=1').get();
        if (row?.state !== 'pending' || row.grant_json !== canonical(proposed) || proposed.expiresAt <= Date.now()) fail('ENROLLMENT_INCOMPLETE');
        this.#checkLedger(proposed);
        this.#db.prepare("UPDATE enrollment SET state='active' WHERE singleton=1").run();
      });
      return { grant: proposed, created: true, budgetStateDir: this.budgetStateDir };
    } catch (error) { if (error instanceof EnrollmentStoreError) throw error; fail('ENROLLMENT_INITIALIZATION_UNCONFIRMED'); }
  }
  close() {
    try { this.#db.close(); } catch { fail('ENROLLMENT_STORAGE_ERROR'); }
  }
}
