import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EnrollmentAuthority,createEnrollmentHttpServer} from '../src/unattended/enrollment.mjs';
import {PaymentError} from '../src/unattended/intent.mjs';
import {DELEGATION_DURATION_HOURS,DEFAULT_DURATION_MS,MAX_DELEGATION_MS} from '../src/unattended/duration-policy.mjs';
import {EnrollmentStore} from '../src/unattended/enrollment-store.mjs';
import {PaymentStore} from '../src/unattended/store.mjs';
import {fixture as paymentFixture} from './helpers/unattended.mjs';
const wallet='0x'+'1'.repeat(40),payTo='0x'+'2'.repeat(40),userId=randomUUID();
const config={projectId:randomUUID(),expectedWallet:wallet,payTo,merchantOrigin:'https://merchant.example',perCallAtomic:'5000000',totalAtomic:'10000000',durationMs:3600000};
function fixture(){
  let stored=null,stopped=false,activations=0,verified=0,delegated=true;
  const signer={
    async verifyEnrollment({accessToken,wallet:address}){verified++;if(accessToken!=='owner.session'||!delegated)throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');return {userId,wallet:address,delegationExpiresAt:Date.now()+7200000};},
    async verifySession({accessToken,wallet:address}){verified++;if(accessToken!=='owner.session')throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');return {userId,wallet:address};},
  };
  const registry={get(){return stored;},enroll(subject,grant){assert.equal(subject.userId,userId);if(stored)assert.deepEqual(grant,stored);stored=grant;return {grant,created:true};}};
  const connection={brokerOrigin:'http://127.0.0.1:4599',clientToken:randomBytes(32).toString('base64url')};
  const authority=new EnrollmentAuthority({signer,registry,config,activate:async()=>{activations++;if(stopped)throw new PaymentError('GRANT_REVOKED');return connection;},revoke:async()=>{stopped=true;return {revoked:true};}});
  return {authority,registry,connection,counts:()=>({activations,verified}),setDelegated(value){delegated=value;}};
}
test('bounded proposal requires fresh provider identity and explicit one-use consent',async()=>{
  const f=fixture();
  await assert.rejects(f.authority.propose('forged',{wallet}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
  await assert.rejects(f.authority.propose('owner.session',{wallet:'0x'+'3'.repeat(40)}),{code:'OPERATOR_SELECTED_WALLET_REQUIRED'});
  await assert.rejects(f.authority.propose('owner.session',{wallet,userId}),{code:'INVALID_ENROLLMENT_REQUEST'});
  assert.equal(f.registry.get(),null);assert.equal(f.counts().activations,0);
  const p=await f.authority.propose('owner.session',{wallet});
  assert.equal(p.grant.totalAtomic,'10000000');assert.equal(p.grant.perCallAtomic,'5000000');
  assert.equal(p.fundingAccepted,false);assert.equal(p.grant.wallet,wallet);assert.equal(p.grant.userId,userId);
  assert.ok(p.challengeExpiresAt<=Date.now()+120000);assert.equal(f.registry.get(),null);
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:false}),{code:'EXPLICIT_MANDATE_CONSENT_REQUIRED'});
  const confirmed=await f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true});
  assert.deepEqual(confirmed.agentConnection,f.connection);assert.equal(f.counts().activations,1);
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true}),{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});
  const resumed=await f.authority.propose('owner.session',{wallet});
  assert.equal(resumed.existing,true);assert.deepEqual(resumed.grant,p.grant);
});
test('first enrollment supports30/90days and short choices without extending challenge or payment authority',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  for(const hours of DELEGATION_DURATION_HOURS){
    const f=fixture(),durationMs=hours*3600000;
    const authority=new EnrollmentAuthority({signer:{verifyEnrollment:async()=>({userId,wallet,delegationExpiresAt:now+durationMs})},
      registry:f.registry,config:{...config,durationMs},activate:async()=>f.connection,revoke:()=>{}});
    const proposal=await authority.propose('owner.session',{wallet});
    assert.equal(proposal.grant.expiresAt,now+durationMs);assert.equal(proposal.challengeExpiresAt,now+120000);
    assert.equal(proposal.grant.perCallAtomic,'5000000');assert.equal(proposal.grant.totalAtomic,'10000000');assert.equal(proposal.grant.network,'eip155:84532');
    const accepted=await authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true});
    assert.equal(accepted.grant.expiresAt,proposal.grant.expiresAt);assert.equal(accepted.fundingAccepted,false);
  }
});
test('long duration configurations and identity remain finite, enumerated and capped at90days',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture();
  const make=(durationMs,delegationExpiresAt)=>new EnrollmentAuthority({signer:{verifyEnrollment:async()=>({userId,wallet,delegationExpiresAt})},
    registry:f.registry,config:{...config,durationMs},activate:async()=>f.connection,revoke:()=>{}});
  for(const durationMs of [0,172800000,MAX_DELEGATION_MS+1,Infinity,NaN,String(DEFAULT_DURATION_MS),null])assert.throws(()=>make(durationMs,now+MAX_DELEGATION_MS),{code:'DEVELOPMENT_ENROLLMENT_CONFIGURATION_REQUIRED'});
  for(const until of [now,now+MAX_DELEGATION_MS+1,Infinity,NaN,String(now+DEFAULT_DURATION_MS)])
    await assert.rejects(make(DEFAULT_DURATION_MS,until).propose('owner.session',{wallet}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
  assert.equal(f.registry.get(),null);
});
test('changing operator default to30/90days never renews an existing1hour mandate, even after expiry',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture(),original=await f.authority.propose('owner.session',{wallet});
  await f.authority.confirm('owner.session',{wallet,nonce:original.nonce,approved:true});
  for(const durationMs of [DEFAULT_DURATION_MS,MAX_DELEGATION_MS]){
    const authority=new EnrollmentAuthority({signer:{verifyEnrollment:async()=>({userId,wallet,delegationExpiresAt:now+durationMs}),verifySession:async()=>({userId,wallet})},
      registry:f.registry,config:{...config,durationMs},activate:async()=>f.connection,revoke:()=>{},recover:async()=>f.connection});
    const proposal=await authority.propose('owner.session',{wallet});assert.equal(proposal.existing,true);assert.deepEqual(proposal.grant,original.grant);
    const accepted=await authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true});assert.deepEqual(accepted.grant,original.grant);
    const previous=now;now=original.grant.expiresAt+1;
    await assert.rejects(authority.propose('owner.session',{wallet}),{code:'MANDATE_IDENTITY_OR_SCOPE_MISMATCH'});
    const recovered=await authority.recover('owner.session',{wallet,approved:true});assert.equal(recovered.recoveryOnly,true);assert.deepEqual(recovered.grant,original.grant);
    now=previous;
  }
});
test('confirm revalidates delegation; stale/forged sessions never activate',async()=>{
  const f=fixture(),p=await f.authority.propose('owner.session',{wallet});
  await assert.rejects(f.authority.confirm('forged',{wallet,nonce:p.nonce,approved:true}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true}),{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});
  const q=await f.authority.propose('owner.session',{wallet});f.setDelegated(false);
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:q.nonce,approved:true}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
  assert.equal(f.counts().activations,0);assert.equal(f.registry.get(),null);
});
test('expired proposal is never enrolled or automatically refreshed',async()=>{
  const f=fixture(),p=await f.authority.propose('owner.session',{wallet}),realNow=Date.now;
  try{Date.now=()=>p.challengeExpiresAt+1;await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true}),{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});}
  finally{Date.now=realNow;}
  assert.equal(f.registry.get(),null);assert.equal(f.counts().activations,0);
});
test('proposal is expired at its exact deadline and does not begin another authentication',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture(),proposal=await f.authority.propose('owner.session',{wallet});
  const before=f.counts().verified;now=proposal.challengeExpiresAt;
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true}),{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});
  assert.equal(f.counts().verified,before);assert.equal(f.registry.get(),null);assert.equal(f.counts().activations,0);
});
test('authentication crossing the original challenge deadline cannot enroll or activate',async t=>{
  let now=Date.now(),calls=0,enrollments=0,activations=0,release,started;t.mock.method(Date,'now',()=>now);
  const blocked=new Promise(resolve=>{release=resolve;}),authStarted=new Promise(resolve=>{started=resolve;});
  const authority=new EnrollmentAuthority({
    signer:{verifyEnrollment:async()=>{if(++calls===2){started();await blocked;}return {userId,wallet,delegationExpiresAt:now+3600000};}},
    registry:{get:()=>null,enroll:()=>{enrollments++;assert.fail('expired consent cannot enroll');}},config,
    activate:async()=>{activations++;assert.fail('expired consent cannot activate');},revoke:()=>{},
  });
  const proposal=await authority.propose('owner.session',{wallet});
  const confirming=authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true});await authStarted;
  now=proposal.challengeExpiresAt;release();
  await assert.rejects(confirming,{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});assert.equal(enrollments,0);assert.equal(activations,0);
  await assert.rejects(authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true}),{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});
});
test('activation crossing deadline withholds capability but preserves original persisted mandate and reserved budget',async t=>{
  let now=Date.now(),activations=0,release,started;t.mock.method(Date,'now',()=>now);
  const directory=mkdtempSync(join(tmpdir(),'enrollment-deadline-'));
  const registry=new EnrollmentStore(join(directory,'registry'),{projectId:config.projectId,expectedWallet:wallet});
  let payer;t.after(()=>{payer?.close();registry.close();rmSync(directory,{recursive:true,force:true});});
  const blocked=new Promise(resolve=>{release=resolve;}),activationStarted=new Promise(resolve=>{started=resolve;});
  const connection={brokerOrigin:'http://127.0.0.1:4599',clientToken:randomBytes(32).toString('base64url')};
  const authority=new EnrollmentAuthority({signer:{verifyEnrollment:async()=>({userId,wallet,delegationExpiresAt:now+3600000})},registry,config,
    activate:async()=>{if(++activations===1){started();await blocked;}return connection;},revoke:()=>{}});
  const proposal=await authority.propose('owner.session',{wallet});
  const confirming=authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true});await activationStarted;
  assert.deepEqual(registry.get(),proposal.grant);payer=new PaymentStore(registry.budgetStateDir,proposal.grant);
  const original=paymentFixture().order,order={...original,grantId:proposal.grant.grantId,wallet,payTo,
    merchantOrigin:proposal.grant.merchantOrigin,resourceURL:proposal.grant.merchantOrigin+'/orders/'+original.id};
  payer.reserve(order);payer.transition(order.id,'reserved','unknown');assert.equal(payer.summary().remainingAtomic,'5000000');
  now=proposal.challengeExpiresAt;release();
  await assert.rejects(confirming,{code:'MANDATE_PROPOSAL_EXPIRED_OR_USED'});
  assert.deepEqual(registry.get(),proposal.grant);assert.equal(payer.summary().remainingAtomic,'5000000');assert.equal(payer.get(order.id).state,'unknown');
  const fresh=await authority.propose('owner.session',{wallet});assert.equal(fresh.existing,true);assert.deepEqual(fresh.grant,proposal.grant);
  assert.equal(fresh.challengeExpiresAt,now+120000);
  const accepted=await authority.confirm('owner.session',{wallet,nonce:fresh.nonce,approved:true});
  assert.deepEqual(accepted.agentConnection,connection);assert.deepEqual(accepted.grant,proposal.grant);
  assert.equal(payer.summary().remainingAtomic,'5000000');assert.equal(payer.get(order.id).state,'unknown');
});
test('revocation remains authenticated and available after provider delegation expires',async()=>{
  const f=fixture(),p=await f.authority.propose('owner.session',{wallet});
  await f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true});f.setDelegated(false);
  await assert.rejects(f.authority.revoke('forged',{wallet,approved:true}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
  await assert.rejects(f.authority.revoke('owner.session',{wallet,approved:false}),{code:'EXPLICIT_MANDATE_CONSENT_REQUIRED'});
  assert.deepEqual(await f.authority.revoke('owner.session',{wallet,approved:true}),{revoked:true});
});
test('bounded pending challenges and malformed fields cannot overwrite a grant',async()=>{
  const f=fixture();for(let i=0;i<8;i++)await f.authority.propose('owner.session',{wallet});
  await assert.rejects(f.authority.propose('owner.session',{wallet}),{code:'ENROLLMENT_BUSY'});
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:'bad',approved:true}),{code:'EXPLICIT_MANDATE_CONSENT_REQUIRED'});
  assert.equal(f.registry.get(),null);
});
test('revocation racing asynchronous activation never returns a fresh agent capability',async()=>{
  let grant,release,started;const activated=new Promise(resolve=>{started=resolve;});
  const signer={verifyEnrollment:async()=>({userId,wallet,delegationExpiresAt:Date.now()+7200000}),verifySession:async()=>({userId,wallet})};
  const registry={get:()=>grant??null,enroll:(_subject,g)=>{grant=g;return {grant:g};}};
  const authority=new EnrollmentAuthority({signer,registry,config,activate:async()=>{started();return await new Promise(resolve=>{release=resolve;});},revoke:async()=>({revoked:true})});
  const p=await authority.propose('owner.session',{wallet});
  const confirming=authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true});await activated;
  assert.equal((await authority.revoke('owner.session',{wallet,approved:true})).revoked,true);
  release({brokerOrigin:'http://127.0.0.1:4599',clientToken:randomBytes(32).toString('base64url')});
  await assert.rejects(confirming,{code:'MANDATE_REVOKED'});
  await assert.rejects(authority.propose('owner.session',{wallet}),{code:'MANDATE_REVOKED'});
});
test('historical recovery authenticates the original owner without renewing an expired mandate',async()=>{
  const f=fixture(),p=await f.authority.propose('owner.session',{wallet});
  await f.authority.confirm('owner.session',{wallet,nonce:p.nonce,approved:true});
  let recoveries=0;const grant={...p.grant,expiresAt:Date.now()-1};
  const authority=new EnrollmentAuthority({signer:{verifySession:async({accessToken})=>{if(accessToken!=='owner.session')throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');return {userId,wallet};}},
    registry:{get:()=>grant},config,activate:()=>assert.fail('recovery must not activate payment'),revoke:()=>{},recover:async g=>{recoveries++;assert.deepEqual(g,grant);return f.connection;}});
  await assert.rejects(authority.recover('forged',{wallet,approved:true}),{code:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
  await assert.rejects(authority.recover('owner.session',{wallet,approved:false}),{code:'EXPLICIT_RECOVERY_CONSENT_REQUIRED'});
  const result=await authority.recover('owner.session',{wallet,approved:true});
  assert.deepEqual(result.grant,grant);assert.equal(result.recoveryOnly,true);assert.equal(recoveries,1);
});
test('localhost browser support never permits a localhost broker capability on confirm or recovery',async()=>{
  const f=fixture();f.connection.brokerOrigin='http://localhost:4599';
  const proposal=await f.authority.propose('owner.session',{wallet});
  await assert.rejects(f.authority.confirm('owner.session',{wallet,nonce:proposal.nonce,approved:true}),{code:'LOCAL_ONBOARDING_ORIGIN_REQUIRED'});
  const authority=new EnrollmentAuthority({signer:{verifySession:async()=>({userId,wallet})},registry:f.registry,config,
    activate:()=>assert.fail('recovery must not activate payment'),revoke:()=>{},recover:async()=>f.connection});
  await assert.rejects(authority.recover('owner.session',{wallet,approved:true}),{code:'LOCAL_ONBOARDING_ORIGIN_REQUIRED'});
});
for(const origin of ['http://127.0.0.1:4376','http://localhost:4376'])test(`enrollment HTTP enforces exact ${origin}, bearer JSON and narrow routes without leaking errors`,async t=>{
  const f=fixture();
  const server=createEnrollmentHttpServer({authority:f.authority,onboardingOrigin:origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/enrollment/v1/proposal`;
  const request=(changes={})=>fetch(url,{method:'POST',headers:{Origin:origin,Authorization:'Bearer owner.session','Content-Type':'application/json',...changes.headers},body:JSON.stringify(changes.body??{wallet})});
  assert.equal((await request({headers:{Origin:'https://evil.example'}})).status,403);
  for(const wrongOrigin of [origin.includes('localhost')?'http://127.0.0.1:4376':'http://localhost:4376','http://localhost:4375','http://localhost.evil.example:4376']){
    const rejected=await request({headers:{Origin:wrongOrigin}});assert.equal(rejected.status,403);assert.equal(rejected.headers.get('Access-Control-Allow-Origin'),null);
  }
  const wrongHost=await new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers:{Host:'evil.example',Origin:origin,Authorization:'Bearer owner.session','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({wallet}));});
  assert.equal(wrongHost,403);
  assert.equal((await request({headers:{Authorization:'Bearer wrong'}})).status,409);
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await request({headers:{'Content-Type':'text/plain'}})).status,400);
  assert.equal((await request({body:{wallet,grantId:randomUUID()}})).status,409);
  const valid=await request();assert.equal(valid.status,200);assert.equal(valid.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(valid.headers.get('Cache-Control'),'no-store');
  assert.equal(valid.headers.get('Access-Control-Allow-Credentials'),null);
  const proposal=await valid.json();assert.equal(proposal.grant.wallet,wallet);
  const preflight=await fetch(url,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,authorization'}});
  assert.equal(preflight.status,204);
  assert.equal((await fetch(url,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization,content-type'}})).status,403);
  assert.equal((await fetch(url+'?token=forged',{method:'POST',headers:{Origin:origin}})).status,404);
  const huge=await request({body:{wallet,extra:'x'.repeat(3000)}});assert.equal(huge.status,413);
  assert.equal(JSON.stringify(await huge.json()).includes('owner.session'),false);
});
