import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {OnboardingController,validateDevelopmentConfig} from '../src/controller.ts';
import {DELEGATION_DURATION_HOURS,DEFAULT_DURATION_MS,MAX_DELEGATION_MS,isAllowedDurationMs} from '../src/duration-policy.ts';

const address='0x'+'1'.repeat(40),second='0x'+'2'.repeat(40);
const publicConfig={projectId:'11111111-1111-4111-8111-111111111111',developmentConfirmed:true};
const officialNoDelegation={statusCode:404,errorType:'not_found',errorMessage:'No active account-scoped delegation found for the specified address.'};
const sdkNoDelegation={...officialNoDelegation,errorMessage:'No active account-scoped delegation found for the specified address'};
function fixture(options={}){
  const calls=[];let user=options.preAuthenticated?{userId:'fixture-subject',evmAccountObjects:[{address},{address:second}]}:null;
  let authListener;
  let delegation=options.delegation;
  const sdk={
    initialize:async config=>{calls.push(['initialize',config]);},
    getCurrentUser:async()=>user,
    getAccessToken:async()=>{calls.push(['getAccessToken']);return 'synthetic-session';},
    onAuthStateChange:listener=>{authListener=listener;},
    signInWithEmail:async input=>{calls.push(['signInWithEmail',input]);return {flowId:'private-fixture-flow'};},
    verifyEmailOTP:async input=>{calls.push(['verifyEmailOTP',input]);if(options.verifyFails)throw Error('private OTP must not escape');user={userId:'fixture-subject',evmAccountObjects:[{address},{address:second}]};return {user};},
    getDelegationForAccount:async input=>{calls.push(['getDelegationForAccount',input]);await options.readGate;if(Object.hasOwn(options,'readError'))throw options.readError;if(options.readFails)throw {statusCode:503,errorType:'not_found',errorMessage:'private provider content'};if(!delegation)throw {statusCode:404,errorType:'delegation_not_found'};return delegation;},
    createDelegationForAccount:async input=>{calls.push(['createDelegationForAccount',input]);await options.createGate;if(options.createError)throw options.createError;if(options.createFails)throw Error('private provider content');delegation={expiresAt:options.returnedExpiry||input.expiresAt};return delegation;},
    revokeDelegationForAccount:async input=>{calls.push(['revokeDelegationForAccount',input]);await options.revokeGate;if(options.revokeError)throw options.revokeError;if(options.revokeFails)throw Error('private provider content');delegation=undefined;},
    signOut:async()=>{calls.push(['signOut']);user=null;},
  };
  const controller=new OnboardingController(sdk,options.config||publicConfig,options.url||'http://127.0.0.1:4376');
  return {controller,calls,setUser:value=>{user=value;},notifyUser:value=>{user=value;authListener?.(value);}};
}
async function signIn(f){await f.controller.initialize();await f.controller.sendCode('person@fixture.invalid');await f.controller.verifyCode('fixture-code');}
test('blank or unconfirmed project and non-loopback origins fail before any SDK initialization',async()=>{
  for(const config of [{...publicConfig,projectId:''},{...publicConfig,developmentConfirmed:false},{...publicConfig,developmentConfirmed:'true'},{...publicConfig,secret:'forbidden'}]){
    const f=fixture({config});await assert.rejects(f.controller.initialize(),/DEVELOPMENT_PROJECT_REQUIRED/);assert.equal(f.calls.length,0);
  }
  for(const url of ['https://production.example/','http://192.168.1.2:4376/','https://localhost:4376/','http://[::1]:4376/','http://127.0.0.1/','http://localhost/','http://localhost:80/','http://localhost.evil.example:4376/','http://www.localhost:4376/','http://localhost.:4376/','http://localhosT.example:4376/','http://127.0.0.2:4376/','http://127.1:4376/','http://2130706433:4376/','http://0x7f000001:4376/','http://0.0.0.0:4376/','http://user@localhost:4376/','http://user:private@localhost:4376/','http://localhost@attacker.example:4376/'])assert.throws(()=>validateDevelopmentConfig(publicConfig,url),/LOOPBACK_DEVELOPMENT_ONLY/);
  assert.doesNotThrow(()=>validateDevelopmentConfig(publicConfig,'http://127.0.0.1:4376/'));
  assert.doesNotThrow(()=>validateDevelopmentConfig(publicConfig,'http://localhost:4376/'));
});
test('exact localhost frontend initializes with analytics disabled while enrollment remains independently configured',async()=>{
  const f=fixture({url:'http://localhost:4376/'});await f.controller.initialize();
  assert.deepEqual(f.calls,[['initialize',{projectId:publicConfig.projectId,disableAnalytics:true,debugging:false,ethereum:{createOnLogin:'eoa'}}]]);
  assert.equal(f.controller.state().ready,true);assert.equal(f.controller.state().backendEnrollment,'blocked');
  assert.equal(f.controller.state().fundingAccepted,false);assert.equal(f.controller.state().paymentsEnabled,false);
  const unconfirmed=fixture({url:'http://localhost:4376/',config:{...publicConfig,developmentConfirmed:false}});
  await assert.rejects(unconfirmed.controller.initialize(),/DEVELOPMENT_PROJECT_REQUIRED/);assert.deepEqual(unconfirmed.calls,[]);
  const wrongBackend=fixture({url:'http://localhost:4376/',config:{...publicConfig,enrollmentOrigin:'http://localhost:4377'}});
  await assert.rejects(wrongBackend.controller.initialize(),/TRUSTED_ENROLLMENT_ORIGIN_REQUIRED/);assert.deepEqual(wrongBackend.calls,[]);
  assert.doesNotThrow(()=>validateDevelopmentConfig({...publicConfig,enrollmentOrigin:'http://127.0.0.1:4377'},'http://localhost:4376/'));
});
test('sign-in uses official SDK functions; OTP/email stay out of public state and login grants nothing',async()=>{
  const f=fixture();await signIn(f);const state=f.controller.state();assert.equal(state.authenticated,true);assert.equal(state.selected,address);
  assert.equal(f.calls.filter(([method])=>method==='createDelegationForAccount').length,0);
  assert.deepEqual(f.calls[0],['initialize',{projectId:publicConfig.projectId,disableAnalytics:true,debugging:false,ethereum:{createOnLogin:'eoa'}}]);
  assert.equal(state.fundingAccepted,false);assert.equal(state.paymentsEnabled,false);assert.equal(state.backendEnrollment,'blocked');
  const serialized=JSON.stringify(state);for(const privateValue of ['person@fixture.invalid','fixture-code','private-fixture-flow','fixture-subject'])assert.ok(!serialized.includes(privateValue));
});
test('code verification needs an in-memory flow and provider errors are redacted',async()=>{
  const f=fixture({verifyFails:true});await f.controller.initialize();await assert.rejects(f.controller.verifyCode('private'),/REQUEST_CODE_FIRST/);
  await f.controller.sendCode('person@fixture.invalid');await assert.rejects(f.controller.verifyCode('private'),error=>error.message==='PROVIDER_OPERATION_UNCONFIRMED'&&!JSON.stringify(error).includes('private'));
  assert.equal(f.controller.state().authenticated,false);
});
test('grant requires separate explicit consent and only exact supported hour durations',async()=>{
  const f=fixture();await signIn(f);
  for(const [hours,consent] of [[24,false],[720,false],[2160,false],[25,true],[0,true],[NaN,true],[Infinity,true],[719,true],[721,true],[2159,true],[2161,true],[1.5,true],['720',true],[1,'true']])await assert.rejects(f.controller.grantDelegation(hours,consent),/EXPLICIT_BOUNDED_DELEGATION_REQUIRED/);
  assert.equal(f.calls.filter(([method])=>method==='createDelegationForAccount').length,0);
  const before=Date.now();await f.controller.grantDelegation(24,true);const request=f.calls.find(([method])=>method==='createDelegationForAccount')[1];
  assert.equal(request.address,address);assert.ok(Date.parse(request.expiresAt)>=before+24*3600000);assert.ok(Date.parse(request.expiresAt)<=Date.now()+24*3600000);
  assert.deepEqual(Object.keys(request).sort(),['address','expiresAt']);assert.equal(f.controller.state().delegation.status,'active');
  await assert.rejects(f.controller.grantDelegation(1,true),/REVIEW_EXISTING_DELEGATION/);assert.equal(f.calls.filter(([method])=>method==='createDelegationForAccount').length,1);
});
test('duration policy freezes the exact choices, 30-day default and 90-day maximum',()=>{
  assert.deepEqual(DELEGATION_DURATION_HOURS,[1,4,24,720,2160]);assert.ok(Object.isFrozen(DELEGATION_DURATION_HOURS));
  assert.equal(DEFAULT_DURATION_MS,30*86400000);assert.equal(MAX_DELEGATION_MS,90*86400000);
  assert.throws(()=>DELEGATION_DURATION_HOURS.push(48),TypeError);
  for(const hours of DELEGATION_DURATION_HOURS)assert.equal(isAllowedDurationMs(hours*3600000),true);
  for(const value of [0,-3600000,7200000,DEFAULT_DURATION_MS-1,DEFAULT_DURATION_MS+1,MAX_DELEGATION_MS+1,NaN,Infinity,'2592000000',null,undefined])assert.equal(isAllowedDurationMs(value),false);
});
test('every supported duration requests its exact expiry only after explicit action and consent',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  for(const hours of DELEGATION_DURATION_HOURS){
    const f=fixture({preAuthenticated:true});await f.controller.initialize();
    assert.deepEqual(f.calls.map(([name])=>name),['initialize']);
    await f.controller.grantDelegation(hours,true);
    const requests=f.calls.filter(([name])=>name==='createDelegationForAccount');assert.equal(requests.length,1);
    assert.deepEqual(requests[0][1],{address,expiresAt:new Date(now+hours*3600000).toISOString()});
    assert.equal(f.controller.state().delegation.expiresAt,requests[0][1].expiresAt);
    assert.equal(f.controller.state().fundingAccepted,false);assert.equal(f.controller.state().paymentsEnabled,false);
  }
});
test('long-term provider shortening, extension, expired or invalid expiry is never silent success',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  for(const hours of [720,2160])for(const returnedExpiry of [new Date(now+3600000).toISOString(),new Date(now+hours*3600000-1).toISOString(),new Date(now+hours*3600000+1).toISOString(),new Date(now).toISOString(),'invalid']){
    const f=fixture({preAuthenticated:true,returnedExpiry});await f.controller.initialize();
    await assert.rejects(f.controller.grantDelegation(hours,true),/DELEGATION_RESPONSE_REQUIRES_REVIEW/);
    assert.equal(f.controller.state().delegation.status,'unknown');assert.equal(f.controller.state().connectionAvailable,false);
    assert.equal(f.calls.filter(([name])=>name==='createDelegationForAccount').length,1,'never retry with a shorter duration');
  }
});
test('a pre-existing shorter delegation retains its original expiry and is never renewed to the default',async()=>{
  const expiresAt=new Date(Date.now()+3600000).toISOString();const f=fixture({preAuthenticated:true,delegation:{expiresAt}});
  await f.controller.initialize();await f.controller.refreshDelegation();
  await assert.rejects(f.controller.grantDelegation(DEFAULT_DURATION_MS/3600000,true),/REVIEW_EXISTING_DELEGATION/);
  assert.equal(f.controller.state().delegation.expiresAt,expiresAt);
  assert.equal(f.calls.some(([name])=>name==='createDelegationForAccount'),false);
});
test('unknown delegation status is not absence and cannot permit a new grant',async()=>{
  const f=fixture({readFails:true});await signIn(f);await assert.rejects(f.controller.grantDelegation(1,true),/DELEGATION_STATUS_UNCONFIRMED/);
  assert.equal(f.controller.state().delegation.status,'unknown');assert.equal(f.calls.some(([method])=>method==='createDelegationForAccount'),false);
});
test('only the two exact official GET absence literals are none; reading never grants and consent remains mandatory',async()=>{
  for(const readError of [officialNoDelegation,sdkNoDelegation]){
  const f=fixture({readError});await signIn(f);await f.controller.refreshDelegation();
  assert.equal(f.controller.state().delegation.status,'none');
  assert.equal(f.calls.some(([method])=>method==='createDelegationForAccount'),false);
  await assert.rejects(f.controller.grantDelegation(1,false),/EXPLICIT_BOUNDED_DELEGATION_REQUIRED/);
  assert.equal(f.calls.some(([method])=>method==='createDelegationForAccount'),false);
  await f.controller.grantDelegation(1,true);
  assert.equal(f.controller.state().delegation.status,'active');
  assert.equal(f.calls.filter(([method])=>method==='createDelegationForAccount').length,1);
  assert.equal(f.controller.state().fundingAccepted,false);assert.equal(f.controller.state().paymentsEnabled,false);
  assert.equal(f.controller.state().connectionAvailable,false);
  assert.ok(!JSON.stringify(f.controller.state()).includes(readError.errorMessage));
  }
});
test('generic or similar GET errors stay unknown and cannot authorize creation',async()=>{
  for(const readError of [
    {...officialNoDelegation,errorMessage:'API not found.'},
    {...officialNoDelegation,errorMessage:'<html>404 Not Found</html>'},
    {...officialNoDelegation,errorMessage:officialNoDelegation.errorMessage+' '},
    {...officialNoDelegation,errorMessage:officialNoDelegation.errorMessage.toLowerCase()},
    {...sdkNoDelegation,errorMessage:sdkNoDelegation.errorMessage+' '},
    {...sdkNoDelegation,errorMessage:' '+sdkNoDelegation.errorMessage},
    {...sdkNoDelegation,errorMessage:sdkNoDelegation.errorMessage.toLowerCase()},
    {...officialNoDelegation,errorMessage:''},
    {...officialNoDelegation,errorMessage:undefined},
    {...officialNoDelegation,statusCode:401},
    {...officialNoDelegation,statusCode:503},
    {...officialNoDelegation,statusCode:'404'},
    {...officialNoDelegation,errorType:'not_enabled'},
    {...officialNoDelegation,errorType:'not_authorized'},
    {statusCode:404},'<html>404 Not Found</html>',new Error('private transport failure'),null,
  ]){
    const f=fixture({readError});await signIn(f);
    await assert.rejects(f.controller.refreshDelegation(),error=>error.message==='DELEGATION_STATUS_UNCONFIRMED');
    assert.equal(f.controller.state().delegation.status,'unknown');
    await assert.rejects(f.controller.grantDelegation(1,true),/DELEGATION_STATUS_UNCONFIRMED/);
    assert.equal(f.calls.some(([method])=>method==='createDelegationForAccount'),false);
  }
});
test('official GET absence cannot cross a changed or no-longer-owned authenticated account',async()=>{
  const notOwned=fixture({preAuthenticated:true,readError:officialNoDelegation});await notOwned.controller.initialize();
  notOwned.setUser({userId:'fixture-subject',evmAccountObjects:[{address:second}]});
  await assert.rejects(notOwned.controller.refreshDelegation(),/AUTHENTICATED_ACCOUNT_CHANGED/);
  assert.equal(notOwned.calls.some(([method])=>method==='getDelegationForAccount'),false);
  for(const notify of [false,true]){
    let release;const readGate=new Promise(resolve=>{release=resolve;});
    const f=fixture({preAuthenticated:true,readError:officialNoDelegation,readGate});await f.controller.initialize();
    const pending=f.controller.refreshDelegation();
    for(let i=0;i<20&&!f.calls.some(([method])=>method==='getDelegationForAccount');i++)await Promise.resolve();
    assert.ok(f.calls.some(([method])=>method==='getDelegationForAccount'));
    const changed={userId:'different-user',evmAccountObjects:[{address:second}]};
    if(notify)f.notifyUser(changed);else f.setUser(changed);
    release();await assert.rejects(pending,/AUTHENTICATED_ACCOUNT_CHANGED/);
    assert.equal(f.controller.state().selected,second);assert.equal(f.controller.state().delegation.status,'unchecked');
    assert.equal(f.calls.some(([method])=>method==='createDelegationForAccount'),false);
  }
});
test('create and revoke 404/409 are unconfirmed, never GET absence or successful automatic retries',async()=>{
  for(const error of [officialNoDelegation,sdkNoDelegation,{statusCode:404,errorType:'not_found',errorMessage:'End user account not found.'},{statusCode:409,errorType:'already_exists',errorMessage:'synthetic conflict'}]){
    const f=fixture({readError:officialNoDelegation,createError:error});await signIn(f);
    await assert.rejects(f.controller.grantDelegation(1,true),failure=>failure.message==='PROVIDER_OPERATION_UNCONFIRMED');
    assert.equal(f.controller.state().delegation.status,'unknown');
    assert.equal(f.calls.filter(([method])=>method==='createDelegationForAccount').length,1);
    assert.equal(f.controller.state().connectionAvailable,false);
    const revoke=fixture({revokeError:error});await signIn(revoke);
    await assert.rejects(revoke.controller.revokeDelegation(),failure=>failure.message==='PROVIDER_OPERATION_UNCONFIRMED');
    assert.equal(revoke.controller.state().delegation.status,'unknown');
    assert.equal(revoke.calls.filter(([method])=>method==='revokeDelegationForAccount').length,1);
  }
});
test('account choice comes from signed-in account objects and switching users invalidates a pending selection',async()=>{
  const f=fixture();await signIn(f);assert.throws(()=>f.controller.selectAccount('0x'+'9'.repeat(40)),/AUTHENTICATED_ACCOUNT_REQUIRED/);
  f.controller.selectAccount(second);await f.controller.grantDelegation(1,true);assert.equal(f.calls.find(([method])=>method==='createDelegationForAccount')[1].address,second);
  f.setUser({userId:'different-user',evmAccountObjects:[{address}]});await assert.rejects(f.controller.revokeDelegation(),/AUTHENTICATED_ACCOUNT_CHANGED/);
  assert.equal(f.calls.some(([method])=>method==='revokeDelegationForAccount'),false);
});
test('concurrent clicks cannot create duplicate delegation or change its account',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=fixture({createGate:gate});await signIn(f);
  const grant=f.controller.grantDelegation(1,true);await assert.rejects(f.controller.grantDelegation(1,true),/OPERATION_IN_PROGRESS/);
  assert.throws(()=>f.controller.selectAccount(second),/OPERATION_IN_PROGRESS/);release();await grant;
  assert.equal(f.calls.filter(([method])=>method==='createDelegationForAccount').length,1);
});
test('account-scoped revocation is separate from signout and provider failure is never reported revoked',async()=>{
  const f=fixture();await signIn(f);await f.controller.grantDelegation(1,true);await f.controller.revokeDelegation();assert.equal(f.controller.state().delegation.status,'revoked');
  assert.deepEqual(f.calls.find(([method])=>method==='revokeDelegationForAccount')[1],{address});
  await f.controller.signOut();assert.equal(f.controller.state().authenticated,false);assert.equal(f.controller.state().accounts.length,0);
  const failed=fixture({revokeFails:true});await signIn(failed);await assert.rejects(failed.controller.revokeDelegation(),/PROVIDER_OPERATION_UNCONFIRMED/);assert.equal(failed.controller.state().delegation.status,'unknown');
});
test('unexpected expiry and lost create response remain reviewable; revoke stays available',async()=>{
  for(const options of [{returnedExpiry:new Date(Date.now()+48*3600000).toISOString()},{createFails:true}]){
    const f=fixture(options);await signIn(f);await assert.rejects(f.controller.grantDelegation(1,true));assert.equal(f.controller.state().delegation.status,'unknown');
    await f.controller.revokeDelegation();assert.equal(f.controller.state().delegation.status,'revoked');
  }
});
test('late delegation read/create/revoke cannot update a different user or signed-out account',async()=>{
  for(const [gateName,method,operation] of [
    ['readGate','getDelegationForAccount',c=>c.refreshDelegation()],
    ['createGate','createDelegationForAccount',c=>c.grantDelegation(1,true)],
    ['revokeGate','revokeDelegationForAccount',c=>c.revokeDelegation()],
  ])for(const nextUser of [null,{userId:'different-user',evmAccountObjects:[{address:second}]}]){
    let release;const gate=new Promise(resolve=>{release=resolve;});const f=fixture({preAuthenticated:true,[gateName]:gate});
    await f.controller.initialize();const pending=operation(f.controller);
    for(let i=0;i<20&&!f.calls.some(([name])=>name===method);i++)await Promise.resolve();
    assert.ok(f.calls.some(([name])=>name===method));
    f.notifyUser(nextUser);release();await assert.rejects(pending,/AUTHENTICATED_ACCOUNT_CHANGED/);
    assert.equal(f.controller.state().delegation.status,'unchecked');
    assert.equal(f.controller.state().selected,nextUser?second:undefined);
    assert.equal(f.controller.connection(),undefined);
  }
});
test('UI has separate mandate consent and honest warnings; email/OTP forms never submit credentials',()=>{
  const root=new URL('../',import.meta.url),html=fs.readFileSync(new URL('index.html',root),'utf8'),main=fs.readFileSync(new URL('src/main.ts',root),'utf8');
  assert.match(html,/Testnet only/);assert.match(html,/Funding is not accepted/);assert.match(html,/another project, including AWAL, can have a different wallet/);
  assert.match(html,/No real provider or payment acceptance is established/);assert.match(html,/not restricted to testnet, USDC, a recipient or a spending budget/);
  assert.match(html,/id="consent" type="checkbox"/);assert.match(main,/createDelegationForAccount/);assert.match(main,/revokeDelegationForAccount/);
  assert.match(html,/id="mandate-consent" type="checkbox"/);assert.match(html,/id="revoke-consent" type="checkbox"/);
  // Native fallback form submissions must carry neither email nor OTP if the
  // module is unavailable; SDK calls read these unnamed inputs in memory only.
  assert.doesNotMatch(html,/<input[^>]*name=/);
  for(const source of [html,main])for(const pattern of [/console\./,/localStorage/,/sessionStorage/,/fetch\(/,/sendBeacon/,/CDP_API_KEY/,/CDP_WALLET_SECRET/,/signEvmTypedData/,/sendEvmTransaction/,/createKeyExportIframe/])assert.doesNotMatch(source,pattern);
  assert.match(main,/event.preventDefault\(\)/);
});
