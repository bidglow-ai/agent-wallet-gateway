import test from 'node:test';
import assert from 'node:assert/strict';
import {CdpDelegatedSigner,createCdpSigner,providerPolicy} from '../src/unattended/cdp-signer.mjs';
import {fixture} from './helpers/unattended.mjs';
import {paymentPayload} from '../src/unattended/intent.mjs';
import {DEFAULT_DURATION_MS,MAX_DELEGATION_MS} from '../src/unattended/duration-policy.mjs';
const {CreatePolicyBodySchema}=await import(new URL('./policies/types.js',import.meta.resolve('@coinbase/cdp-sdk')));
function setup(){
  const f=fixture(),calls=[],policy={id:'policy_test',...providerPolicy(f.grant)};
  const client={endUser:{
    validateAccessToken:async()=>({userId:f.grant.userId}),
    getEndUser:async()=>({userId:f.grant.userId,evmAccountObjects:[{address:f.grant.wallet}]}),
    getDelegationForEndUserAccount:async()=>({expiresAt:new Date(Date.now()+3600000).toISOString()}),
    signEvmTypedData:async args=>{calls.push(args);return{signature:await f.signer.signTypedData(args.typedData)};},
    revokeDelegationForEndUserAccount:async args=>{calls.push(args);},
  },policies:{getPolicyById:async()=>policy,listPolicies:async()=>({policies:[policy]})}};
  return {...f,client,calls,policy,adapter:new CdpDelegatedSigner({client,policyId:policy.id})};
}
test('proposed project policy passes pinned official SDK schema, without applying it',()=>{
  const {grant}=fixture();const p=providerPolicy(grant);assert.ok(CreatePolicyBodySchema.safeParse(p).success);
  assert.equal(p.rules.filter(x=>x.action==='accept').length,1);
  assert.equal(p.rules.find(x=>x.action==='accept').operation,'signEndUserEvmTypedData');
});
test('mock official delegate adapter signs only reconstructed bounded testnet data',async()=>{
  const f=setup();const signature=await f.adapter.sign(f.order,f.grant);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].address,f.grant.wallet);
  assert.equal(f.calls[0].userId,f.grant.userId);assert.equal(f.calls[0].idempotencyKey,f.order.id);
  assert.equal(f.calls[0].typedData.domain.chainId,84532);
  assert.equal(f.calls[0].typedData.message.value,'5000000');
  await paymentPayload(f.order,f.grant,signature);
});
test('30/90day provider delegations pass local guards while every signed order remains short-lived',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  for(const durationMs of [DEFAULT_DURATION_MS,MAX_DELEGATION_MS]){
    const f=setup();f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt:new Date(now+durationMs).toISOString()});
    const subject=await f.adapter.verifyEnrollment({accessToken:'synthetic-test-token',wallet:f.grant.wallet});assert.equal(subject.delegationExpiresAt,now+durationMs);
    await f.adapter.sign(f.order,f.grant,now);assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].typedData.message.validBefore,String(Math.floor(f.order.expiresAt/1000)));
    assert.ok(Number(f.calls[0].typedData.message.validBefore)*1000<=now+300000);
  }
  for(const expiresAt of [new Date(now+MAX_DELEGATION_MS+1).toISOString(),new Date(now).toISOString(),'Infinity','not-a-date']){
    const f=setup();f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt});
    await assert.rejects(f.adapter.verifyEnrollment({accessToken:'synthetic-test-token',wallet:f.grant.wallet}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
    await assert.rejects(f.adapter.sign(f.order,f.grant,now),{code:'DELEGATION_EXPIRED_OR_UNBOUNDED'});assert.equal(f.calls.length,0);
  }
});
test('missing, expired, overly long or wrong-account delegation never calls signer',async()=>{
  for(const alter of [f=>{f.client.endUser.getDelegationForEndUserAccount=async()=>null;},
    f=>{f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt:new Date(Date.now()-1).toISOString()});},
    f=>{f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt:new Date(Date.now()+MAX_DELEGATION_MS+3600000).toISOString()});},
    f=>{f.client.endUser.getEndUser=async()=>({userId:'other',evmAccountObjects:[{address:f.grant.wallet}]});},
    f=>{f.client.endUser.getEndUser=async()=>({userId:f.grant.userId,evmAccountObjects:[{address:f.grant.wallet,exportedAt:new Date().toISOString()}]});}]){
    const f=setup();alter(f);await assert.rejects(()=>f.adapter.sign(f.order,f.grant));assert.equal(f.calls.length,0);
  }
});
test('weakened, missing or different project policy rejects before signing',async()=>{
  for(const alter of [f=>{f.policy.rules=[];},f=>{f.policy.scope='account';},f=>{f.client.policies.listPolicies=async()=>({policies:[]});},
    f=>{f.client.policies.listPolicies=async()=>({policies:[f.policy],nextPageToken:'unverified'});},
    f=>{f.client.policies.getPolicyById=async()=>{throw new Error('secret-example');};}]){
    const f=setup();alter(f);await assert.rejects(()=>f.adapter.sign(f.order,f.grant),e=>!e.message.includes('secret-example'));assert.equal(f.calls.length,0);
  }
});
test('invalid order/mainnet rejected before any provider call; missing configuration fails closed',async()=>{
  const f=setup();f.client.endUser.getEndUser=()=>assert.fail('provider must not be called');
  await assert.rejects(()=>f.adapter.sign({...f.order,network:'eip155:8453'},f.grant));
  assert.throws(()=>createCdpSigner({}),/PROVIDER_CONFIGURATION_REQUIRED/);
});
test('enrollment derives subject from provider token and verifies account/delegation independently',async()=>{
  const f=setup(),result=await f.adapter.verifyEnrollment({accessToken:'synthetic-test-token-not-a-credential',wallet:f.grant.wallet});
  assert.equal(result.userId,f.grant.userId);assert.equal(result.wallet,f.grant.wallet);assert.ok(!JSON.stringify(result).includes('synthetic-test-token'));
  assert.equal(f.calls.length,0);
  await assert.rejects(()=>f.adapter.verifyEnrollment({accessToken:'synthetic-test-token',wallet:f.grant.payTo}));
  f.client.endUser.validateAccessToken=async()=>{throw new Error('sensitive-example');};
  await assert.rejects(()=>f.adapter.verifyEnrollment({accessToken:'synthetic-test-token',wallet:f.grant.wallet}),e=>e.code==='AUTHENTICATED_ENROLLMENT_UNCONFIRMED'&&!e.message.includes('sensitive-example'));
});
test('smaller grant produces equally restricted provider per-call cap',()=>{
  const {grant}=fixture(),p=providerPolicy({...grant,perCallAtomic:'10000'});
  const typed=p.rules.find(r=>r.operation==='signEndUserEvmTypedData').criteria.find(c=>c.type==='evmTypedDataField');
  assert.equal(typed.conditions.find(c=>c.path==='value'&&c.operator==='<=').value,'10000');
});
