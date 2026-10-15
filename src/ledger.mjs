import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const POLICY_KEYS = ['allowedOrigins', 'allowedPaths', 'expiresAt', 'perCallAtomic', 'totalAtomic'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function fail(message) { throw new Error(message); }
function atomic(value, name, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 8) fail(`${name} must be a canonical atomic-unit integer string`);
  const amount = BigInt(value);
  if ((!allowZero && amount === 0n) || amount > 10000000n) fail(`${name} is outside the supported range`);
  return Number(amount);
}
function stable(value, depth = 0) {
  if (depth > 32) fail('Request body is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('Sparse or decorated request arrays are not supported');
    return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(',')}}`;
  }
  fail('Request body must contain plain JSON values; numbers must be safe integers');
}
function validatePolicy(policy) {
  if (!policy || Object.getPrototypeOf(policy) !== Object.prototype || Object.keys(policy).sort().join('|') !== POLICY_KEYS.join('|')) fail('Policy has missing or unsupported fields');
  const total = atomic(policy.totalAtomic, 'totalAtomic');
  const perCall = atomic(policy.perCallAtomic, 'perCallAtomic');
  if (perCall > 5000000 || perCall > total) fail('perCallAtomic exceeds the allowed limit');
  if (!Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= 0) fail('expiresAt must be a positive Unix millisecond integer');
  for (const key of ['allowedOrigins', 'allowedPaths']) {
    if (!Array.isArray(policy[key]) || policy[key].length === 0 || policy[key].length > 100 || new Set(policy[key]).size !== policy[key].length) fail(`${key} must be a nonempty unique allowlist`);
  }
  for (const origin of policy.allowedOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { fail('Invalid allowed origin'); }
    if (typeof origin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) fail('Allowed origins must be exact canonical HTTPS origins');
  }
  for (const path of policy.allowedPaths) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#%\\\s]/.test(path) || new URL(path, 'https://policy.invalid').pathname !== path) fail('Allowed paths must be exact canonical paths without query or escapes');
  }
  return { allowedOrigins: [...policy.allowedOrigins].sort(), allowedPaths: [...policy.allowedPaths].sort(), expiresAt: policy.expiresAt, perCallAtomic: policy.perCallAtomic, totalAtomic: policy.totalAtomic };
}
function securePath(path, directory) {
  const stat = lstatSync(path);
  const expected = directory ? 0o700 : 0o600;
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o777) !== expected || (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) fail(`Unsafe state ${directory ? 'directory' : 'file'}: ${path}`);
}
function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export class BudgetLedger {
  constructor(stateDir, policy) {
    if (typeof stateDir !== 'string' || !stateDir) fail('stateDir is required');
    const validated = validatePolicy(policy);
    Object.freeze(validated.allowedOrigins);
    Object.freeze(validated.allowedPaths);
    Object.defineProperty(this, 'policy', { value: Object.freeze(validated), enumerable: true });
    this.stateDir = resolve(stateDir);
    if (!pathExists(this.stateDir)) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    securePath(this.stateDir, true);
    const path = join(this.stateDir, 'ledger.sqlite');
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (pathExists(path + suffix)) securePath(path + suffix, false);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY, request TEXT NOT NULL, request_hash TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 5000000),
          state TEXT NOT NULL CHECK(state IN ('pending','unknown','confirmed')),
          spent INTEGER CHECK(spent >= 0 AND spent <= amount), created_at INTEGER NOT NULL,
          CHECK((state = 'confirmed' AND spent IS NOT NULL) OR (state != 'confirmed' AND spent IS NULL))
        );`);
      this.transaction(() => {
        const encoded = stable(this.policy);
        const existing = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('policy');
        if (existing && existing.value !== encoded) fail('Policy differs from the durable ledger policy; changing policy cannot reset a budget');
        if (!existing) this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('policy', encoded);
      });
      for (const suffix of ['', '-wal', '-shm']) if (pathExists(path + suffix)) securePath(path + suffix, false);
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  reserve(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['id', 'url', 'method', 'body', 'amountAtomic'].includes(key))) fail('Invalid reservation fields');
    const { id, url, method, amountAtomic } = input;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(id)) fail('Invalid payment id');
    if (!METHODS.has(method)) fail('Invalid HTTP method');
    let parsed;
    try { parsed = new URL(url); } catch { fail('Invalid payment URL'); }
    if (typeof url !== 'string' || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !this.policy.allowedOrigins.includes(parsed.origin) || !this.policy.allowedPaths.includes(parsed.pathname)) fail('Payment URL is outside the exact HTTPS allowlist');
    const amount = atomic(amountAtomic, 'amountAtomic');
    if (amount > Number(this.policy.perCallAtomic)) fail('Per-call budget exceeded');
    const request = stable({ url: parsed.href, method, body: input.body === undefined ? null : input.body, amountAtomic });
    const requestHash = createHash('sha256').update(stable({ url: parsed.href, method, body: input.body === undefined ? null : input.body })).digest('hex');
    if (Buffer.byteLength(request) > 65536) fail('Payment request is too large');
    this.transaction(() => {
      if (Date.now() >= this.policy.expiresAt) fail('Payment policy has expired');
      const existing = this.db.prepare('SELECT request FROM payments WHERE id = ?').get(id);
      if (existing) fail(existing.request === request ? 'Payment id already exists; inspect its status, never replay it' : 'Payment id reused with a changed request');
      if (this.db.prepare('SELECT id FROM payments WHERE request_hash = ?').get(requestHash)) fail('Payment request already exists under another id; inspect the original payment, never replay it');
      const { committed } = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN state = 'confirmed' THEN spent ELSE amount END),0) AS committed FROM payments").get();
      if (committed + amount > Number(this.policy.totalAtomic)) fail('Aggregate budget exceeded');
      this.db.prepare("INSERT INTO payments(id,request,request_hash,amount,state,created_at) VALUES(?,?,?,?,'pending',?)").run(id, request, requestHash, amount, Date.now());
    });
    return this.get(id);
  }

  markUnknown(id) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM payments WHERE id = ?').get(id);
      if (!row) fail('Unknown payment id');
      if (row.state === 'confirmed') fail('Confirmed payment cannot become unknown');
      this.db.prepare("UPDATE payments SET state = 'unknown' WHERE id = ?").run(id);
    });
    return this.get(id);
  }

  confirm(id, spentAtomic) {
    const spent = atomic(spentAtomic, 'spentAtomic', true);
    this.transaction(() => {
      const row = this.db.prepare('SELECT state,amount FROM payments WHERE id = ?').get(id);
      if (!row) fail('Unknown payment id');
      if (row.state === 'confirmed') fail('Payment is already confirmed');
      if (spent > row.amount) fail('Confirmed spending exceeds the reservation');
      this.db.prepare("UPDATE payments SET state = 'confirmed', spent = ? WHERE id = ?").run(spent, id);
    });
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    return row ? { id: row.id, ...JSON.parse(row.request), state: row.state, amountAtomic: String(row.amount), spentAtomic: row.spent === null ? null : String(row.spent), createdAt: row.created_at } : null;
  }

  summary() {
    const row = this.db.prepare("SELECT COUNT(*) AS payments, COALESCE(SUM(CASE WHEN state = 'confirmed' THEN spent ELSE 0 END),0) AS spent, COALESCE(SUM(CASE WHEN state != 'confirmed' THEN amount ELSE 0 END),0) AS reserved FROM payments").get();
    return { totalAtomic: this.policy.totalAtomic, perCallAtomic: this.policy.perCallAtomic, spentAtomic: String(row.spent), reservedAtomic: String(row.reserved), remainingAtomic: String(Number(this.policy.totalAtomic) - row.spent - row.reserved), payments: row.payments, expiresAt: this.policy.expiresAt };
  }

  close() { this.db.close(); }
}
