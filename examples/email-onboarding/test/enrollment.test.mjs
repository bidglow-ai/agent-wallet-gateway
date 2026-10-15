import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OnboardingController,validateDevelopmentConfig} from '../src/controller.ts';

const wallet='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),userId=randomUUID();
const config={projectId:randomUUID(),developmentConfirmed:true,enrollmentOrigin:'http://127.0.0.1:43210'};
const session='synthetic.session.not-a-credential',capability='c'.repeat(43);
function fixture(options={}){
  let user={userId,evmAccountObjects:[{address:wallet},{address:other}]},listener;
  const calls=[],providerCalls=[];
  const grant={grantId:randomUUID(),userId,wallet,network:'eip155:84532',asset:'0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    payTo:'0x'+'3'.repeat(40),merchantOrigin:'https://merchant.example',perCallAtomic:'5000000',totalAtomic:'10000000',expiresAt:Date.now()+3600000};
  const proposal={nonce:'n'.repeat(43),challengeExpiresAt:Date.now()+90000,grant,existing:false,testnetOnly:true,mainnetEnabled:false,fundingAccepted:false};
  const confirmation={grant,agentConnection:{brokerOrigin:'http://127.0.0.1:43211',clientToken:capability},testnetOnly:true,mainnetEnabled:false,fundingAccepted:false};
  const recovery={...confirmation,recoveryOnly:true};
  const sdk={initialize:async()=>{},getCurrentUser:async()=>user,onAuthStateChange:fn=>{listener=fn;},
    getAccessToken:async()=>{providerCalls.push('getAccessToken');await options.tokenGate;return options.noToken?null:session;},
    signInWithEmail:async()=>({flowId:'synthetic'}),verifyEmailOTP:async()=>({user}),
    getDelegationForAccount:async()=>{throw {statusCode:404,errorType:'delegation_not_found'};},createDelegationForAccount:async input=>input,
    revokeDelegationForAccount:async()=>{providerCalls.push('providerOnlyRevoke');},signOut:async()=>{user=null;listener?.(null);if(options.signOutFails)throw Error('private-example');}};
  const transport=async(url,init)=>{
    calls.push({url,init});await options.responseGate;
    if(options.failAction&&url.endsWith(options.failAction))throw Error('private-example '+session);
    let value=url.endsWith('/proposal')?proposal:url.endsWith('/confirm')?confirmation:url.endsWith('/recover')?recovery:{revoked:true};
    if(options.response)value=options.response(value,url);
    return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  };
  const controller=new OnboardingController(sdk,options.config||config,'http://127.0.0.1:4376',transport);
  return {controller,calls,providerCalls,grant,proposal,confirmation,setUser(value){user=value;listener?.(value);}};
}
async function enrolled(f){await f.controller.initialize();await f.controller.proposeMandate();await f.controller.confirmMandate(true);}
test('blank backend blocks enrollment without token retrieval; public/credential/path origins fail closed',async()=>{
  const f=fixture({config:{...config,enrollmentOrigin:''}});await f.controller.initialize();
  await assert.rejects(f.controller.proposeMandate(),/TRUSTED_ENROLLMENT_ORIGIN_REQUIRED/);assert.equal(f.calls.length,0);assert.equal(f.providerCalls.length,0);
  for(const origin of ['https://127.0.0.1:43210','http://localhost:43210','http://127.0.0.1:43210/path','http://user@127.0.0.1:43210','http://127.0.0.1:43210?token=secret','https://attacker.example'])
    assert.throws(()=>validateDevelopmentConfig({...config,enrollmentOrigin:origin},'http://127.0.0.1:4376'),/TRUSTED_ENROLLMENT_ORIGIN_REQUIRED/);
});
test('proposal alone never activates; token only in Authorization and exact lowercase wallet body',async()=>{
  const f=fixture();await f.controller.initialize();assert.equal(f.calls.length,0);await f.controller.proposeMandate();
  assert.equal(f.calls.length,1);const {url,init}=f.calls[0];assert.equal(url,config.enrollmentOrigin+'/enrollment/v1/proposal');
  assert.equal(init.headers.Authorization,'Bearer '+session);assert.deepEqual(JSON.parse(init.body),{wallet});
  assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
  assert.ok(!url.includes(session));assert.ok(!init.body.includes(session));assert.ok(!JSON.stringify(f.controller.state()).includes(session));
  assert.ok(!JSON.stringify(f.controller.state()).includes(f.proposal.nonce));assert.equal(f.controller.connection(),undefined);
  assert.equal(f.controller.state().proposal.grant.totalAtomic,'10000000');
});
test('confirmation needs separate consent and consumes original nonce exactly once',async()=>{
  const f=fixture();await f.controller.initialize();await f.controller.proposeMandate();
  await assert.rejects(f.controller.confirmMandate(false),/EXPLICIT_MANDATE_CONSENT_REQUIRED/);assert.equal(f.calls.length,1);
  await f.controller.confirmMandate(true);assert.equal(f.calls.length,2);
  assert.deepEqual(JSON.parse(f.calls[1].init.body),{wallet,nonce:f.proposal.nonce,approved:true});
  assert.deepEqual(f.controller.connection(),f.confirmation.agentConnection);assert.equal(f.controller.state().paymentsEnabled,false);
  assert.ok(!JSON.stringify(f.controller.state()).includes(capability));
  await assert.rejects(f.controller.confirmMandate(true),/MANDATE_PROPOSAL_EXPIRED_OR_USED/);assert.equal(f.calls.length,2);
});
test('wrong network/token/caps/identity, expired challenge and extra fields never become approvable',async()=>{
  for(const mutate of [p=>({...p,grant:{...p.grant,network:'eip155:8453'}}),p=>({...p,grant:{...p.grant,asset:other}}),
    p=>({...p,grant:{...p.grant,perCallAtomic:'6000000'}}),p=>({...p,grant:{...p.grant,totalAtomic:'11000000'}}),
    p=>({...p,grant:{...p.grant,userId:randomUUID()}}),p=>({...p,challengeExpiresAt:Date.now()-1}),p=>({...p,debug:'private-example'})]){
    const f=fixture({response:mutate});await f.controller.initialize();await assert.rejects(f.controller.proposeMandate(),/ENROLLMENT_RESPONSE_REQUIRES_REVIEW/);
    assert.equal(f.controller.state().proposal,undefined);assert.equal(f.controller.connection(),undefined);assert.equal(f.calls.length,1);
  }
});
test('changed confirmation terms, capability URL and unknown outcome expose no connection; no automatic retry',async()=>{
  for(const options of [{response:(p,url)=>url.endsWith('/confirm')?{...p,grant:{...p.grant,payTo:other}}:p},
    {response:(p,url)=>url.endsWith('/confirm')?{...p,agentConnection:{...p.agentConnection,brokerOrigin:'https://attacker.example'}}:p},{failAction:'/confirm'}]){
    const f=fixture(options);await f.controller.initialize();await f.controller.proposeMandate();
    await assert.rejects(f.controller.confirmMandate(true),e=>!e.message.includes(session)&&!e.message.includes('private-example'));
    assert.equal(f.controller.connection(),undefined);assert.equal(f.calls.length,2);assert.equal(f.controller.state().proposal,undefined);
    await assert.rejects(f.controller.confirmMandate(true));assert.equal(f.calls.length,2);
  }
});
test('missing token and identity change during token retrieval cannot send enrollment request',async()=>{
  const missing=fixture({noToken:true});await missing.controller.initialize();await assert.rejects(missing.controller.proposeMandate(),/AUTHENTICATED_ENROLLMENT_REQUIRED/);assert.equal(missing.calls.length,0);
  let release;const f=fixture({tokenGate:new Promise(resolve=>{release=resolve;})});await f.controller.initialize();
  const pending=f.controller.proposeMandate();await Promise.resolve();await Promise.resolve();
  f.setUser({userId:randomUUID(),evmAccountObjects:[{address:wallet}]});release();
  await assert.rejects(pending,/AUTHENTICATED_ACCOUNT_CHANGED/);assert.equal(f.calls.length,0);
});
test('account switch, auth notification and failed signout each erase in-memory capability',async()=>{
  for(const change of [f=>f.controller.selectAccount(other),f=>f.setUser(null),f=>f.setUser({userId:randomUUID(),evmAccountObjects:[{address:wallet}]})]){
    const f=fixture();await enrolled(f);assert.ok(f.controller.connection());change(f);assert.equal(f.controller.connection(),undefined);assert.equal(f.controller.state().proposal,undefined);
  }
  const f=fixture({signOutFails:true});await enrolled(f);await assert.rejects(f.controller.signOut());assert.equal(f.controller.connection(),undefined);
});
test('combined backend revoke works without active delegation and cannot be bypassed by provider-only revoke',async()=>{
  const f=fixture();await enrolled(f);await assert.rejects(f.controller.revokeDelegation(),/BACKEND_REVOCATION_REQUIRED/);
  await assert.rejects(f.controller.revokeMandate(false),/EXPLICIT_MANDATE_CONSENT_REQUIRED/);
  await f.controller.revokeMandate(true);assert.equal(f.controller.connection(),undefined);assert.equal(f.controller.state().backendEnrollment,'revoked');
  assert.ok(f.calls.at(-1).url.endsWith('/revoke'));assert.deepEqual(JSON.parse(f.calls.at(-1).init.body),{wallet,approved:true});
  assert.ok(!f.providerCalls.includes('providerOnlyRevoke'));
});
test('lost revoke response erases capability but never reports provider revocation success',async()=>{
  const f=fixture({failAction:'/revoke'});await enrolled(f);await assert.rejects(f.controller.revokeMandate(true),/ENROLLMENT_OUTCOME_UNCONFIRMED/);
  assert.equal(f.controller.connection(),undefined);assert.equal(f.controller.state().backendEnrollment,'unknown');assert.notEqual(f.controller.state().delegation.status,'revoked');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/revoke')).length,1);
});
test('expired proposal cannot confirm and expired mandate cannot expose a stored connection',async t=>{
  const f=fixture();await f.controller.initialize();await f.controller.proposeMandate();
  const now=Date.now();t.mock.method(Date,'now',()=>now+120001);
  await assert.rejects(f.controller.confirmMandate(true),/MANDATE_PROPOSAL_EXPIRED_OR_USED/);assert.equal(f.calls.length,1);
  t.mock.restoreAll();await f.controller.proposeMandate();await f.controller.confirmMandate(true);
  t.mock.method(Date,'now',()=>f.grant.expiresAt+1);assert.equal(f.controller.connection(),undefined);assert.equal(f.controller.state().connectionAvailable,false);
});
test('identity change after confirm submission cannot expose the returned capability',async()=>{
  const f=fixture({response:(value,url)=>{if(url.endsWith('/confirm'))f.setUser({userId:randomUUID(),evmAccountObjects:[{address:wallet}]});return value;}});
  await f.controller.initialize();await f.controller.proposeMandate();
  await assert.rejects(f.controller.confirmMandate(true),/AUTHENTICATED_ACCOUNT_CHANGED/);assert.equal(f.controller.connection(),undefined);
});
test('separate recovery consent accepts original expired grant without renewing or enabling payment',async()=>{
  const f=fixture();f.grant.expiresAt=Date.now()-60000;await f.controller.initialize();
  await assert.rejects(f.controller.recoverConnection(false),/EXPLICIT_MANDATE_CONSENT_REQUIRED/);assert.equal(f.calls.length,0);
  await f.controller.recoverConnection(true);
  assert.deepEqual(JSON.parse(f.calls[0].init.body),{wallet,approved:true});assert.ok(f.calls[0].url.endsWith('/recover'));
  assert.equal(f.controller.state().backendEnrollment,'recovery_only');assert.equal(f.controller.state().connectionRecoveryOnly,true);
  assert.equal(f.controller.state().mandate.expiresAt,f.grant.expiresAt);assert.equal(f.controller.state().paymentsEnabled,false);
  assert.equal(f.controller.state().fundingAccepted,false);assert.ok(f.controller.connection());
  assert.deepEqual(f.providerCalls,['getAccessToken']);
  await assert.rejects(f.controller.confirmMandate(true),/MANDATE_PROPOSAL_EXPIRED_OR_USED/);assert.equal(f.calls.length,1);assert.equal(f.controller.connection(),undefined);
});
test('recovery rejects missing inspect-only flag, mismatched account/network/caps and unsafe capability',async()=>{
  for(const alter of [p=>({...p,recoveryOnly:false}),p=>({...p,grant:{...p.grant,wallet:other}}),
    p=>({...p,grant:{...p.grant,network:'eip155:8453'}}),p=>({...p,grant:{...p.grant,totalAtomic:'20000000'}}),
    p=>({...p,agentConnection:{...p.agentConnection,brokerOrigin:'http://localhost:43211'}})]){
    const f=fixture({response:(p,url)=>url.endsWith('/recover')?alter(p):p});await f.controller.initialize();
    await assert.rejects(f.controller.recoverConnection(true));assert.equal(f.controller.connection(),undefined);assert.notEqual(f.controller.state().backendEnrollment,'confirmed');
    assert.equal(f.calls.length,1);
  }
});
