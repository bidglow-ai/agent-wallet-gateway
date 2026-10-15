import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {NETWORK,TOKEN,validateGrant,validateOrder,orderNonce,paymentTypedData,paymentPayload,verifyOrderPayload} from '../src/unattended/intent.mjs';

export function fixture(){
  const signer=privateKeyToAccount(generatePrivateKey()),now=Date.now();
  const grant={grantId:randomUUID(),userId:randomUUID(),wallet:signer.address.toLowerCase(),network:NETWORK,asset:TOKEN,
    payTo:'0x1111111111111111111111111111111111111111',merchantOrigin:'https://merchant.example',perCallAtomic:'5000000',totalAtomic:'10000000',expiresAt:now+600000};
  const id=randomUUID();
  const order={version:1,id,grantId:grant.grantId,salt:'0x'+randomBytes(32).toString('hex'),merchantOrigin:grant.merchantOrigin,
    merchantAccount:'acct_isolatedtest',resourceURL:grant.merchantOrigin+'/orders/'+id,listingId:'isolated_example',board:'all',quoteId:randomUUID(),
    wallet:grant.wallet,payTo:grant.payTo,network:NETWORK,asset:TOKEN,amountAtomic:'5000000',createdAt:now,expiresAt:now+240000};
  return {signer,now,grant,order};
}
test('testnet contract rejects mainnet, unsupported fields and noncanonical amounts',()=>{
  const {order,grant}=fixture();
  assert.throws(()=>validateGrant({...grant,network:'eip155:8453'}),/TESTNET_USDC_ONLY/);
  assert.throws(()=>validateGrant({...grant,asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}));
  for(const amountAtomic of ['5','05000000','5e6',5000000,'5000001','0','-1']){
    assert.throws(()=>validateOrder({...order,amountAtomic},grant));
  }
  assert.throws(()=>validateOrder({...order,additional:true},grant),/INVALID_FIELDS/);
  assert.throws(()=>validateOrder({...order,get asset(){throw new Error('getter must not run');}},grant),/INVALID_FIELDS/);
});
test('payer, merchant, board, scope and expiry are fixed before signing',()=>{
  const {order,grant,now}=fixture();
  for(const update of [{wallet:grant.payTo},{payTo:grant.wallet},{merchantOrigin:'https://evil.example'},{resourceURL:order.resourceURL+'?order=other'},
    {board:'invalid'},{createdAt:now+1},{expiresAt:now},{expiresAt:now+300001},{amountAtomic:'5000001'}])assert.throws(()=>paymentTypedData({...order,...update},grant,now));
  assert.ok(Object.isFrozen(validateOrder(order,grant,now)));
  assert.ok(Object.isFrozen(paymentTypedData(order,grant,now).message));
});
test('real EIP712 recovery succeeds and binds first-use order scope',async()=>{
  const {order,grant,signer,now}=fixture();
  const signature=await signer.signTypedData(paymentTypedData(order,grant,now));
  const payload=await paymentPayload(order,grant,signature,now);
  assert.deepEqual(await verifyOrderPayload(order,grant,payload,now),payload);
  for(const update of [{listingId:'retargeted'},{board:'today'},{quoteId:randomUUID()},{merchantAccount:'acct_differentmerchant'},{salt:'0x'+'ab'.repeat(32)}]){
    const changed={...order,...update};assert.notEqual(orderNonce(changed),orderNonce(order));
    await assert.rejects(()=>verifyOrderPayload(changed,grant,{...payload,resource:{...payload.resource,url:changed.resourceURL}},now),/SIGNER_MISMATCH|PAYMENT_ORDER_BINDING_MISMATCH/);
  }
  const changedId=randomUUID(),changed={...order,id:changedId,resourceURL:grant.merchantOrigin+'/orders/'+changedId};
  await assert.rejects(()=>verifyOrderPayload(changed,grant,{...payload,resource:{...payload.resource,url:changed.resourceURL}},now));
});
test('wrong signature, nonce, token, amount and expired payload fail closed',async()=>{
  const {order,grant,signer,now}=fixture();
  const payload=await paymentPayload(order,grant,await signer.signTypedData(paymentTypedData(order,grant,now)),now);
  for(const value of [{...payload,accepted:{...payload.accepted,amount:'1'}},{...payload,accepted:{...payload.accepted,network:'eip155:8453'}},
    {...payload,payload:{...payload.payload,authorization:{...payload.payload.authorization,nonce:'0x'+'aa'.repeat(32)}}},
    {...payload,payload:{...payload.payload,extra:'forbidden'}}])await assert.rejects(()=>verifyOrderPayload(order,grant,value,now));
  await assert.rejects(()=>verifyOrderPayload(order,grant,payload,order.expiresAt));
  const other=privateKeyToAccount(generatePrivateKey());
  const wrongSignature=await other.signTypedData(paymentTypedData(order,grant,now));
  await assert.rejects(()=>paymentPayload(order,grant,wrongSignature,now));
});
