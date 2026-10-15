import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,anotherOrder} from './helpers/unattended.mjs';
import {PaymentStore} from '../src/unattended/store.mjs';
import {TestnetBroker} from '../src/unattended/broker.mjs';
import {paymentTypedData,orderNonce,verifyOrderPayload} from '../src/unattended/intent.mjs';
function setup(t){
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'broker-isolated-')),store=new PaymentStore(dir,f.grant),calls={sign:0,settle:0,verify:0};
  t.after(()=>{try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});});
  const signer={sign:async order=>{calls.sign++;return f.signer.signTypedData(paymentTypedData(order,f.grant));},revoke:async()=>{}},
    merchant={settle:async(order,payload)=>{await verifyOrderPayload(order,f.grant,payload);calls.settle++;return {transactionHash:'0x'+(order.id.replaceAll('-','').padEnd(64,'0'))};}},
    verifier={verify:async(order,hash)=>{calls.verify++;return {orderId:order.id,nonce:orderNonce(order),amountAtomic:order.amountAtomic,network:order.network,transactionHash:hash||'0x'+'ab'.repeat(32),paymentIntentId:'pi_'+order.id.replaceAll('-','')};}};
  return {...f,dir,store,calls,signer,merchant,verifier,broker:new TestnetBroker({store,signer,merchant,verifier})};
}
test('one unattended fixture payment confirms once without repeated owner prompts',async t=>{
  const f=setup(t);assert.equal((await f.broker.pay(f.order)).state,'confirmed');
  assert.deepEqual(f.calls,{sign:1,settle:1,verify:1});
  await assert.rejects(()=>f.broker.pay(f.order),/ORDER_ALREADY_EXISTS/);
  assert.equal((await f.broker.reconcile(f.order.id)).state,'confirmed');assert.equal(f.calls.settle,1);
});
test('parallel clients and new processes share one durable grant; changed operation cannot reset budget',async t=>{
  const f=setup(t),other=new PaymentStore(f.dir,f.grant);t.after(()=>other.close());
  const broker2=new TestnetBroker({store:other,signer:f.signer,merchant:f.merchant,verifier:f.verifier});
  const out=await Promise.allSettled([f.broker.pay(f.order),broker2.pay(f.order)]);
  assert.equal(out.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.settle,1);
  await broker2.pay(anotherOrder(f.order));
  await assert.rejects(()=>f.broker.pay(anotherOrder(f.order)),/TOTAL_BUDGET_EXCEEDED/);
  assert.equal(f.calls.sign,2);assert.equal(f.store.summary().allocatedAtomic,'10000000');
});
test('lost settlement response stays reserved after reopen, no signature or settlement retry',async t=>{
  const f=setup(t);f.merchant.settle=async()=>{f.calls.settle++;throw new Error('sensitive-example');};
  const result=await f.broker.pay(f.order);assert.equal(result.state,'unknown');assert.ok(!JSON.stringify(result).includes('sensitive-example'));
  const reopened=new PaymentStore(f.dir,f.grant);t.after(()=>reopened.close());
  const b=new TestnetBroker({store:reopened,signer:f.signer,merchant:f.merchant,verifier:f.verifier});
  await assert.rejects(()=>b.pay(f.order),/ORDER_ALREADY_EXISTS/);
  assert.equal((await b.reconcile(f.order.id)).state,'confirmed');assert.equal(f.calls.sign,1);assert.equal(f.calls.settle,1);
});
test('Stripe pending resumes same settled transaction, never charges again',async t=>{
  const f=setup(t),verify=f.verifier.verify;let first=true;
  f.verifier.verify=async(...args)=>{if(first){first=false;throw new Error('processing');}return verify(...args);};
  assert.equal((await f.broker.pay(f.order)).state,'settled');
  assert.equal((await f.broker.reconcile(f.order.id)).state,'confirmed');assert.equal(f.calls.settle,1);assert.equal(f.calls.sign,1);
});
test('revocation during signing prevents settlement and remains durable on provider failure',async t=>{
  const f=setup(t),sign=f.signer.sign;
  f.signer.sign=async order=>{const s=await sign(order);f.store.revoke();return s;};
  assert.equal((await f.broker.pay(f.order)).state,'unknown');assert.equal(f.calls.settle,0);
  f.signer.revoke=async()=>{throw new Error('provider offline');};
  await assert.rejects(()=>f.broker.revoke());assert.equal(f.store.summary().revoked,true);
});
test('wrong independent evidence cannot confirm or release any reservation',async t=>{
  const f=setup(t),verify=f.verifier.verify;
  f.verifier.verify=async(...args)=>({...await verify(...args),nonce:'0x'+'00'.repeat(32)});
  assert.equal((await f.broker.pay(f.order)).state,'settled');assert.equal(f.store.summary().confirmedAtomic,'0');
  assert.equal(f.store.summary().reservedAtomic,'5000000');
});
test('process death in reserved, signed or settling recovers only from independent receipt, never repays',async t=>{
  for(const phase of ['reserved','signed','settling']){
    const f=setup(t);f.store.reserve(f.order);
    if(phase!=='reserved')f.store.transition(f.order.id,'reserved','signed');
    if(phase==='settling')f.store.transition(f.order.id,'signed','settling');
    const reopened=new PaymentStore(f.dir,f.grant);t.after(()=>reopened.close());
    const b=new TestnetBroker({store:reopened,signer:{sign:()=>assert.fail('must not sign')},merchant:{settle:()=>assert.fail('must not settle')},verifier:f.verifier});
    assert.equal((await b.reconcile(f.order.id)).state,'confirmed');
    assert.equal(f.calls.sign,0);assert.equal(f.calls.settle,0);
  }
});
