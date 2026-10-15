import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import {EnrollmentAuthority,createEnrollmentHttpServer} from '../src/unattended/enrollment.mjs';
import {PaymentError} from '../src/unattended/intent.mjs';
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
test('enrollment HTTP enforces exact origin, bearer JSON and narrow routes without leaking errors',async t=>{
  const f=fixture(),origin='http://127.0.0.1:4376';
  const server=createEnrollmentHttpServer({authority:f.authority,onboardingOrigin:origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/enrollment/v1/proposal`;
  const request=(changes={})=>fetch(url,{method:'POST',headers:{Origin:origin,Authorization:'Bearer owner.session','Content-Type':'application/json',...changes.headers},body:JSON.stringify(changes.body??{wallet})});
  assert.equal((await request({headers:{Origin:'https://evil.example'}})).status,403);
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
