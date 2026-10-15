import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectNativeEvents,nativeDiagnostics} from '../scripts/native-codex-probe.mjs';
const id=randomUUID();
const tools=['testnet_payment_readiness','testnet_pay_order','testnet_payment_status','testnet_payment_reconcile'];
function events(){return [...tools.map(tool=>({type:'item.completed',item:{type:'mcp_tool_call',server:'synthetic_wallet',tool,status:'completed',arguments:tool.endsWith('readiness')?{}:{orderId:id},result:{content:[{type:'text',text:JSON.stringify(tool.endsWith('readiness')?{testnetOnly:true,mainnetEnabled:false,fundingAccepted:false,providerAcceptance:false}:{orderId:id,state:'confirmed',testnetOnly:true,syntheticOnly:true,providerPaymentAccepted:false})}]}}})),{type:'turn.completed'}];}
test('native evidence requires real completed MCP events, not an assistant success claim',()=>{
  assert.deepEqual(inspectNativeEvents(events(),id),tools);
  assert.throws(()=>inspectNativeEvents([{type:'item.completed',item:{type:'agent_message',text:'Payment succeeded'}},{type:'turn.completed'}],id));
  for(const alter of [list=>list.slice(1),list=>list.slice(0,-1),list=>[...list,{type:'turn.failed'}],list=>[...list,list[1]],
    list=>{list[1].item.arguments.orderId=randomUUID();return list;},list=>{list[1].item.status='failed';return list;},list=>{list[1].item.server='another_wallet';return list;},
    list=>{list[1].item.result.isError=true;return list;},list=>{list[1].item.result.content[0].text='{"state":"confirmed"}';return list;},
    list=>{[list[0],list[1]]=[list[1],list[0]];return list;},list=>[...list,{type:'item.completed',item:{type:'command_execution'}}]])assert.throws(()=>inspectNativeEvents(alter(events()),id));
});
test('native client errors are not mislabeled as tool execution and diagnostics omit their text',()=>{
  const secret=randomUUID();
  const list=[{type:'item.completed',item:{id:'error-1',type:'error',message:`code-mode host is disabled; Code mode will fail closed ${secret}`,[secret]:secret}},{type:'turn.completed'}];
  assert.throws(()=>inspectNativeEvents(list,id),/NATIVE_CLIENT_REPORTED_ERROR/);
  const diagnostic=nativeDiagnostics(list,{syntheticOnly:true,providerCalls:0});
  assert.equal(diagnostic.errorCategories[0].codeModeHostDisabled,true);
  assert.equal(diagnostic.errorCategories[0].codeModeFailClosed,true);
  assert.deepEqual(diagnostic.completedTools,[]);
  assert.equal(JSON.stringify(diagnostic).includes(secret),false);
  const poisoned=nativeDiagnostics([{type:secret,item:{type:secret}},{type:'item.completed',item:{type:'mcp_tool_call',server:secret,tool:secret,status:secret,result:{[secret]:secret}}}],{syntheticOnly:true});
  assert.equal(JSON.stringify(poisoned).includes(secret),false);
  assert.deepEqual(poisoned.completedTools,[{server:'unknown',tool:'unknown',status:'unknown',resultKeys:[]}]);
});
test('readiness-only native evidence cannot be upgraded into payment acceptance',()=>{
  const discovery=[events()[0],{type:'turn.completed'}];
  assert.deepEqual(inspectNativeEvents(discovery,id,{readinessOnly:true}),[tools[0]]);
  assert.throws(()=>inspectNativeEvents(discovery,id));
  assert.throws(()=>inspectNativeEvents(events(),id,{readinessOnly:true}));
  assert.throws(()=>inspectNativeEvents(discovery,id,{readinessOnly:'true'}));
});
