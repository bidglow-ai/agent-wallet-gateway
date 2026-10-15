import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './helpers/unattended.mjs';
import {PaymentStore} from '../src/unattended/store.mjs';
import {createTestnetMerchant} from '../src/unattended/merchant.mjs';
import {TestnetBroker} from '../src/unattended/broker.mjs';
import {NETWORK,paymentTypedData,orderNonce,verifyOrderPayload} from '../src/unattended/intent.mjs';
test('actual broker + separate merchant ledgers + official resource server compose without double settlement',async t=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'broker-merchant-'));
  const payerStore=new PaymentStore(join(dir,'payer'),f.grant),merchantStore=new PaymentStore(join(dir,'merchant'),f.grant);let settles=0;
  t.after(()=>{payerStore.close();merchantStore.close();rmSync(dir,{recursive:true,force:true});});
  const facilitator={getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:NETWORK}],extensions:[],signers:{}}),
    verify:async payload=>{await verifyOrderPayload(f.order,f.grant,payload);return{isValid:true,payer:f.grant.wallet};},
    settle:async()=>{settles++;return {success:true,payer:f.grant.wallet,network:NETWORK,transaction:'0x'+'aa'.repeat(32)};}};
  const merchant=await createTestnetMerchant({store:merchantStore,facilitator});
  const signer={sign:order=>f.signer.signTypedData(paymentTypedData(order,f.grant))};
  const verifier={preflight:async order=>({merchantVerified:true,testnetOnly:true,fundingAccepted:false,orderDigest:orderNonce(order)}),
    verify:async order=>({orderId:order.id,nonce:orderNonce(order),amountAtomic:order.amountAtomic,network:NETWORK,transactionHash:'0x'+'aa'.repeat(32),paymentIntentId:'pi_isolated'})};
  const broker=new TestnetBroker({store:payerStore,signer,merchant,verifier});
  assert.equal((await broker.pay(f.order)).state,'confirmed');assert.equal(settles,1);
  assert.equal(payerStore.get(f.order.id).state,'confirmed');assert.equal(merchantStore.get(f.order.id).state,'settled');
  await assert.rejects(()=>broker.pay(f.order),/ORDER_ALREADY_EXISTS/);assert.equal(settles,1);
});
