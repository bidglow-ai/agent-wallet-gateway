import {loadOperatorBundle,startDevelopmentRuntime} from './runtime.mjs';
import {PaymentError} from './intent.mjs';
import {PaymentStoreError} from './store.mjs';
try{
  if(process.env.AGENT_TESTNET_DEVELOPMENT!=='I_UNDERSTAND_NO_REAL_FUNDS')throw new PaymentError('EXPLICIT_TESTNET_DEVELOPMENT_REQUIRED');
  const bundle=loadOperatorBundle(process.env.AGENT_OPERATOR_CONFIG);
  const runtime=await startDevelopmentRuntime(bundle);
  // Public local enrollment URL only. Never print API keys, wallet state or the
  // agent capability. No command-line secret arguments, mainnet flag or retries.
  process.stdout.write(JSON.stringify({enrollmentOrigin:runtime.enrollmentOrigin,testnetOnly:true,fundingAccepted:false})+'\n');
  let closing=false;
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!closing){closing=true;void runtime.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});}});
}catch(error){
  process.stderr.write(JSON.stringify({error:error instanceof PaymentError||error instanceof PaymentStoreError?error.code:'DEVELOPMENT_STARTUP_UNCONFIRMED',fundingAccepted:false})+'\n');process.exitCode=1;
}
