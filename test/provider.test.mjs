import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AwalProvider} from '../src/provider.mjs';
function provider(t, executor, version='2.12.2') {
  const dir=mkdtempSync(join(tmpdir(),'wallet-provider-test-'));mkdirSync(join(dir,'dist'));
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'awal',version}));
  writeFileSync(join(dir,'dist/index.js'),'// isolated provider fixture, not a wallet');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return new AwalProvider(join(dir,'dist/index.js'),executor);
}
test('version mismatch rejects provider before launching',t=>{
  assert.throws(()=>provider(t,()=>assert.fail(), '0.0.0'),/AWAL_VERSION_UNVERIFIED/);
});
test('status strips account email and provider extras',async t=>{
  const p=provider(t,async()=>({stdout:JSON.stringify({server:{running:true},auth:{authenticated:false,email:'private@example.invalid'},secret:'redact'})}));
  assert.deepEqual(await p.status(),{running:true,authenticated:false});
});
test('execFile passes exact arguments with no shell and bounded output',async t=>{
  const calls=[];const p=provider(t,async(...args)=>{calls.push(args);return{stdout:JSON.stringify({address:'0x1111111111111111111111111111111111111111'})};});
  await p.address();const [command,args,options]=calls[0];
  assert.equal(command,process.execPath);assert.deepEqual(args.slice(1),['address','--chain','base','--json']);
  assert.equal(options.shell,undefined);assert.equal(options.maxBuffer,1048576);assert.equal(options.timeout,30000);
});
test('invalid output and thrown subprocess diagnostics do not leak secrets',async t=>{
  const p=provider(t,async()=>{throw new Error('sensitive-example-value');});
  await assert.rejects(()=>p.status(),e=>e.code==='PROVIDER_OUTCOME_UNCONFIRMED'&&!e.message.includes('sensitive-example-value'));
  const q=provider(t,async()=>({stdout:'not JSON; sensitive-example-value'}));
  await assert.rejects(()=>q.status(),/PROVIDER_RESPONSE_UNVERIFIED/);
});
test('balance only returns canonical USDC atomic units',async t=>{
  const p=provider(t,async()=>({stdout:JSON.stringify({balances:{USDC:{raw:'5000000'}}})}));
  assert.deepEqual(await p.balance(),{network:'base',asset:'USDC',amountAtomic:'5000000'});
  const q=provider(t,async()=>({stdout:JSON.stringify({balances:{USDC:{raw:'5e6'}}})}));
  await assert.rejects(()=>q.balance(),/BALANCE_UNVERIFIED/);
});
