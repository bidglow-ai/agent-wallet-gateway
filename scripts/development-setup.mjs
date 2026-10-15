import {pathToFileURL} from 'node:url';
import {importCdpFiles,buildOperatorFiles,SetupFileError,setupErrorCode} from '../src/unattended/setup-files.mjs';

// Path arguments only. Never accept credential values, environment fallbacks,
// overwrite switches, runtime startup, provider requests or payment commands.
export function runDevelopmentSetup(argv){
  const [command,...args]=argv;
  const modes={
    'import-cdp':{flags:{'--api-key-file':'apiKeyFile','--wallet-secret-file':'walletSecretFile','--output-file':'outputFile'},run:importCdpFiles},
    'build-operator':{flags:{'--config-file':'configFile','--cdp-file':'cdpFile','--stripe-key-file':'stripeKeyFile','--output-file':'outputFile'},run:buildOperatorFiles},
  };
  const mode=Object.hasOwn(modes,command)?modes[command]:null;
  if(!mode||args.length!==Object.keys(mode.flags).length*2)throw new SetupFileError('INVALID_SETUP_ARGUMENTS');
  const values={};
  for(let index=0;index<args.length;index+=2){
    const key=Object.hasOwn(mode.flags,args[index])?mode.flags[args[index]]:null,value=args[index+1];
    if(!key||Object.hasOwn(values,key)||typeof value!=='string'||value.startsWith('--'))throw new SetupFileError('INVALID_SETUP_ARGUMENTS');
    values[key]=value;
  }
  return mode.run(values);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{process.stdout.write(JSON.stringify(runDevelopmentSetup(process.argv.slice(2)))+'\n');}
  catch(error){process.stderr.write(JSON.stringify({error:setupErrorCode(error),fundingAccepted:false,paymentInitiated:false})+'\n');process.exitCode=1;}
}
