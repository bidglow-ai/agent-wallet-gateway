import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {OnboardingController,OnboardingError} from '../src/controller.ts';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
// Execute the actual UI module and its event bindings, using the real controller
// and a synthetic SDK/DOM. No browser, credentials, email, OTP or provider call.
const compiled=ts.transpileModule(source.replaceAll('import.meta.env','fixtureEnvironment'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const address='0x'+'1'.repeat(40),otherAddress='0x'+'2'.repeat(40);
const user={userId:'synthetic-user',evmAccountObjects:[{address}]};
const otherUser={userId:'synthetic-other',evmAccountObjects:[{address:otherAddress}]};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
class Element{
  value='';textContent='';disabled=false;readOnly=false;checked=false;handlers=new Map();children=[];
  addEventListener(name,callback){this.handlers.set(name,callback);}
  replaceChildren(...children){this.children=children;}
  focus(){}
  emit(name){const callback=this.handlers.get(name);assert.ok(callback,`missing real UI handler: ${name}`);callback({preventDefault(){}});}
}
async function fixture(options={}){
  const elements=new Map();
  for(const match of html.matchAll(/<([a-z-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
    const element=new Element();element.disabled=/\bdisabled\b/.test(match[2]);
    element.readOnly=/\breadonly\b/.test(match[2]);elements.set(match[3],element);
  }
  elements.get('hours').value='1';
  const calls=[];let currentUser=null,listener,controller,request=0;
  const sdk={
    initialize:async config=>{calls.push(['initialize',config]);},getCurrentUser:async()=>currentUser,
    onAuthStateChange:callback=>{listener=callback;},
    signInWithEmail:async input=>{
      calls.push(['send',input]);const flowId='synthetic-flow-'+(++request);
      await options.sendGate?.promise;
      if(options.sendFails)throw Error('private provider detail');
      return{flowId};
    },
    verifyEmailOTP:async input=>{
      calls.push(['verify',input]);await options.verifyGate?.promise;
      if(options.verifyFails)throw options.verifyError||Error('private provider detail');
      const resultUser=Object.hasOwn(options,'verifyUser')?options.verifyUser:user;
      if(!options.staleVerify)currentUser=resultUser;
      if(options.notifyBeforeVerify)listener?.(currentUser);
      return{user:resultUser};
    },
    signOut:async()=>{calls.push(['signOut']);if(options.signOutFails)throw Error('private provider detail');currentUser=null;},
    getDelegationForAccount:async()=>assert.fail('sign-in must not inspect delegation'),
    createDelegationForAccount:async()=>assert.fail('sign-in must not grant delegation'),
    revokeDelegationForAccount:async()=>assert.fail('sign-in must not revoke delegation'),
    getAccessToken:async()=>assert.fail('sign-in must not enroll a backend mandate'),
  };
  const context={
    exports:{},fixtureEnvironment:{VITE_CDP_PROJECT_ID:'11111111-1111-4111-8111-111111111111',VITE_DEVELOPMENT_PROJECT_CONFIRMED:'true',VITE_ENROLLMENT_ORIGIN:''},
    window:{location:{href:'http://localhost:4376/'}},document:{getElementById:id=>elements.get(id),createElement:()=>new Element()},
    Option:class extends Element{constructor(text,value){super();this.textContent=text;this.value=value;}},
    fetch:()=>assert.fail('the real UI must not call an application backend'),setInterval:()=>0,
    require(name){
      if(name==='@coinbase/cdp-core')return sdk;
      if(name==='./controller.ts')return{OnboardingError,OnboardingController:class extends OnboardingController{constructor(...args){super(...args);controller=this;}}};
      if(name==='./style.css')return{};
      throw Error('Unexpected module '+name);
    },
  };
  vm.runInNewContext(compiled,context,{filename:'email-onboarding-main-ui-fixture.js'});
  await flush();
  return{options,calls,controller,el:id=>elements.get(id),notify(value){currentUser=value;listener?.(value);}};
}
function send(f,email='person@fixture.invalid'){f.el('email').value=email;f.el('email-form').emit('submit');}
function verify(f,code='synthetic-code'){f.el('otp').value=code;f.el('otp-form').emit('submit');}
function noAuthority(f){
  assert.equal(f.controller.state().fundingAccepted,false);assert.equal(f.controller.state().paymentsEnabled,false);
  assert.equal(f.controller.state().connectionAvailable,false);
  assert.equal(f.calls.some(([name])=>!['initialize','send','verify','signOut'].includes(name)),false);
  const state=JSON.stringify(f.controller.state());assert.doesNotMatch(state,/person@fixture|synthetic-code|synthetic-flow|private provider/);
}

test('sending keeps the email visible, blocks double submit and ignores unchanged signed-out notifications',async()=>{
  const gate=deferred(),f=await fixture({sendGate:gate});
  send(f);assert.equal(f.el('email').value,'person@fixture.invalid');assert.equal(f.el('email').disabled,true);
  send(f);assert.equal(f.calls.filter(([name])=>name==='send').length,1);
  f.notify(null);gate.resolve();await flush();
  assert.equal(f.controller.state().awaitingCode,true);assert.equal(f.el('email').value,'person@fixture.invalid');
  assert.equal(f.el('email').readOnly,true);assert.equal(f.el('email').disabled,false);
  assert.equal(f.el('change-email').disabled,false);assert.equal(f.el('otp').disabled,false);
  assert.match(f.el('status').textContent,/latest code/);noAuthority(f);
});

test('failed send preserves the entered email and allows one explicit retry without exposing errors',async()=>{
  const f=await fixture({sendFails:true});send(f);await flush();
  assert.equal(f.el('email').value,'person@fixture.invalid');assert.equal(f.el('email').disabled,false);
  assert.equal(f.el('email').readOnly,false);assert.equal(f.el('otp').disabled,true);
  assert.doesNotMatch(f.el('status').textContent,/private provider/);
  f.options.sendFails=false;f.el('email-form').emit('submit');await flush();
  assert.equal(f.controller.state().awaitingCode,true);assert.equal(f.el('email').value,'person@fixture.invalid');noAuthority(f);
});

test('failed verify keeps the bound email and retry flow, clears OTP and trims only pasted edge whitespace',async()=>{
  const f=await fixture({verifyFails:true,verifyError:{errorType:'otp_verification_code_invalid',errorMessage:'private provider detail'}});
  send(f);await flush();verify(f,'  synthetic-code  ');await flush();
  assert.equal(f.el('email').value,'person@fixture.invalid');assert.equal(f.el('email').readOnly,true);
  assert.equal(f.el('otp').value,'');assert.equal(f.el('otp').disabled,false);
  assert.equal(f.controller.state().awaitingCode,true);assert.equal(f.controller.state().authenticated,false);
  assert.equal(f.calls.find(([name])=>name==='verify')[1].otp,'synthetic-code');
  assert.match(f.el('status').textContent,/Sign-in was not confirmed.*latest verification code/);
  assert.doesNotMatch(f.el('status').textContent,/private provider/);
  f.options.verifyFails=false;verify(f,'  second code  ');await flush();
  assert.equal(f.calls.filter(([name])=>name==='verify')[1][1].otp,'second code','internal code whitespace is not rewritten');
  assert.equal(f.controller.state().authenticated,true);assert.equal(f.controller.state().awaitingCode,false);
  assert.equal(f.el('email').value,'');assert.equal(f.el('otp').value,'');noAuthority(f);
});

test('resend remains bound to the displayed email; changing email explicitly cancels the old local flow',async()=>{
  const f=await fixture();send(f);await flush();
  f.el('email').value='unrequested@fixture.invalid';f.el('email-form').emit('submit');await flush();
  assert.equal(f.calls.filter(([name])=>name==='send')[1][1].email,'person@fixture.invalid');
  assert.equal(f.el('email').value,'person@fixture.invalid');verify(f);await flush();
  assert.equal(f.calls.find(([name])=>name==='verify')[1].flowId,'synthetic-flow-2');
  const pending=await fixture();send(pending);await flush();pending.el('change-email').emit('click');
  assert.equal(pending.controller.state().awaitingCode,false);assert.equal(pending.el('email').readOnly,false);
  verify(pending);await flush();assert.equal(pending.calls.some(([name])=>name==='verify'),false);
  send(pending,'different@fixture.invalid');await flush();
  assert.equal(pending.el('email').value,'different@fixture.invalid');assert.equal(pending.controller.state().awaitingCode,true);noAuthority(pending);
});

test('normal SDK auth notification before verify resolves is successful, not a false stale-flow failure',async()=>{
  const f=await fixture({notifyBeforeVerify:true});send(f);await flush();verify(f);await flush();
  assert.equal(f.controller.state().authenticated,true);assert.equal(f.controller.state().selected,address);
  assert.equal(f.el('email').value,'');assert.equal(f.el('otp').value,'');
  assert.match(f.el('status').textContent,/Signed in locally through Coinbase/);
  assert.doesNotMatch(f.el('status').textContent,/not confirmed|account changed/);noAuthority(f);
});

test('a verify response without a nonempty user ID never claims signed-in success or grants authority',async()=>{
  for(const verifyUser of [null,{}, {userId:''}, {userId:'   '}, {userId:42}]){
    const f=await fixture({verifyUser});send(f);await flush();verify(f);await flush();
    assert.equal(f.controller.state().authenticated,false);assert.equal(f.controller.state().awaitingCode,true);
    assert.equal(f.el('email').value,'person@fixture.invalid');assert.equal(f.el('otp').value,'');
    assert.match(f.el('status').textContent,/Sign-in was not confirmed/);
    assert.doesNotMatch(f.el('status').textContent,/Signed in locally/);noAuthority(f);
  }
});

test('an unconfirmed resend disables the old code instead of pairing it with a newer request',async()=>{
  const f=await fixture();send(f);await flush();f.options.sendFails=true;f.el('email-form').emit('submit');await flush();
  assert.equal(f.el('email').value,'person@fixture.invalid');assert.equal(f.controller.state().awaitingCode,false);
  assert.equal(f.el('otp').disabled,true);verify(f);await flush();
  assert.equal(f.calls.some(([name])=>name==='verify'),false);noAuthority(f);
});

test('identity change during send clears the UI and a late response cannot resurrect a pending code',async()=>{
  const gate=deferred(),f=await fixture({sendGate:gate});send(f);f.notify(otherUser);
  assert.equal(f.el('email').value,'');gate.resolve();await flush();
  assert.equal(f.controller.state().awaitingCode,false);assert.equal(f.controller.state().selected,otherAddress);
  assert.equal(f.el('email').value,'');assert.equal(f.el('otp').value,'');noAuthority(f);
});

test('identity change during verify prevents a late response replacing the new account; duplicate verify is ignored',async()=>{
  const gate=deferred(),f=await fixture({verifyGate:gate,staleVerify:true});send(f);await flush();verify(f);verify(f,'duplicate');
  assert.equal(f.calls.filter(([name])=>name==='verify').length,1);
  f.notify(otherUser);assert.equal(f.el('email').value,'');assert.equal(f.el('otp').value,'');
  gate.resolve();await flush();assert.equal(f.controller.state().selected,otherAddress);
  assert.equal(f.controller.state().authenticated,true);assert.equal(f.controller.state().awaitingCode,false);
  assert.match(f.el('status').textContent,/account changed/);noAuthority(f);
});

test('sign-out attempt clears temporary sign-in inputs even when provider sign-out is unconfirmed',async()=>{
  for(const signOutFails of [false,true]){
    const f=await fixture({signOutFails});send(f);await flush();verify(f);await flush();
    f.el('email').value='temporary@fixture.invalid';f.el('otp').value='temporary';f.el('sign-out').emit('click');
    assert.equal(f.el('email').value,'');assert.equal(f.el('otp').value,'');await flush();noAuthority(f);
  }
  assert.ok(html.indexOf('id="otp-form"')<html.indexOf('id="status"'));
  assert.ok(html.indexOf('id="status"')<html.indexOf('id="account-heading"'),'feedback stays next to sign-in forms');
  assert.match(html,/<p id="status" role="status" aria-live="polite">/);
});
