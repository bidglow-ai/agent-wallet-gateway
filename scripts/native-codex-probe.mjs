import {mkdtempSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {startSyntheticFixture} from './native-fixture.mjs';
import {captureNativeProcess} from './native-process.mjs';

// Opt-in native-client probe. Its only payer is an unfunded in-memory fixture;
// it cannot load CDP/AWAL/Stripe credentials, access a provider or move assets.
// Native model tool use is a separate claim from provider payment acceptance.
export function inspectNativeEvents(events,orderId,{readinessOnly=false}={}){
  if(typeof readinessOnly!=='boolean')throw new Error('INVALID_NATIVE_PROBE_MODE');
  if(events.some(event=>event?.item?.type==='error'||event?.type==='error'||event?.type==='turn.failed'))throw new Error('NATIVE_CLIENT_REPORTED_ERROR');
  const permitted=new Set(['mcp_tool_call','agent_message','reasoning']);
  if(events.some(event=>event?.item?.type&&!permitted.has(event.item.type)))throw new Error('UNEXPECTED_NATIVE_TOOL_EXECUTION');
  const calls=events.filter(event=>event?.type==='item.completed'&&event.item?.type==='mcp_tool_call').map(event=>event.item);
  const wanted=readinessOnly?['testnet_payment_readiness']:['testnet_payment_readiness','testnet_pay_order','testnet_payment_status','testnet_payment_reconcile'];
  const evidence=[];
  for(const [index,tool]of wanted.entries()){
    const matches=calls.filter(call=>call.server==='synthetic_wallet'&&call.tool===tool&&call.status==='completed');
    if(matches.length!==1||calls[index]!==matches[0]||matches[0].error||matches[0].result?.isError===true)throw new Error('NATIVE_TOOL_EVIDENCE_INCOMPLETE');
    if(tool!=='testnet_payment_readiness'&&matches[0].arguments?.orderId!==orderId)throw new Error('NATIVE_ORDER_EVIDENCE_MISMATCH');
    const content=matches[0].result?.content;
    if(!Array.isArray(content)||content.length!==1||content[0]?.type!=='text')throw new Error('NATIVE_TOOL_RESULT_UNCONFIRMED');
    let result;try{result=JSON.parse(content[0].text);}catch{throw new Error('NATIVE_TOOL_RESULT_UNCONFIRMED');}
    if(result?.error||result?.testnetOnly!==true)throw new Error('NATIVE_TOOL_RESULT_UNCONFIRMED');
    if(tool==='testnet_payment_readiness'){
      if(result.mainnetEnabled!==false||result.fundingAccepted!==false||result.providerAcceptance!==false)throw new Error('NATIVE_TOOL_RESULT_UNCONFIRMED');
    }else if(result.orderId!==orderId||result.state!=='confirmed'||result.syntheticOnly!==true||result.providerPaymentAccepted!==false)throw new Error('NATIVE_TOOL_RESULT_UNCONFIRMED');
    evidence.push(tool);
  }
  if(calls.length!==wanted.length||events.some(event=>event.type==='turn.failed'||event.type==='error')||!events.some(event=>event.type==='turn.completed'))throw new Error('NATIVE_EXECUTION_UNCONFIRMED');
  return evidence;
}
export function nativeDiagnostics(events,snapshot){
  const known=new Set(['thread.started','turn.started','turn.completed','turn.failed','error','item.started','item.updated','item.completed',
    'mcp_tool_call','agent_message','reasoning','command_execution','file_change','web_search','collab_tool_call',
    'synthetic_wallet','testnet_payment_readiness','testnet_pay_order','testnet_payment_status','testnet_payment_reconcile',
    'in_progress','completed','failed']);
  const tag=value=>known.has(value)?value:'unknown';
  return {eventTypes:[...new Set(events.map(event=>tag(event.type)))],itemTypes:[...new Set(events.filter(event=>event.item).map(event=>tag(event.item.type)))],
    errorCategories:events.filter(event=>event.item?.type==='error').map(event=>{
      const message=Object.values(event.item).filter(value=>typeof value==='string').join('\n');
      return {fields:Object.keys(event.item).filter(key=>['id','type','message'].includes(key)),...Object.fromEntries(Object.entries({mcp:/mcp|synthetic_wallet/i,handshake:/handshak|initializ/i,missingExecutable:/ENOENT|not found/i,
        permission:/permission|EPERM|EACCES|not permitted/i,timeout:/timeout|timed out/i,auth:/authenticat|401|403/i,
        unsupported:/unsupported|not supported|not available/i,quota:/quota|rate.?limit|usage limit/i,configuration:/config|toml|invalid/i,
        toolSchema:/schema|tools\/list|inputSchema/i,discovery:/discover|defer|catalog|search/i,disabled:/disabl|unavailable/i,
        codeModeHostDisabled:/code-mode host is disabled/i,codeModeFailClosed:/Code mode will fail closed/i}).map(([key,pattern])=>[key,pattern.test(message)]))};
    }),
    completedTools:events.filter(event=>event.type==='item.completed'&&event.item?.type==='mcp_tool_call').map(event=>({server:tag(event.item.server),tool:tag(event.item.tool),status:tag(event.item.status),resultKeys:Object.keys(event.item.result||{}).filter(key=>['content','_meta','structured_content','isError'].includes(key))})),
    fixture:snapshot};
}
function nativeEnvironment(){
  const allowed=['PATH','HOME','LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME'];
  return Object.fromEntries(allowed.filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
}
async function execute(executable,args,env){
  // The inspected CLI handles Ctrl-C for orderly per-run client shutdown.
  // This controls only its process group, not all independently grouped helpers.
  const captured=await captureNativeProcess(executable,args,env,{initialSignal:'SIGINT'});
  try{return captured.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
  catch{throw new Error('NATIVE_JSONL_EVIDENCE_UNCONFIRMED');}
}
export async function runNativeCodexProbe({readinessOnly=false}={}){
  if(typeof readinessOnly!=='boolean')throw new Error('INVALID_NATIVE_PROBE_MODE');
  if(process.env.AGENT_SYNTHETIC_ONLY!=='true')throw new Error('EXPLICIT_SYNTHETIC_PROBE_REQUIRED');
  const executable=process.env.AGENT_NATIVE_CODEX||'codex',env=nativeEnvironment();
  let version,authenticated;
  try{
    version=(await captureNativeProcess(executable,['--version'],env,{timeoutMs:10000,maxStdoutBytes:65536,maxStderrBytes:65536})).stdout.trim();
    // Reuse the existing ChatGPT subscription, never an API-key billing route.
    const result=await captureNativeProcess(executable,['login','status'],env,{timeoutMs:10000,maxStdoutBytes:65536,maxStderrBytes:65536,stderrMarker:'logged in using chatgpt'});
    authenticated=result.code===0&&(/logged in using chatgpt/i.test(result.stdout)||result.stderrMarkerObserved);
  }catch{throw new Error('NATIVE_CHATGPT_AUTH_UNCONFIRMED');}
  if(version!=='codex-cli 0.159.2'||!authenticated)throw new Error('NATIVE_CHATGPT_AUTH_OR_VERSION_UNCONFIRMED');
  const working=mkdtempSync(join(tmpdir(),'native-codex-fixture-'));
  const original=lstatSync(working);let fixture;
  try{
    fixture=await startSyntheticFixture();
    const client=fileURLToPath(new URL('../src/unattended/client.mjs',import.meta.url));
    const settings={command:process.execPath,args:[client],env_vars:['AGENT_BROKER_ORIGIN','AGENT_BROKER_TOKEN'],required:true,
      enabled_tools:readinessOnly?['testnet_payment_readiness']:['testnet_payment_readiness','testnet_pay_order','testnet_payment_status','testnet_payment_reconcile']};
    const approvals=readinessOnly?'':', tools = { testnet_pay_order = { approval_mode = "approve" }, testnet_payment_reconcile = { approval_mode = "approve" } }';
    const toml=`{ command = ${JSON.stringify(settings.command)}, args = [${JSON.stringify(client)}], env_vars = ["AGENT_BROKER_ORIGIN", "AGENT_BROKER_TOKEN"], required = true, enabled_tools = [${settings.enabled_tools.map(value=>JSON.stringify(value)).join(',')}]${approvals} }`;
    const task=readinessOnly?'Call testnet_payment_readiness exactly once. No payment or other tool is authorized in this discovery-only run.':`Owner has authorized exactly ONE 5-TEST-USDC synthetic order: ${fixture.orderId}. Call testnet_payment_readiness once, then testnet_pay_order once for that exact ID, then testnet_payment_status once, then testnet_payment_reconcile once. Do not retry payment or invent IDs.`;
    const prompt=`This is an authorized isolated SYNTHETIC protocol test, not a real payment. Use ONLY the synthetic_wallet MCP tools; do not use shell, browse, other tools, read files, edit files, request credentials, or change client settings. The synthetic wallet uses an unfunded disposable in-memory fixture and cannot contact Coinbase, Stripe, a blockchain or a real merchant. ${task} Report that any result is fixture-only, provider/mainnet/native-real-payment acceptance remains false. If tools are missing or fail, state failure without inventing success.`;
    // Disable unrelated capabilities, not just prompt against their use.
    // This opt-in probe is pinned to the inspected native CLI feature surface.
    const disabled=['shell_tool','unified_exec','apps','plugins','hooks','multi_agent','computer_use','browser_use','browser_use_external','in_app_browser','image_generation','view_image','skill_search','skill_mcp_dependency_install','shell_snapshot','workspace_dependencies','remote_plugin'];
    const events=await execute(executable,['--no-daemon','exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--color','never','-C',working,
      ...disabled.flatMap(feature=>['--disable',feature]),'-c','features.code_mode_host={enabled=true,disable_in_process_fallback=true}',
      '-c','features.code_mode.excluded_tool_namespaces=["functions"]','-c','forced_login_method="chatgpt"','-c','web_search="disabled"',
      '-c','approval_policy="never"','-c','mcp_servers.synthetic_wallet='+toml,prompt],
      {...env,AGENT_BROKER_ORIGIN:fixture.brokerOrigin,AGENT_BROKER_TOKEN:fixture.clientToken});
    let toolCalls;
    try{toolCalls=inspectNativeEvents(events,fixture.orderId,{readinessOnly});}
    catch(error){
      error.nativeEvidence=nativeDiagnostics(events,fixture.snapshot());throw error;
    }
    const snapshot=fixture.snapshot();
    const ledgerMatches=readinessOnly?snapshot.state==='unreserved'&&Object.values(snapshot.counters).every(value=>value===0)&&snapshot.allocatedAtomic==='0':
      snapshot.state==='confirmed'&&snapshot.counters.pay===1&&snapshot.counters.inspect===1&&snapshot.counters.reconcile===1&&snapshot.counters.sign===1&&snapshot.counters.settle===1&&snapshot.allocatedAtomic==='5000000';
    if(snapshot.syntheticOnly!==true||snapshot.providerCalls!==0||!ledgerMatches)throw new Error('NATIVE_LEDGER_EVIDENCE_MISMATCH');
    return {client:version,mode:readinessOnly?'readiness-only':'synthetic-payment',syntheticOnly:true,nativeModelToolUseObserved:true,syntheticPaymentToolUseObserved:!readinessOnly,toolCalls,trace:snapshot,
      providerPaymentAccepted:false,mainnetPaymentAccepted:false,fundingAccepted:false};
  }finally{
    try{await fixture?.close();}finally{
      const current=lstatSync(working);
      if(!current.isDirectory()||current.isSymbolicLink()||current.ino!==original.ino||current.dev!==original.dev||current.uid!==original.uid)throw new Error('SYNTHETIC_WORKSPACE_CLEANUP_REJECTED');
      rmSync(working,{recursive:true,force:false});
    }
  }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const options=process.argv.length===2?{}:process.argv.length===3&&process.argv[2]==='--readiness-only'?{readinessOnly:true}:null;
  const run=options?runNativeCodexProbe(options):Promise.reject(new Error('INVALID_NATIVE_PROBE_MODE'));
  run.then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'),error=>{
    const code=typeof error?.message==='string'&&/^[A-Z_]{1,80}$/.test(error.message)?error.message:'NATIVE_SYNTHETIC_PROBE_UNCONFIRMED';
    process.stderr.write(JSON.stringify({error:code,...(error.nativeEvidence?{nativeEvidence:error.nativeEvidence}:{}),providerPaymentAccepted:false,fundingAccepted:false})+'\n');process.exitCode=1;
  });
}
