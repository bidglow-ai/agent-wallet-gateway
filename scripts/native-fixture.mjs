import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORK, TOKEN, PaymentError, orderNonce, paymentTypedData, verifyOrderPayload } from '../src/unattended/intent.mjs';
import { PaymentStore } from '../src/unattended/store.mjs';
import { TestnetBroker } from '../src/unattended/broker.mjs';
import { createBrokerHttpServer } from '../src/unattended/http.mjs';

// No CDP signer, AWAL, RPC, facilitator, Stripe client or external HTTP exists in
// this harness. This account has no funding path; its key lives only in memory.
// Trusted runners may import this explicitly. Only direct CLI use needs the flag.
export async function startSyntheticFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidglow-native-synthetic-'));
  const created = lstatSync(stateDir);
  const tracePath = join(stateDir, 'trace.jsonl');
  const counters = { pay: 0, inspect: 0, reconcile: 0, sign: 0, settle: 0 };
  const pending = new Set(), events = [], settlements = new Map();
  let store, server, traceFd, closing = false, closed = false, closingPromise, lastSnapshot, verifications = 0, traceTruncated = false;
  const synthetic = Object.freeze({ syntheticOnly: true, nativeAccepted: false, providerCalls: 0, providerAcceptance: false, providerPaymentAccepted: false, fundingAccepted: false, mainnetEnabled: false });
  const cleanup = () => {
    const current = lstatSync(stateDir);
    if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== created.ino || current.dev !== created.dev || current.uid !== created.uid || (current.mode & 0o777) !== 0o700) throw new PaymentError('SYNTHETIC_CLEANUP_REJECTED');
    // Exact directory returned by this invocation's mkdtemp, never a caller path.
    rmSync(stateDir, { recursive: true, force: false });
  };
  try {
    if (!created.isDirectory() || (created.mode & 0o777) !== 0o700 || (process.getuid && created.uid !== process.getuid())) throw new PaymentError('UNSAFE_SYNTHETIC_STATE');
    const account = privateKeyToAccount(generatePrivateKey()), now = Date.now();
    const grant = Object.freeze({ grantId: randomUUID(), userId: randomUUID(), wallet: account.address.toLowerCase(), network: NETWORK, asset: TOKEN,
      payTo: '0x1111111111111111111111111111111111111111', merchantOrigin: 'https://synthetic.invalid', perCallAtomic: '5000000', totalAtomic: '10000000', expiresAt: now + 3600000 });
    const orderId = randomUUID();
    const order = Object.freeze({ version: 1, id: orderId, grantId: grant.grantId, salt: '0x' + randomBytes(32).toString('hex'), merchantOrigin: grant.merchantOrigin,
      merchantAccount: 'acct_syntheticnative', resourceURL: grant.merchantOrigin + '/orders/' + orderId, listingId: 'synthetic_native_fixture', board: 'all', quoteId: randomUUID(),
      wallet: grant.wallet, payTo: grant.payTo, network: grant.network, asset: grant.asset, amountAtomic: '5000000', createdAt: now, expiresAt: now + 300000 });
    store = new PaymentStore(join(stateDir, 'payer'), grant);
    traceFd = openSync(tracePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const snapshot = () => {
      if (closed) return lastSnapshot;
      const budget = store.summary(), entry = store.get(orderId);
      return Object.freeze({ ...synthetic, orderId, counters: Object.freeze({ ...counters }), verifications, state: entry?.state ?? 'unreserved',
        amountAtomic: order.amountAtomic, totalAtomic: grant.totalAtomic, allocatedAtomic: budget.allocatedAtomic, remainingAtomic: budget.remainingAtomic,
        traceEvents: events.length, traceTruncated, closed: false });
    };
    const record = (event, code) => {
      if (events.length >= 1024) { traceTruncated = true; return; }
      const current = snapshot();
      const item = { sequence: events.length, event, syntheticOnly: true, nativeAccepted: false, providerPaymentAccepted: false, counters: current.counters, state: current.state,
        allocatedAtomic: current.allocatedAtomic, providerCalls: 0, ...(code ? { code } : {}) };
      events.push(item);
      writeSync(traceFd, JSON.stringify(item) + '\n');
      fsyncSync(traceFd);
    };
    const broker = new TestnetBroker({ store,
      signer: { sign: async (input, scope) => { counters.sign++; record('sign'); return account.signTypedData(paymentTypedData(input, scope)); } },
      merchant: { settle: async (input, payload) => {
        counters.settle++; record('settle');
        await verifyOrderPayload(input, grant, payload);
        if (settlements.has(input.id)) throw new PaymentError('SYNTHETIC_SETTLEMENT_REPLAY');
        const transactionHash = '0x' + randomBytes(32).toString('hex');
        settlements.set(input.id, transactionHash);
        return { transactionHash };
      } },
      verifier: { verify: async (input, transactionHash) => {
        verifications++; record('verify');
        const settled = settlements.get(input.id);
        if (!settled || (transactionHash && transactionHash !== settled)) throw new PaymentError('SYNTHETIC_EVIDENCE_MISSING');
        return { orderId: input.id, nonce: orderNonce(input), amountAtomic: input.amountAtomic, network: NETWORK, transactionHash: settled,
          paymentIntentId: 'pi_synthetic' + input.id.replaceAll('-', '') };
      } },
    });
    const invoke = async (operation, argument) => {
      if (closing) throw new PaymentError('SYNTHETIC_FIXTURE_STOPPING');
      counters[operation]++; record(operation);
      const task = (async () => {
        try {
          const result = await broker[operation](argument);
          record(operation + '_result');
          return { ...result, ...synthetic };
        } catch (error) {
          const code = typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'SYNTHETIC_OPERATION_REJECTED';
          record(operation + '_rejected', code);
          throw error;
        }
      })();
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    };
    const tracedBroker = { pay: input => invoke('pay', input), inspect: id => invoke('inspect', id), reconcile: id => invoke('reconcile', id) };
    const clientToken = randomBytes(32).toString('base64url');
    server = createBrokerHttpServer({ broker: tracedBroker, clientToken, orderProvider: { get: id => id === orderId ? order : null } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    record('ready');
    const close = () => {
      if (closingPromise) return closingPromise;
      closing = true;
      closingPromise = (async () => {
        const stopped = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await Promise.allSettled([...pending]);
        await stopped;
        record('closed'); lastSnapshot = Object.freeze({ ...snapshot(), closed: true });
        store.close(); closeSync(traceFd); traceFd = undefined;
        cleanup(); closed = true;
        lastSnapshot = Object.freeze({ ...lastSnapshot, stateRemoved: true });
        return lastSnapshot;
      })();
      return closingPromise;
    };
    return { brokerOrigin: 'http://127.0.0.1:' + server.address().port, clientToken, orderId, stateDir, tracePath, snapshot, close };
  } catch {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try { store?.close(); } catch {}
    try { if (traceFd !== undefined) closeSync(traceFd); } catch {}
    cleanup();
    throw new PaymentError('SYNTHETIC_FIXTURE_STARTUP_REJECTED');
  }
}

async function main() {
  if (process.env.AGENT_SYNTHETIC_ONLY !== 'true' || process.argv.length !== 2) throw new PaymentError('EXPLICIT_SYNTHETIC_FIXTURE_REQUIRED');
  if (['CDP_API_KEY_ID', 'CDP_API_KEY_NAME', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET', 'STRIPE_SECRET_KEY', 'AGENT_OPERATOR_CONFIG'].some(name => process.env[name])) throw new PaymentError('SYNTHETIC_FIXTURE_CREDENTIALS_FORBIDDEN');
  const fixture = await startSyntheticFixture();
  process.stdout.write(JSON.stringify({ ready: true, syntheticOnly: true, nativeAccepted: false, providerPaymentAccepted: false, providerCalls: 0, fundingAccepted: false,
    brokerOrigin: fixture.brokerOrigin, clientToken: fixture.clientToken, orderId: fixture.orderId, amountAtomic: '5000000', totalAtomic: '10000000', stateDir: fixture.stateDir, tracePath: fixture.tracePath }) + '\n');
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return; stopping = true;
    void fixture.close().catch(() => { process.stderr.write('Synthetic fixture cleanup rejected.\n'); process.exitCode = 1; });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error instanceof PaymentError ? error.code : 'SYNTHETIC_FIXTURE_REJECTED', syntheticOnly: true, nativeAccepted: false }) + '\n');
  process.exitCode = 1;
});
