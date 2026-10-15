import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BudgetLedger} from '../src/ledger.mjs';
import {WalletGateway} from '../src/gateway.mjs';
const address = '0x1111111111111111111111111111111111111111';
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-gateway-test-'));
  const policy = {enabled:true, expectedWallet:address, totalAtomic:'10000000', perCallAtomic:'5000000', expiresAt:Date.now()+60000, allowedOrigins:['https://merchant.example'], allowedPaths:['/pay']};
  const {enabled, expectedWallet, ...budgetPolicy} = policy;
  const ledger = new BudgetLedger(dir, budgetPolicy);
  const calls = [];
  const provider = {status:async()=>({authenticated:true}), address:async()=>address,
    pay:async r=>{calls.push(r); return {paymentMade:true, amountPaid:5000000};}, ...overrides};
  t.after(()=>{ledger.close(); rmSync(dir,{recursive:true,force:true});});
  return {gateway:new WalletGateway(provider,ledger,policy), ledger,calls,policy};
}
const input = () => ({id:randomUUID(),url:'https://merchant.example/pay',method:'POST',body:{order:'frozen-order-1'},amountAtomic:'5000000'});
test('no configured grant means no payment and no provider call',async()=>{
  const gateway=new WalletGateway({pay:()=>assert.fail('must not pay')});
  await assert.rejects(()=>gateway.pay(input()),/PAYMENTS_DISABLED/);
});
test('wallet address rotation rejects before reservation and payment',async t=>{
  const {gateway,ledger,calls}=setup(t,{address:async()=> '0x2222222222222222222222222222222222222222'});
  await assert.rejects(()=>gateway.pay(input()),/WALLET_CHANGED/);
  assert.equal(ledger.summary().payments,0); assert.equal(calls.length,0);
});
test('unknown outcome retains full reservation and identical or new-id replay cannot pay',async t=>{
  let calls=0;
  const {gateway,ledger}=setup(t,{pay:async()=>{calls++; throw new Error('private-key=never-echo-this');}});
  const request=input(); const result=await gateway.pay(request);
  assert.equal(result.outcome,'unknown'); assert.equal(result.automaticRetryAllowed,false);
  assert.equal(ledger.summary().reservedAtomic,'5000000');
  await assert.rejects(()=>gateway.pay(request));
  await assert.rejects(()=>gateway.pay({...request,id:randomUUID()}));
  assert.equal(calls,1); assert.equal(JSON.stringify(result).includes('private-key'),false);
});
test('provider success consumes full ceiling and is never merchant/chain acceptance',async t=>{
  const {gateway,ledger}=setup(t,{pay:async()=>({paymentMade:true,amountPaid:1000000,data:{secret:'do not expose'}})});
  const receipt=await gateway.pay(input());
  assert.equal(receipt.budgetConsumedAtomic,'5000000'); assert.equal(ledger.summary().spentAtomic,'5000000');
  assert.equal(receipt.chainSettlementIndependentlyVerified,false); assert.equal(receipt.merchantFulfillmentVerified,false);
  assert.equal(JSON.stringify(receipt).includes('secret'),false);
});
test('unverified amount, free response, and oversized payment stay reserved',async t=>{
  for (const result of [{paymentMade:false},{paymentMade:true,amountPaid:'5000000'},{paymentMade:true,amountPaid:6000000}]) {
    const {gateway,ledger}=setup(t,{pay:async()=>result});
    assert.equal((await gateway.pay(input())).outcome,'unknown');
    assert.equal(ledger.summary().reservedAtomic,'5000000');
  }
});
test('parallel calls for one operation cannot invoke payer twice',async t=>{
  const {gateway,calls}=setup(t); const request=input();
  const results=await Promise.allSettled([gateway.pay(request),gateway.pay(request)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(calls.length,1);
});
