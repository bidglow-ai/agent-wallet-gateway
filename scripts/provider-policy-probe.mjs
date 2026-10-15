import {pathToFileURL} from 'node:url';
import {readPrivateJson} from '../src/unattended/private-json.mjs';
import {runExpiredPolicyProbe} from '../src/unattended/policy-probe.mjs';

const OPT_IN='--run-expired-testnet-policy-probe';
const FLAGS={'--cdp-file':'cdpFile','--setup-evidence-file':'evidenceFile','--installed-policy-file':'policyFile'};
let configured=false;
export function policyProbeArguments(argv){
  if(!Array.isArray(argv)||argv[0]!==OPT_IN||argv.length!==7)throw new Error();
  const result={};
  for(let i=1;i<argv.length;i+=2){
    const key=Object.hasOwn(FLAGS,argv[i])?FLAGS[argv[i]]:null,value=argv[i+1];
    if(!key||Object.hasOwn(result,key)||typeof value!=='string'||!value.startsWith('/')||value.startsWith('--'))throw new Error();
    result[key]=value;
  }
  return result;
}
export async function runPolicyProbeCommand(argv){
  if(configured)throw new Error();
  const paths=policyProbeArguments(argv);
  const credentials=readPrivateJson(paths.cdpFile,16384),evidence=readPrivateJson(paths.evidenceFile,16384),installedPolicy=readPrivateJson(paths.policyFile,32768);
  const keys=['apiKeyId','apiKeySecret','walletSecret'];
  if(Object.keys(credentials).sort().join('|')!==keys.sort().join('|')||
    !keys.every(key=>typeof credentials[key]==='string'&&credentials[key].length>10&&credentials[key].length<=8192))throw new Error();
  // Each CLI invocation owns one SDK/project. Never inherit credentials from
  // environment variables, enable debug logging or write signatures to disk.
  process.env.DISABLE_CDP_ERROR_REPORTING='true';process.env.DISABLE_CDP_USAGE_TRACKING='true';
  configured=true;
  const {CdpClient}=await import('@coinbase/cdp-sdk');
  const client=new CdpClient({...credentials,debugging:false});
  return runExpiredPolicyProbe({client,evidence,installedPolicy});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{const result=await runPolicyProbeCommand(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='PASSED')process.exitCode=1;}
  catch{process.stderr.write(JSON.stringify({status:'INCONCLUSIVE',category:'CONFIGURATION_REQUIRED',testnetOnly:true,expiredAuthorizationsOnly:true,
    signingOnly:true,paymentInitiated:false,fundingAccepted:false})+'\n');process.exitCode=1;}
}
