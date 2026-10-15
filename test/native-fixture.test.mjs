import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startSyntheticFixture } from '../scripts/native-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/native-fixture.mjs', import.meta.url));
function launch(env) {
  const child = spawn(process.execPath, [script], { env: { NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  return { child, errors: () => errors };
}
async function request(fixture, operation, token = fixture.clientToken) {
  const response = await fetch(fixture.brokerOrigin + '/v1/orders/' + fixture.orderId + (operation === 'inspect' ? '' : '/' + operation), {
    method: operation === 'inspect' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(operation === 'inspect' ? {} : { 'Content-Type': 'application/json' }) },
    ...(operation === 'inspect' ? {} : { body: '{}' }), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

test('direct CLI refuses implicit startup or inherited developer credentials', async () => {
  for (const env of [{}, { AGENT_SYNTHETIC_ONLY: 'false' }, { AGENT_SYNTHETIC_ONLY: 'true', CDP_WALLET_SECRET: 'synthetic-forbidden-value' }]) {
    const { child, errors } = launch(env); let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1); assert.equal(output, '');
    assert.match(errors(), /EXPLICIT_SYNTHETIC_FIXTURE_REQUIRED|SYNTHETIC_FIXTURE_CREDENTIALS_FORBIDDEN/);
    assert.equal(errors().includes('synthetic-forbidden-value'), false);
  }
});

test('HTTP fixture confirms one synthetic payment, traces actual calls and rejects replay', async t => {
  const fixture = await startSyntheticFixture();
  t.after(() => fixture.close());
  assert.equal(lstatSync(fixture.stateDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(fixture.tracePath).mode & 0o777, 0o600);
  assert.equal((await request(fixture, 'pay', 'x'.repeat(43))).status, 401);
  assert.equal((await request({ ...fixture, orderId: randomUUID() }, 'pay')).status, 409);
  const changedScope = await fetch(fixture.brokerOrigin + '/v1/orders/' + fixture.orderId + '/pay', {
    method: 'POST', headers: { Authorization: 'Bearer ' + fixture.clientToken, 'Content-Type': 'application/json' }, body: '{"amountAtomic":"10000"}',
  });
  assert.equal(changedScope.status, 409);
  assert.equal((await request(fixture, 'inspect')).body.found, false);
  const paid = await request(fixture, 'pay');
  assert.equal(paid.status, 200); assert.equal(paid.body.state, 'confirmed');
  assert.equal(paid.body.syntheticOnly, true); assert.equal(paid.body.nativeAccepted, false); assert.equal(paid.body.providerPaymentAccepted, false);
  const inspected = await request(fixture, 'inspect');
  assert.equal(inspected.body.state, 'confirmed'); assert.equal(inspected.body.providerPaymentAccepted, false);
  const repeated = await request(fixture, 'pay');
  assert.equal(repeated.status, 409); assert.equal(repeated.body.error, 'ORDER_ALREADY_EXISTS');
  const reconciled = await request(fixture, 'reconcile');
  assert.equal(reconciled.body.state, 'confirmed'); assert.equal(reconciled.body.providerPaymentAccepted, false);
  const snapshot = fixture.snapshot();
  assert.deepEqual(snapshot.counters, { pay: 2, inspect: 2, reconcile: 1, sign: 1, settle: 1 });
  assert.equal(snapshot.verifications, 1); assert.equal(snapshot.providerCalls, 0);
  assert.equal(snapshot.providerPaymentAccepted, false);
  assert.equal(snapshot.allocatedAtomic, '5000000'); assert.equal(snapshot.remainingAtomic, '5000000');
  const raw = readFileSync(fixture.tracePath, 'utf8'), trace = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(trace.some(item => item.event === 'pay_rejected' && item.code === 'ORDER_ALREADY_EXISTS'));
  assert.ok(trace.some(item => item.event === 'sign' && item.allocatedAtomic === '5000000'));
  assert.equal(raw.includes(fixture.clientToken), false);
  for (const item of trace) {
    assert.equal(item.syntheticOnly, true); assert.equal(item.nativeAccepted, false); assert.equal(item.providerCalls, 0);
    assert.equal('signature' in item, false); assert.equal('privateKey' in item, false);
  }
  const final = await fixture.close();
  assert.equal(final.stateRemoved, true); assert.equal(existsSync(fixture.stateDir), false);
  assert.deepEqual(fixture.snapshot().counters, snapshot.counters);
});

test('explicit CLI reports one temporary capability and SIGTERM removes only its own state', async t => {
  const { child, errors } = launch({ AGENT_SYNTHETIC_ONLY: 'true' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, 'line'),
    once(child, 'exit').then(() => { throw new Error('Synthetic CLI exited before readiness'); }),
  ]);
  const fixture = JSON.parse(line);
  assert.equal(fixture.ready, true); assert.equal(fixture.syntheticOnly, true); assert.equal(fixture.nativeAccepted, false); assert.equal(fixture.providerPaymentAccepted, false);
  assert.match(fixture.clientToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(fixture.brokerOrigin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.equal(fixture.amountAtomic, '5000000'); assert.equal(fixture.totalAtomic, '10000000');
  assert.equal((await request(fixture, 'pay')).body.state, 'confirmed');
  const trace = readFileSync(fixture.tracePath, 'utf8');
  assert.ok(trace.includes('"sign":1')); assert.ok(trace.includes('"settle":1'));
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null); assert.equal(code, 0); assert.equal(errors(), '');
  assert.equal(existsSync(fixture.stateDir), false);
  lines.close();
});
