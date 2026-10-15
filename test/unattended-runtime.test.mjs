import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,chmodSync,symlinkSync,linkSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/unattended.mjs';
import {startDevelopmentRuntime,validateOperatorConfig,PrivateOrderProvider,loadOperatorBundle} from '../src/unattended/runtime.mjs';
import {readPrivateJson} from '../src/unattended/private-json.mjs';
import {paymentTypedData,orderNonce,PaymentError} from '../src/unattended/intent.mjs';
import {BrokerHttpClient} from '../src/unattended/http.mjs';
import {EnrollmentStore} from '../src/unattended/enrollment-store.mjs';
function directory(t){const path=mkdtempSync(join(tmpdir(),'enrollment-runtime-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
function configFor(dir,f,port=4377){return {developmentProjectConfirmed:true,projectId:randomUUID(),expectedWallet:f.grant.wallet,payTo:f.grant.payTo,
  merchantOrigin:f.grant.merchantOrigin,perCallAtomic:'5000000',totalAtomic:'10000000',durationMs:3600000,policyId:'policy_test',merchantAccount:f.order.merchantAccount,
  fromBlock:'0',stateDir:join(dir,'private'),orderDirectory:join(dir,'orders'),onboardingOrigin:'http://127.0.0.1:4376',enrollmentPort:port};}
async function freePort(){const s=createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
test('operator configuration rejects mainnet/live keys, public listener and ambiguous private paths',t=>{
  const dir=directory(t),f=fixture(),config=configFor(dir,f);
  assert.equal(validateOperatorConfig(config).developmentProjectConfirmed,true);
  assert.equal(validateOperatorConfig({...config,onboardingOrigin:'http://localhost:4376'}).onboardingOrigin,'http://localhost:4376');
  for(const changed of [{developmentProjectConfirmed:false},{network:'eip155:8453'},{perCallAtomic:'5000001'},{totalAtomic:'10000001'},
    {onboardingOrigin:'https://bidglow.ai'},{stateDir:'relative'},{orderDirectory:config.stateDir},{durationMs:172800000},{enrollmentPort:80}])assert.throws(()=>validateOperatorConfig({...config,...changed}));
  for(const onboardingOrigin of ['http://localhost.evil.example:4376','http://www.localhost:4376','http://localhost.:4376','http://127.0.0.2:4376','http://0.0.0.0:4376','http://[::1]:4376',
    'https://localhost:4376','http://localhost','http://localhost:80','http://localhost:4377','http://user@localhost:4376','http://localhost:4376/','http://localhost:4376?x=1','http://localhost:4376#x','http://2130706433:4376','http://127.1:4376'])
    assert.throws(()=>validateOperatorConfig({...config,onboardingOrigin}),{code:'LOCAL_ONBOARDING_ORIGIN_REQUIRED'});
  const file=join(dir,'operator.json');
  writeFileSync(file,JSON.stringify({config,credentials:{apiKeyId:'synthetic-key-id',apiKeySecret:'synthetic-key-secret',walletSecret:'synthetic-wallet-secret',stripeTestKey:'sk_live_'+'1'.repeat(25)}}),{mode:0o600});
  assert.throws(()=>loadOperatorBundle(file),{code:'SANDBOX_EVIDENCE_CONFIGURATION_REQUIRED'});
});
test('private operator files reject public permissions, symlinks, hardlinks and oversized input',t=>{
  const dir=directory(t),file=join(dir,'private.json');writeFileSync(file,'{"ok":true}',{mode:0o600});
  assert.deepEqual(readPrivateJson(file),{ok:true});assert.throws(()=>readPrivateJson(file,3));
  const sym=join(dir,'sym.json');symlinkSync(file,sym);assert.throws(()=>readPrivateJson(sym));
  const hard=join(dir,'hard.json');linkSync(file,hard);assert.throws(()=>readPrivateJson(file));rmSync(hard);
  chmodSync(file,0o644);assert.throws(()=>readPrivateJson(file));
});
test('private order source pins full grant/account and refuses client paths or mutable business scope',t=>{
  const dir=directory(t),f=fixture(),provider=new PrivateOrderProvider({directory:join(dir,'orders'),grant:f.grant,merchantAccount:f.order.merchantAccount});
  const path=join(dir,'orders',f.order.id+'.json');writeFileSync(path,JSON.stringify(f.order),{mode:0o600});
  assert.equal(provider.get(f.order.id).id,f.order.id);assert.throws(()=>provider.get('../private'));
  writeFileSync(path,JSON.stringify({...f.order,merchantAccount:'acct_otheraccount'}));assert.throws(()=>provider.get(f.order.id),{code:'AUTHENTICATED_ORDER_REQUIRED'});
});
test('actual local enrollment -> restricted broker -> fixture payment -> restart preserves one budget and revocation',async t=>{
  const dir=directory(t),f=fixture(),port=await freePort(),config={...configFor(dir,f,port),onboardingOrigin:'http://localhost:4376'};let signs=0,settles=0,revokeFails=false,loseNext=false;
  const settled=new Map();
  const dependencies={
    signer:{
      verifyEnrollment:async({accessToken,wallet})=>{if(accessToken!=='owner.session')throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');return {userId:f.grant.userId,wallet,delegationExpiresAt:Date.now()+7200000};},
      verifySession:async({accessToken,wallet})=>{if(accessToken!=='owner.session')throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');return {userId:f.grant.userId,wallet};},
      sign:async(order,grant)=>{signs++;return f.signer.signTypedData(paymentTypedData(order,grant));},
      revoke:async()=>{if(revokeFails)throw new PaymentError('PROVIDER_REVOCATION_UNCONFIRMED');},
    },
    merchant:{settle:async order=>{settles++;const tx='0x'+(settles===1?'a':'b').repeat(64);settled.set(order.id,tx);if(loseNext){loseNext=false;throw new Error('synthetic lost response');}return {transactionHash:tx};}},
    verifier:{verify:async order=>({orderId:order.id,nonce:orderNonce(order),amountAtomic:order.amountAtomic,network:order.network,transactionHash:settled.get(order.id),paymentIntentId:order.id===f.order.id?'pi_isolatedruntime':'pi_isolatedrecovered'})},
  };
  let runtime=await startDevelopmentRuntime({config,dependencies});
  t.after(async()=>{await runtime?.close();});
  const request=async(action,body)=>{
    const r=await fetch(runtime.enrollmentOrigin+'/enrollment/v1/'+action,{method:'POST',headers:{Origin:config.onboardingOrigin,Authorization:'Bearer owner.session','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  let p=await request('proposal',{wallet:config.expectedWallet});assert.equal(p.status,200);assert.equal(signs,0);
  let enrolled=await request('confirm',{wallet:config.expectedWallet,nonce:p.body.nonce,approved:true});assert.equal(enrolled.status,200);assert.equal(enrolled.body.fundingAccepted,false);
  const grant=enrolled.body.grant,order={...f.order,grantId:grant.grantId,expiresAt:Date.now()+240000};
  writeFileSync(join(config.orderDirectory,order.id+'.json'),JSON.stringify(order),{mode:0o600});
  let client=new BrokerHttpClient({origin:enrolled.body.agentConnection.brokerOrigin,clientToken:enrolled.body.agentConnection.clientToken});
  assert.equal((await client.pay({id:order.id})).state,'confirmed');assert.equal(signs,1);assert.equal(settles,1);
  await runtime.close();runtime=null;
  runtime=await startDevelopmentRuntime({config,dependencies});
  p=await request('proposal',{wallet:config.expectedWallet});assert.equal(p.body.existing,true);assert.deepEqual(p.body.grant,grant);
  enrolled=await request('confirm',{wallet:config.expectedWallet,nonce:p.body.nonce,approved:true});assert.equal(enrolled.status,200);
  client=new BrokerHttpClient({origin:enrolled.body.agentConnection.brokerOrigin,clientToken:enrolled.body.agentConnection.clientToken});
  await assert.rejects(client.pay({id:order.id}));assert.equal(signs,1);assert.equal(settles,1);
  assert.equal((await client.inspect(order.id)).state,'confirmed');
  const unknownId=randomUUID(),unknownOrder={...order,id:unknownId,resourceURL:grant.merchantOrigin+'/orders/'+unknownId,quoteId:randomUUID()};
  writeFileSync(join(config.orderDirectory,unknownId+'.json'),JSON.stringify(unknownOrder),{mode:0o600});loseNext=true;
  assert.equal((await client.pay({id:unknownId})).state,'unknown');assert.equal(signs,2);assert.equal(settles,2);
  // Provider failure must not undo the durable local stop or expose diagnostics.
  revokeFails=true;assert.equal((await request('revoke',{wallet:config.expectedWallet,approved:true})).body.error,'PROVIDER_REVOCATION_UNCONFIRMED');
  const freshId=randomUUID(),freshOrder={...order,id:freshId,resourceURL:grant.merchantOrigin+'/orders/'+freshId,quoteId:randomUUID()};
  writeFileSync(join(config.orderDirectory,freshId+'.json'),JSON.stringify(freshOrder),{mode:0o600});
  await assert.rejects(client.pay({id:freshId}));assert.equal(signs,2);assert.equal(settles,2);
  await runtime.close();runtime=null;
  // Historical grant can be inspected/reconciled even after restart, revocation
  // and expiry. This capability's listener rejects payment BEFORE order lookup.
  runtime=await startDevelopmentRuntime({config,dependencies});
  const realNow=Date.now;let recovered;
  try{
    Date.now=()=>grant.expiresAt+1000;
    const normal=await request('proposal',{wallet:config.expectedWallet});assert.equal(normal.status,409);
    recovered=await request('recover',{wallet:config.expectedWallet,approved:true});
  }finally{Date.now=realNow;}
  assert.equal(recovered.status,200);assert.equal(recovered.body.recoveryOnly,true);assert.deepEqual(recovered.body.grant,grant);
  const recoveringClient=new BrokerHttpClient({origin:recovered.body.agentConnection.brokerOrigin,clientToken:recovered.body.agentConnection.clientToken});
  assert.equal((await recoveringClient.inspect(unknownId)).state,'unknown');
  await assert.rejects(recoveringClient.pay({id:freshId}));
  assert.equal((await recoveringClient.reconcile(unknownId)).state,'confirmed');
  assert.equal(signs,2);assert.equal(settles,2);
  await runtime.close();runtime=null;
  const registry=new EnrollmentStore(join(config.stateDir,'enrollment'),{projectId:config.projectId,expectedWallet:config.expectedWallet});
  assert.deepEqual(registry.get(),grant);registry.close();
  // State contains fixed grant/ledger data, never the CDP bearer session.
  assert.equal(readFileSync(join(config.stateDir,'enrollment','enrollment.sqlite')).includes('owner.session'),false);
});
