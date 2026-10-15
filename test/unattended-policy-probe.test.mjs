import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runExpiredPolicyProbe} from '../src/unattended/policy-probe.mjs';
import {policyProbeArguments} from '../scripts/provider-policy-probe.mjs';
import {providerPolicy} from '../src/unattended/cdp-signer.mjs';
import {fixture} from './helpers/unattended.mjs';
import {DEFAULT_DURATION_MS,MAX_DELEGATION_MS} from '../src/unattended/duration-policy.mjs';

// The public SDK root does not export APIError. This explicit fixture mirrors
// its inspected Error subclass/own-data contract; it is NOT a real API response.
class ProviderAPIErrorFixture extends Error {
  constructor({name='APIError',statusCode=403,errorType='policy_violation'}={}){
    super('sensitive-provider-detail');this.name=name;this.statusCode=statusCode;this.errorType=errorType;
  }
}
function setup(){
  const f=fixture(),evidence={projectId:randomUUID(),userId:f.grant.userId,wallet:f.grant.wallet,payTo:f.grant.payTo,
    merchantAccount:'acct_isolatedtest',testnetOnly:true,fundingAccepted:false};
  const installedPolicy={id:'policy_test',scope:'project',rules:providerPolicy(f.grant).rules};
  const calls=[],reads=[];
  const client={endUser:{
    getEndUser:async args=>{reads.push(['user',args]);return {userId:evidence.userId,evmAccountObjects:[{address:evidence.wallet}]};},
    getDelegationForEndUserAccount:async args=>{reads.push(['delegation',args]);return {expiresAt:new Date(Date.now()+3600000).toISOString()};},
    signEvmTypedData:async args=>{calls.push(args);if(calls.length===1)return {signature:await f.signer.signTypedData(args.typedData)};
      throw new ProviderAPIErrorFixture();},
  },policies:{getPolicyById:async args=>{reads.push(['policy',args]);return structuredClone(installedPolicy);},
    listPolicies:async args=>{reads.push(['list',args]);return {policies:[structuredClone(installedPolicy)]};}}};
  return {...f,evidence,installedPolicy,calls,reads,client};
}
test('fixed finite mocked provider suite recovers expired control and classifies all four policy negatives',async()=>{
  const f=setup(),result=await runExpiredPolicyProbe(f);
  assert.equal(result.status,'PASSED');assert.equal(result.positiveControlVerified,true);
  assert.equal(result.negativeTestsAttempted,4);assert.equal(result.negativeTestsRejected,4);
  assert.equal(f.calls.length,5);assert.equal(f.reads.length,20);
  const nonces=new Set(),ids=new Set();
  for(const call of f.calls){
    assert.equal(call.address,f.evidence.wallet);assert.equal(call.userId,f.evidence.userId);
    assert.equal(call.typedData.domain.chainId,84532);assert.equal(call.typedData.message.validAfter,'0');assert.equal(call.typedData.message.validBefore,'1');
    nonces.add(call.typedData.message.nonce);ids.add(call.idempotencyKey);
  }
  assert.equal(nonces.size,5);assert.equal(ids.size,5);
  assert.notEqual(f.calls[1].typedData.message.to,f.evidence.payTo);
  assert.equal(f.calls[2].typedData.message.value,'5000001');
  assert.notEqual(f.calls[3].typedData.domain.verifyingContract,f.calls[0].typedData.domain.verifyingContract);
  assert.equal(f.calls[4].typedData.primaryType,'ExpiredProbeAuthorization');
  assert.deepEqual(Object.keys(f.calls[4].typedData.types),['ExpiredProbeAuthorization']);
});
test('local probe permits30/90day delegations but produces only forever-expired controls',async()=>{
  const now=Date.now();
  for(const durationMs of [DEFAULT_DURATION_MS,MAX_DELEGATION_MS]){
    const f=setup();f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt:new Date(now+durationMs).toISOString()});
    assert.equal((await runExpiredPolicyProbe({...f,clock:()=>now})).status,'PASSED');
    assert.equal(f.calls.length,5);assert.ok(f.calls.every(call=>call.typedData.message.validBefore==='1'));
  }
  for(const expiresAt of [new Date(now+MAX_DELEGATION_MS+1).toISOString(),'Infinity','not-a-date']){
    const f=setup();f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt});
    assert.equal((await runExpiredPolicyProbe({...f,clock:()=>now})).category,'PRECONDITIONS_UNVERIFIED');assert.equal(f.calls.length,0);
  }
});
test('positive provider refusal, expired-control refusal or wrong recovery is inconclusive, not policy proof',async()=>{
  for(const behavior of [async()=>{throw Object.assign(new Error('secret'),{errorType:'policy_violation'});},
    async()=>{throw Object.assign(new Error('secret'),{errorType:'invalid_request'});},
    async()=>({signature:'private-value'}),async args=>({signature:await fixture().signer.signTypedData(args.typedData)})]){
    const f=setup();f.client.endUser.signEvmTypedData=async args=>{f.calls.push(args);return behavior(args);};
    const result=await runExpiredPolicyProbe(f);assert.equal(result.status,'INCONCLUSIVE');assert.equal(result.negativeTestsAttempted,0);assert.equal(f.calls.length,1);
  }
});
test('missing, expired, overlong, exported or wrong-account delegation gates before all signing',async()=>{
  for(const alter of [f=>{f.client.endUser.getDelegationForEndUserAccount=async()=>null;},
    f=>{f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt:new Date(Date.now()-1).toISOString()});},
    f=>{f.client.endUser.getDelegationForEndUserAccount=async()=>({expiresAt:new Date(Date.now()+MAX_DELEGATION_MS+3600000).toISOString()});},
    f=>{f.client.endUser.getEndUser=async()=>({userId:f.evidence.userId,evmAccountObjects:[{address:f.evidence.wallet,exportedAt:'2026-01-01'}]});},
    f=>{f.client.endUser.getEndUser=async()=>({userId:randomUUID(),evmAccountObjects:[{address:f.evidence.wallet}]});},
    f=>{f.client.endUser.getEndUser=async()=>({userId:f.evidence.userId,evmAccountObjects:[{address:f.evidence.wallet},{address:f.evidence.payTo}]});}]){
    const f=setup();alter(f);const result=await runExpiredPolicyProbe(f);assert.equal(result.category,'PRECONDITIONS_UNVERIFIED');assert.equal(f.calls.length,0);
  }
});
test('wrong, weakened, duplicated or paginated policy never permits a probe signature',async()=>{
  for(const alter of [f=>{f.installedPolicy.rules=[];},
    f=>{f.client.policies.getPolicyById=async()=>({...f.installedPolicy,rules:[]});},
    f=>{f.client.policies.listPolicies=async()=>({policies:[f.installedPolicy,f.installedPolicy]});},
    f=>{f.client.policies.listPolicies=async()=>({policies:[f.installedPolicy],nextPageToken:'sensitive-token'});},
    f=>{f.client.policies.listPolicies=async()=>({policies:[{...f.installedPolicy,scope:'account'}]});},
    f=>{f.evidence.testnetOnly=false;},f=>{f.evidence.fundingAccepted=true;},f=>{f.evidence.typedData={};}]){
    const f=setup();alter(f);assert.equal((await runExpiredPolicyProbe(f)).status,'INCONCLUSIVE');assert.equal(f.calls.length,0);
  }
});
test('preconditions are rechecked between signatures and revocation stops the finite sequence',async()=>{
  const f=setup();let reads=0;
  f.client.endUser.getDelegationForEndUserAccount=async()=>++reads===1?{expiresAt:new Date(Date.now()+3600000).toISOString()}:null;
  const result=await runExpiredPolicyProbe(f);assert.equal(result.category,'PRECONDITIONS_UNVERIFIED');assert.equal(f.calls.length,1);assert.equal(result.negativeTestsAttempted,0);
});
test('only APIError-shaped native errors qualify; plain, inherited, nested and unrelated failures are inconclusive',async()=>{
  const inherited=Object.create(ProviderAPIErrorFixture.prototype);Object.assign(inherited,{name:'APIError',statusCode:403,errorType:'policy_violation'});
  for(const error of [new ProviderAPIErrorFixture({errorType:'unauthorized'}),new ProviderAPIErrorFixture({errorType:'delegation_not_found'}),
    new ProviderAPIErrorFixture({errorType:'invalid_request'}),new ProviderAPIErrorFixture({name:'UnknownApiError'}),
    Object.assign(new Error('secret'),{errorType:'policy_violation'}),{name:'APIError',statusCode:403,errorType:'policy_violation'},
    {cause:{name:'APIError',statusCode:403,errorType:'policy_violation'}},inherited,
    ...[0,200,401,402,404,408,429,500,'403',NaN].map(statusCode=>new ProviderAPIErrorFixture({statusCode}))]){
    const f=setup(),original=f.client.endUser.signEvmTypedData;
    f.client.endUser.signEvmTypedData=async args=>{if(!f.calls.length)return original(args);f.calls.push(args);throw error;};
    const result=await runExpiredPolicyProbe(f);assert.equal(result.status,'INCONCLUSIVE');assert.equal(result.negativeTestsRejected,0);assert.equal(f.calls.length,2);
    for(const secret of ['sensitive-provider-detail','secret',f.evidence.userId,f.evidence.wallet,'statusCode','errorType'])assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test('APIError classifier does not invoke getters or trust fields moved into the prototype',async()=>{
  for(const field of ['name','statusCode','errorType'])for(const mode of ['getter','inherited']){
    let getters=0;const error=new ProviderAPIErrorFixture(),value=error[field];delete error[field];
    if(mode==='getter')Object.defineProperty(error,field,{get(){getters++;throw new Error('sensitive-getter');}});
    else Object.setPrototypeOf(error,Object.assign(Object.create(ProviderAPIErrorFixture.prototype),{[field]:value}));
    const f=setup(),original=f.client.endUser.signEvmTypedData;
    f.client.endUser.signEvmTypedData=async args=>{if(!f.calls.length)return original(args);f.calls.push(args);throw error;};
    const result=await runExpiredPolicyProbe(f);assert.equal(result.status,'INCONCLUSIVE');assert.equal(result.negativeTestsRejected,0);assert.equal(getters,0);
    assert.ok(!JSON.stringify(result).includes('sensitive-getter'));
  }
});
test('unexpected negative signature is failed, never returned, persisted or logged',async()=>{
  const f=setup();f.client.endUser.signEvmTypedData=async args=>{f.calls.push(args);return {signature:await f.signer.signTypedData(args.typedData)};};
  const result=await runExpiredPolicyProbe(f);assert.equal(result.status,'FAILED');assert.equal(result.category,'NEGATIVE_SIGNING_NOT_REJECTED');assert.equal(f.calls.length,2);
  const output=JSON.stringify(result);for(const secret of [f.evidence.wallet,f.evidence.userId,f.evidence.payTo,'signature','sensitive-provider-detail','nonce'])assert.ok(!output.includes(secret));
  assert.equal(result.fundingAccepted,false);assert.equal(result.paymentInitiated,false);
});
test('CLI accepts only three explicit protected file paths and the expired-testnet opt-in',()=>{
  const args=['--run-expired-testnet-policy-probe','--cdp-file','/private/cdp.json','--setup-evidence-file','/private/setup.json','--installed-policy-file','/private/policy.json'];
  assert.deepEqual(policyProbeArguments(args),{cdpFile:'/private/cdp.json',evidenceFile:'/private/setup.json',policyFile:'/private/policy.json'});
  for(const invalid of [[],args.slice(1),[...args,'--network','mainnet'],args.map(v=>v==='/private/cdp.json'?'sk_test_secret':v),
    args.map(v=>v==='--installed-policy-file'?'--cdp-file':v),args.map(v=>v==='--cdp-file'?'--typed-data':v)])assert.throws(()=>policyProbeArguments(invalid));
});
test('CLI without explicit opt-in exits with only fixed redacted output and no provider request',()=>{
  const result=spawnSync(process.execPath,['scripts/provider-policy-probe.mjs','--cdp-file','sensitive-key-value'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr),{status:'INCONCLUSIVE',category:'CONFIGURATION_REQUIRED',testnetOnly:true,
    expiredAuthorizationsOnly:true,signingOnly:true,paymentInitiated:false,fundingAccepted:false});
});
test('probe source has no settlement, broadcast, faucet or Stripe import surface',()=>{
  for(const path of ['../src/unattended/policy-probe.mjs','../scripts/provider-policy-probe.mjs']){
    const source=readFileSync(new URL(path,import.meta.url),'utf8');
    assert.ok(!/import[^;]*(?:facilitator|chain-stripe|merchant\.mjs|broker\.mjs|runtime\.mjs|x402|stripe|faucet)/i.test(source));
    assert.ok(!/\.(?:sendEvmTransaction|sendEvmAsset|sendTransaction|settle|requestFaucet|createPolicy|revokeDelegationForEndUserAccount)\s*\(/.test(source));
  }
});
