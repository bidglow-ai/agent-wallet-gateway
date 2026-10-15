import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {importCdpFiles,buildOperatorFiles,setupErrorCode} from '../src/unattended/setup-files.mjs';
import {loadOperatorBundle,validateOperatorConfig} from '../src/unattended/runtime.mjs';
import {DELEGATION_DURATION_HOURS,DEFAULT_DURATION_MS,MAX_DELEGATION_MS} from '../src/unattended/duration-policy.mjs';

const REPOSITORY=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
const CLI=fileURLToPath(new URL('../scripts/development-setup.mjs',import.meta.url));
function privateWrite(path,value){writeFileSync(path,value,{mode:0o600});return path;}
function jsonWrite(path,value){return privateWrite(path,JSON.stringify(value));}
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'unattended-setup-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const ed=generateKeyPairSync('ed25519'),jwk=ed.privateKey.export({format:'jwk'});
  const apiKeyId=randomUUID(),apiKeySecret=Buffer.concat([Buffer.from(jwk.d,'base64url'),Buffer.from(jwk.x,'base64url')]).toString('base64');
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),walletSecret=ec.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
  const apiKeyFile=jsonWrite(join(directory,'api.json'),{id:apiKeyId,privateKey:apiKeySecret});
  const walletSecretFile=privateWrite(join(directory,'wallet.txt'),'\n '+walletSecret+' \r\n'),outputFile=join(directory,'cdp.json');
  const config={developmentProjectConfirmed:true,projectId:randomUUID(),expectedWallet:'0x'+'1'.repeat(40),payTo:'0x'+'2'.repeat(40),
    merchantOrigin:'https://synthetic-merchant.invalid',perCallAtomic:'5000000',totalAtomic:'10000000',durationMs:3600000,
    policyId:'policy_synthetic_setup',merchantAccount:'acct_syntheticsetup',fromBlock:'0',stateDir:join(directory,'state'),orderDirectory:join(directory,'orders'),
    onboardingOrigin:'http://127.0.0.1:4376',enrollmentPort:4377};
  return {directory,apiKeyId,apiKeySecret,walletSecret,apiKeyFile,walletSecretFile,outputFile,config};
}
function rejected(fn,marker){
  assert.throws(fn,error=>/^SETUP_[A-Z_]+$/.test(error.code)&&error.message===error.code&&(!marker||!JSON.stringify(error).includes(marker)));
}
function importArgs(f){return {apiKeyFile:f.apiKeyFile,walletSecretFile:f.walletSecretFile,outputFile:f.outputFile};}
function buildArgs(f){
  importCdpFiles(importArgs(f));
  return {configFile:jsonWrite(join(f.directory,'config.json'),f.config),cdpFile:f.outputFile,
    stripeKeyFile:privateWrite(join(f.directory,'stripe.txt'),'\n sk_test_'+'S'.repeat(25)+'\r\n'),outputFile:join(f.directory,'operator.json')};
}
test('official id/name exports and explicit normalized keys preserve API values and trim only text boundaries',t=>{
  const f=fixture(t);
  const result=importCdpFiles(importArgs(f));assert.deepEqual(Object.values(result).map(value=>typeof value),['boolean','boolean','boolean','boolean']);
  assert.deepEqual(JSON.parse(readFileSync(f.outputFile,'utf8')),{apiKeyId:f.apiKeyId,apiKeySecret:f.apiKeySecret,walletSecret:f.walletSecret});
  assert.equal(lstatSync(f.outputFile).mode&0o777,0o600);
  for(const input of [{name:`organizations/${randomUUID()}/apiKeys/${f.apiKeyId}`,privateKey:f.apiKeySecret},{apiKeyId:f.apiKeyId,apiKeySecret:f.apiKeySecret}]){
    jsonWrite(f.apiKeyFile,input);const outputFile=join(f.directory,randomUUID()+'.json');importCdpFiles({...importArgs(f),outputFile});
    assert.equal(JSON.parse(readFileSync(outputFile,'utf8')).apiKeySecret,f.apiKeySecret);
  }
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'pkcs8'});
  jsonWrite(f.apiKeyFile,{id:f.apiKeyId,privateKey:ec});
  const outputFile=join(f.directory,'ec.json');importCdpFiles({...importArgs(f),outputFile});assert.equal(JSON.parse(readFileSync(outputFile,'utf8')).apiKeySecret,ec);
});
test('build validates and writes an exclusive bundle accepted by the existing runtime without starting it',t=>{
  const f=fixture(t),args=buildArgs(f),result=buildOperatorFiles(args);
  assert.equal(result.operatorBuilt,true);assert.equal(result.providerConfigurationVerified,false);assert.equal(result.paymentInitiated,false);
  assert.deepEqual(loadOperatorBundle(args.outputFile).config,f.config);
  assert.equal(lstatSync(args.outputFile).mode&0o777,0o600);
  assert.equal(existsSync(f.config.stateDir),false);assert.equal(existsSync(f.config.orderDirectory),false);
  const before=readFileSync(args.outputFile);rejected(()=>buildOperatorFiles(args));assert.deepEqual(readFileSync(args.outputFile),before);
});
test('offline operator build supports exact30/90day and legacy short durations without starting the provider',t=>{
  const f=fixture(t),args=buildArgs(f);
  for(const hours of DELEGATION_DURATION_HOURS){
    const config={...f.config,durationMs:hours*3600000},outputFile=join(f.directory,'operator-'+hours+'.json');
    jsonWrite(args.configFile,config);assert.equal(buildOperatorFiles({...args,outputFile}).operatorBuilt,true);
    assert.equal(loadOperatorBundle(outputFile).config.durationMs,config.durationMs);
  }
  assert.equal(existsSync(f.config.stateDir),false);assert.equal(existsSync(f.config.orderDirectory),false);
});
test('unsafe or missing parents/files, file symlinks, hardlinks and oversized reads fail without output',t=>{
  for(const mutate of [f=>chmodSync(f.directory,0o755),f=>chmodSync(f.directory,0o777),f=>chmodSync(f.apiKeyFile,0o644),f=>rmSync(f.apiKeyFile),
    f=>{const saved=join(f.directory,'saved.json');privateWrite(saved,readFileSync(f.apiKeyFile));rmSync(f.apiKeyFile);symlinkSync(saved,f.apiKeyFile);},
    f=>linkSync(f.apiKeyFile,join(f.directory,'hard.json')),f=>privateWrite(f.apiKeyFile,'x'.repeat(16385)),
    f=>privateWrite(f.walletSecretFile,'x'.repeat(8193))]){
    const f=fixture(t);mutate(f);rejected(()=>importCdpFiles(importArgs(f)),f.apiKeyFile);assert.equal(existsSync(f.outputFile),false);
  }
  const f=fixture(t),alias=join(f.directory,'alias');symlinkSync(f.directory,alias);
  rejected(()=>importCdpFiles({...importArgs(f),apiKeyFile:join(alias,'api.json')}));
  rejected(()=>importCdpFiles({...importArgs(f),outputFile:join(alias,'output.json')}));
  rejected(()=>importCdpFiles({...importArgs(f),outputFile:join(f.directory,'missing','out.json')}));
  rejected(()=>importCdpFiles({...importArgs(f),apiKeyFile:f.directory+'/./api.json'}));
});
test('repository paths and an ancestor symlink back into it are rejected before reading or creating',t=>{
  const f=fixture(t),linked=join(f.directory,'repository');symlinkSync(REPOSITORY,linked);
  const repoFixture=mkdtempSync(join(REPOSITORY,'.setup-boundary-test-'));t.after(()=>rmSync(repoFixture,{recursive:true,force:true}));
  const repoInput=jsonWrite(join(repoFixture,'synthetic.json'),{id:f.apiKeyId,privateKey:f.apiKeySecret});
  const repoAlias=join(linked,repoFixture.slice(REPOSITORY.length+1));
  for(const path of [repoInput,join(repoAlias,'synthetic.json')])
    rejected(()=>importCdpFiles({...importArgs(f),apiKeyFile:path}));
  for(const path of [join(repoFixture,'new-setup-private.json'),join(repoAlias,'new-setup-private.json')]){
    rejected(()=>importCdpFiles({...importArgs(f),outputFile:path}));assert.equal(existsSync(path),false);
  }
});
test('unknown/ambiguous API exports, malformed keys and wallet secrets never create credentials',t=>{
  for(const input of [{id:randomUUID(),name:'ambiguous',privateKey:'not-a-key'},{id:randomUUID(),privateKey:'not-a-key',extra:true},
    {id:randomUUID(),privateKey:'not-a-key'},{id:'placeholder',privateKey:'not-a-key'},[],null]){
    const f=fixture(t);jsonWrite(f.apiKeyFile,input);rejected(()=>importCdpFiles(importArgs(f)));assert.equal(existsSync(f.outputFile),false);
  }
  const f=fixture(t);privateWrite(f.apiKeyFile,'{malformed');rejected(()=>importCdpFiles(importArgs(f)));
  jsonWrite(f.apiKeyFile,{id:f.apiKeyId,privateKey:' '+f.apiKeySecret});rejected(()=>importCdpFiles(importArgs(f)));
  jsonWrite(f.apiKeyFile,{id:f.apiKeyId,privateKey:f.apiKeySecret});privateWrite(f.walletSecretFile,'synthetic-malformed');rejected(()=>importCdpFiles(importArgs(f)));
  assert.equal(existsSync(f.outputFile),false);
});
test('a FIFO input is rejected without blocking the isolated CLI child',t=>{
  const f=fixture(t),fifo=join(f.directory,'synthetic-fifo');
  const created=spawnSync('/usr/bin/mkfifo',['-m','600',fifo],{encoding:'utf8',timeout:3000});assert.equal(created.status,0);
  const result=spawnSync(process.execPath,[CLI,'import-cdp','--api-key-file',fifo,'--wallet-secret-file',f.walletSecretFile,'--output-file',f.outputFile],
    {env:{PATH:process.env.PATH},encoding:'utf8',timeout:3000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr),{error:'SETUP_PRIVATE_FILE_REQUIRED',fundingAccepted:false,paymentInitiated:false});assert.equal(existsSync(f.outputFile),false);
});
test('build rejects malformed/public configuration, extra credentials and live Stripe keys before output',t=>{
  const f=fixture(t),args=buildArgs(f);
  for(const config of [{...f.config,unknown:true},{...f.config,developmentProjectConfirmed:false},{...f.config,totalAtomic:'10000001'},
    {...f.config,policyId:'REPLACE_WITH_POLICY'},{...f.config,expectedWallet:'0x'+'0'.repeat(40)},{...f.config,stateDir:join(REPOSITORY,'state')}]){
    jsonWrite(args.configFile,config);rejected(()=>buildOperatorFiles(args));assert.equal(existsSync(args.outputFile),false);
  }
  jsonWrite(args.configFile,f.config);privateWrite(args.stripeKeyFile,'sk_live_'+'L'.repeat(25));rejected(()=>buildOperatorFiles(args));assert.equal(existsSync(args.outputFile),false);
  privateWrite(args.stripeKeyFile,'sk_test_'+'S'.repeat(25));chmodSync(args.configFile,0o644);rejected(()=>buildOperatorFiles(args));chmodSync(args.configFile,0o600);
  privateWrite(args.stripeKeyFile,'sk_test_'+'S'.repeat(25));jsonWrite(args.cdpFile,{apiKeyId:f.apiKeyId,apiKeySecret:f.apiKeySecret,walletSecret:f.walletSecret,extra:true});
  rejected(()=>buildOperatorFiles(args));assert.equal(existsSync(args.outputFile),false);
});
test('pure setup configuration validation never relaxes the existing runtime schema',t=>{
  const f=fixture(t),args=buildArgs(f),invalid=[];
  for(const key of Object.keys(f.config)){const missing={...f.config};delete missing[key];invalid.push(missing);}
  for(const change of [{extra:true},{developmentProjectConfirmed:1},{projectId:'not-a-uuid'},{expectedWallet:'0x'+'0'.repeat(40)},
    {payTo:'0x'+'0'.repeat(40)},{merchantOrigin:'http://merchant.invalid'},{perCallAtomic:5000000},{perCallAtomic:'5000001'},
    {perCallAtomic:'5000000',totalAtomic:'4000000'},{totalAtomic:'10000001'},{durationMs:172800000},
    ...[MAX_DELEGATION_MS+1,Infinity,NaN,String(DEFAULT_DURATION_MS),null].map(durationMs=>({durationMs})),{policyId:'invalid policy'},
    {merchantAccount:'acct_invalid_account'},{fromBlock:'01'},{stateDir:'relative'},{orderDirectory:f.config.stateDir},
    {onboardingOrigin:'http://0.0.0.0:4376'},{onboardingOrigin:'http://127.0.0.1:4376/'},{enrollmentPort:80}])invalid.push({...f.config,...change});
  for(const config of invalid){
    assert.throws(()=>validateOperatorConfig(config));jsonWrite(args.configFile,config);
    rejected(()=>buildOperatorFiles(args));assert.equal(existsSync(args.outputFile),false);
  }
});
test('an existing output, including a symlink, is never overwritten or removed',t=>{
  const f=fixture(t);privateWrite(f.outputFile,'{"syntheticSentinel":true}');const before=readFileSync(f.outputFile);
  rejected(()=>importCdpFiles(importArgs(f)));assert.deepEqual(readFileSync(f.outputFile),before);
  rmSync(f.outputFile);symlinkSync(f.apiKeyFile,f.outputFile);rejected(()=>importCdpFiles(importArgs(f)));assert.equal(lstatSync(f.outputFile).isSymbolicLink(),true);
});
test('a post-create write failure removes only the file created by that invocation',t=>{
  const f=fixture(t),sentinel=privateWrite(join(f.directory,'keep.json'),'{"keepSynthetic":true}');
  // Built-in failure injection lives in an isolated child, never shared mocks.
  const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const setup=await import(${JSON.stringify(new URL('../src/unattended/setup-files.mjs',import.meta.url).href)});
    const input=JSON.parse(process.argv[1]),original=fs.fsyncSync;
    try{fs.fsyncSync=()=>{throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');};syncBuiltinESMExports();
      try{setup.importCdpFiles(input);process.exitCode=2;}catch(error){process.stdout.write(JSON.stringify({error:setup.setupErrorCode(error),outputRemoved:!fs.existsSync(input.outputFile)}));}}
    finally{fs.fsyncSync=original;syncBuiltinESMExports();}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source,JSON.stringify(importArgs(f))],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{error:'SETUP_OUTPUT_UNCONFIRMED',outputRemoved:true});
  assert.equal(readFileSync(sentinel,'utf8'),'{"keepSynthetic":true}');assert.equal(existsSync(f.apiKeyFile),true);assert.equal(existsSync(f.outputFile),false);
});
test('CLI accepts only explicit path flags, emits boolean-only success and fixed redacted failures',t=>{
  const f=fixture(t),run=args=>spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH}});
  const result=run(['import-cdp','--api-key-file',f.apiKeyFile,'--wallet-secret-file',f.walletSecretFile,'--output-file',f.outputFile]);
  assert.equal(result.status,0);assert.equal(result.stderr,'');assert.ok(Object.values(JSON.parse(result.stdout)).every(value=>typeof value==='boolean'));
  assert.equal(result.stdout.includes(f.apiKeySecret),false);assert.equal(result.stdout.includes(f.directory),false);
  const built=fixture(t),build=buildArgs(built),builtResult=run(['build-operator','--config-file',build.configFile,'--cdp-file',build.cdpFile,'--stripe-key-file',build.stripeKeyFile,'--output-file',build.outputFile]);
  assert.equal(builtResult.status,0);assert.equal(builtResult.stderr,'');assert.ok(Object.values(JSON.parse(builtResult.stdout)).every(value=>typeof value==='boolean'));
  assert.equal(builtResult.stdout.includes(built.apiKeySecret),false);assert.equal(builtResult.stdout.includes(built.directory),false);
  const marker='SYNTHETIC_SECRET_DIAGNOSTIC_MARKER';
  for(const args of [[],['unknown',marker],['import-cdp','--secret',marker],['import-cdp','--api-key-file',marker,'--api-key-file',marker,'--output-file',marker],
    ['import-cdp','--api-key-file',f.apiKeyFile,'--wallet-secret-file',f.walletSecretFile,'--force',marker],
    ['import-cdp','--api-key-file',join(f.directory,'missing-'+marker),'--wallet-secret-file',f.walletSecretFile,'--output-file',join(f.directory,'missing-output.json')]]){
    const failed=run(args);assert.equal(failed.status,1);assert.equal(failed.stdout,'');
    const error=JSON.parse(failed.stderr);assert.match(error.error,/^(?:INVALID_SETUP_ARGUMENTS|SETUP_[A-Z_]+)$/);
    assert.equal(failed.stderr.includes(marker),false);assert.equal(failed.stderr.includes(f.directory),false);assert.equal(error.paymentInitiated,false);
  }
  assert.equal(setupErrorCode(new Error(marker)),'SETUP_FAILED');
});
