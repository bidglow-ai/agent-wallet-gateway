import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureNativeProcess} from '../scripts/native-process.mjs';

const node=process.execPath,args=source=>['--input-type=module','-e',source];
const matches=code=>cause=>cause.code===code&&cause.message===code&&!JSON.stringify(cause).includes('private-marker');
function directory(t){const path=mkdtempSync(join(tmpdir(),'native-process-test-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
function isAlive(pid){try{process.kill(pid,0);return true;}catch(cause){if(cause.code==='ESRCH')return false;throw cause;}}
async function gone(pid){for(let count=0;count<30;count++){if(!isAlive(pid))return true;await new Promise(resolve=>setTimeout(resolve,25));}return !isAlive(pid);}

test('normal exit returns bounded stdout and stderr byte count, never raw stderr',async()=>{
  const listeners=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
  const result=await captureNativeProcess(node,args("process.stdout.write('{\"synthetic\":true}\\n');process.stderr.write('private-marker');"),{});
  assert.deepEqual(result,{code:0,stdout:'{"synthetic":true}\n',stderrBytes:14});
  assert.equal(result.stderr,undefined);assert.ok(!JSON.stringify(result).includes('private-marker'));
  assert.deepEqual([process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')],listeners);
});
test('nonzero exit and missing executable expose fixed errors, not captured diagnostics',async()=>{
  await assert.rejects(captureNativeProcess(node,args("process.stderr.write('private-marker');process.exitCode=7;"),{}),matches('NATIVE_CLIENT_RUN_UNCONFIRMED'));
  await assert.rejects(captureNativeProcess('/nonexistent/synthetic-native-executable',[],{}),matches('NATIVE_CLIENT_STARTUP_UNCONFIRMED'));
});
test('optional stderr marker classification returns only a boolean, including split chunks',async()=>{
  const code="process.stderr.write('private-marker Logged in using ');setTimeout(()=>process.stderr.write('ChatGPT private-marker'),10);";
  const result=await captureNativeProcess(node,args(code),{},{stderrMarker:'logged in using chatgpt'});
  assert.equal(result.stderrMarkerObserved,true);
  assert.equal(result.stderr,undefined);assert.equal(JSON.stringify(result).includes('private-marker'),false);
  const missing=await captureNativeProcess(node,args("process.stderr.write('private-marker');"),{},{stderrMarker:'logged in using chatgpt'});
  assert.equal(missing.stderrMarkerObserved,false);
});
test('deadline hard-kills a TERM-ignoring child in only its own process group',async t=>{
  const path=join(directory(t),'pid');const started=Date.now();
  const code="import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.PID_FILE,String(process.pid));setInterval(()=>{},1000);";
  await assert.rejects(captureNativeProcess(node,args(code),{PID_FILE:path},{timeoutMs:1000,killGraceMs:100}),matches('NATIVE_CLIENT_TIMEOUT'));
  assert.ok(Date.now()-started<2500);assert.equal(await gone(Number(readFileSync(path,'utf8'))),true);
  assert.equal(isAlive(process.pid),true);
});
test('parent exit with a TERM-ignoring grandchild holding pipes cannot bypass deadline',async t=>{
  const path=join(directory(t),'grandchild-pid');const started=Date.now();
  const grandchild="import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.PID_FILE,String(process.pid));setInterval(()=>{},1000);";
  const code=`import {spawn} from 'node:child_process';spawn(process.execPath,${JSON.stringify(args(grandchild))},{env:process.env,stdio:['ignore',1,2]}).unref();process.exit(0);`;
  await assert.rejects(captureNativeProcess(node,args(code),{PID_FILE:path},{timeoutMs:1200,killGraceMs:100}),matches('NATIVE_CLIENT_TIMEOUT'));
  assert.ok(Date.now()-started<2700);assert.equal(await gone(Number(readFileSync(path,'utf8'))),true);
});
for(const stream of ['stdout','stderr'])test(`${stream} overflow stops a TERM-ignoring child without emitting its data`,async t=>{
  const path=join(directory(t),'pid');const started=Date.now();
  const code=`import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.PID_FILE,String(process.pid));process.${stream}.write('private-marker'.repeat(500));setInterval(()=>{},1000);`;
  await assert.rejects(captureNativeProcess(node,args(code),{PID_FILE:path},{timeoutMs:3000,killGraceMs:100,maxStdoutBytes:128,maxStderrBytes:128}),matches('NATIVE_CLIENT_OUTPUT_LIMIT'));
  assert.ok(Date.now()-started<2000);assert.equal(await gone(Number(readFileSync(path,'utf8'))),true);
});
for(const signal of ['SIGINT','SIGTERM'])test(`caller ${signal} stops its own group and removes temporary signal handlers`,async t=>{
  const path=join(directory(t),'pid'),moduleURL=new URL('../scripts/native-process.mjs',import.meta.url).href;
  const inner="import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.PID_FILE,String(process.pid));setInterval(()=>{},1000);";
  const wrapper=`import fs from 'node:fs';import {captureNativeProcess} from ${JSON.stringify(moduleURL)};
    const wait=setInterval(()=>{if(fs.existsSync(process.env.PID_FILE)){clearInterval(wait);process.kill(process.pid,${JSON.stringify(signal)});}},10);
    try{await captureNativeProcess(process.execPath,${JSON.stringify(args(inner))},{PID_FILE:process.env.PID_FILE},{timeoutMs:3000,killGraceMs:100});process.exitCode=2;}
    catch(e){process.stdout.write(e.code);}
    finally{clearInterval(wait);process.stdout.write(':'+process.listenerCount(${JSON.stringify(signal)}));}`;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(node,args(wrapper),{env:{PID_FILE:path},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(Error('SYNTHETIC_TEST_TIMEOUT'));},5000);
    child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    child.once('error',reject);child.once('close',code=>{clearTimeout(deadline);resolve({code,stdout,stderr});});
  });
  assert.deepEqual(result,{code:0,stdout:'NATIVE_CLIENT_INTERRUPTED:0',stderr:''});assert.equal(await gone(Number(readFileSync(path,'utf8'))),true);
});
test('invalid or unbounded deadlines fail before spawning',async()=>{
  for(const options of [{timeoutMs:0},{timeoutMs:180001},{killGraceMs:5001},{maxStdoutBytes:0},{maxStderrBytes:NaN},{stderrMarker:''},{stderrMarker:'a'.repeat(81)},{stderrMarker:42}])
    await assert.rejects(captureNativeProcess(node,[],{},options),matches('NATIVE_PROCESS_CONFIGURATION_REQUIRED'));
});
