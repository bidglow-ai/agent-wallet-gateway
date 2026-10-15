import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,readSync,writeFileSync,fsyncSync,unlinkSync} from 'node:fs';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateGrant,NETWORK,TOKEN} from './intent.mjs';

const REPOSITORY=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_ID=new RegExp(`^(?:${UUID}|organizations/${UUID}/apiKeys/${UUID})$`,'i');
const UUID4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG_KEYS=['developmentProjectConfirmed','projectId','expectedWallet','payTo','merchantOrigin','perCallAtomic','totalAtomic','durationMs','policyId','merchantAccount','fromBlock','stateDir','orderDirectory','onboardingOrigin','enrollmentPort'];
const CODES=new Set(['SETUP_PRIVATE_PATH_REQUIRED','SETUP_PRIVATE_FILE_REQUIRED','SETUP_INPUT_FORMAT_REQUIRED',
  'SETUP_API_KEY_FORMAT_REQUIRED','SETUP_WALLET_SECRET_FORMAT_REQUIRED','SETUP_SANDBOX_KEY_REQUIRED',
  'SETUP_OPERATOR_CONFIGURATION_REQUIRED','SETUP_OUTPUT_EXISTS','SETUP_OUTPUT_UNCONFIRMED','SETUP_FAILED','INVALID_SETUP_ARGUMENTS']);
export class SetupFileError extends Error {
  constructor(code){const safe=CODES.has(code)?code:'SETUP_FAILED';super(safe);this.code=safe;}
}
export function setupErrorCode(error){return error instanceof SetupFileError&&CODES.has(error.code)?error.code:'SETUP_FAILED';}
const fail=code=>{throw new SetupFileError(code);};
const owner=stat=>typeof process.getuid==='function'&&stat.uid===process.getuid();
const outside=path=>path!==REPOSITORY&&!path.startsWith(REPOSITORY+sep);
function fields(value,keys){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('SETUP_INPUT_FORMAT_REQUIRED');
  for(const key of keys)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'))fail('SETUP_INPUT_FORMAT_REQUIRED');
  return value;
}
// Trusted local operator only: direct-parent checks and realpath repository
// exclusion are not protection against hostile ancestor replacement/ACLs/TOCTOU.
function privatePath(path){
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||!outside(path))fail('SETUP_PRIVATE_PATH_REQUIRED');
  try{
    const parent=dirname(path),stat=lstatSync(parent);
    if(stat.isSymbolicLink()||!stat.isDirectory()||!owner(stat)||(stat.mode&0o777)!==0o700||!outside(realpathSync(parent)))fail('SETUP_PRIVATE_PATH_REQUIRED');
  }catch{fail('SETUP_PRIVATE_PATH_REQUIRED');}
  return path;
}
function privateFile(stat){return stat.isFile()&&owner(stat)&&(stat.mode&0o777)===0o600&&stat.nlink===1;}
function readText(path,maxBytes){
  privatePath(path);let fd;
  try{
    if(!outside(realpathSync(path)))fail('SETUP_PRIVATE_PATH_REQUIRED');
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);
    if(!privateFile(stat)||stat.size<1||stat.size>maxBytes)fail('SETUP_PRIVATE_FILE_REQUIRED');
    // Read at most maxBytes+1 even if a trusted concurrent process grows it.
    const buffer=Buffer.alloc(maxBytes+1);let used=0;
    while(used<buffer.length){const count=readSync(fd,buffer,used,buffer.length-used,null);if(!count)break;used+=count;}
    if(used>maxBytes||used<1)fail('SETUP_PRIVATE_FILE_REQUIRED');
    return buffer.subarray(0,used).toString('utf8');
  }catch(error){if(error instanceof SetupFileError)throw error;fail('SETUP_PRIVATE_FILE_REQUIRED');}
  finally{if(fd!==undefined)closeSync(fd);}
}
function readJson(path,maxBytes=16384){
  const text=readText(path,maxBytes);
  try{return JSON.parse(text);}catch{fail('SETUP_INPUT_FORMAT_REQUIRED');}
}
function base64(value){
  if(typeof value!=='string'||!value||value.length>8192||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error();
  const data=Buffer.from(value,'base64');if(data.toString('base64')!==value)throw new Error();return data;
}
function validateApiKey(apiKeyId,apiKeySecret){
  try{
    if(typeof apiKeyId!=='string'||!KEY_ID.test(apiKeyId)||typeof apiKeySecret!=='string'||apiKeySecret.length>8192)throw new Error();
    if(apiKeySecret.startsWith('-----BEGIN ')){
      const key=createPrivateKey(apiKeySecret);
      if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error();
    }else{
      const raw=base64(apiKeySecret);if(raw.length!==64)throw new Error();
      const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),raw.subarray(0,32)]),format:'der',type:'pkcs8'});
      const publicPart=createPublicKey(key).export({format:'jwk'}).x;
      if(publicPart!==raw.subarray(32).toString('base64url'))throw new Error();
    }
  }catch{fail('SETUP_API_KEY_FORMAT_REQUIRED');}
  // API identifiers and secret strings are deliberately NOT trimmed/rewritten.
  return {apiKeyId,apiKeySecret};
}
function walletSecret(value){
  try{
    if(typeof value!=='string')throw new Error();
    const key=createPrivateKey({key:base64(value),format:'der',type:'pkcs8'});
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error();
    return value;
  }catch{fail('SETUP_WALLET_SECRET_FORMAT_REQUIRED');}
}
function validateCdp(value){
  fields(value,['apiKeyId','apiKeySecret','walletSecret']);
  return {...validateApiKey(value.apiKeyId,value.apiKeySecret),walletSecret:walletSecret(value.walletSecret)};
}
function privateDirectoryLocation(path){
  privatePath(path);
  try{
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()||!stat.isDirectory()||!owner(stat)||(stat.mode&0o777)!==0o700||!outside(realpathSync(path)))fail('SETUP_PRIVATE_PATH_REQUIRED');
  }catch(error){if(error instanceof SetupFileError)throw error;if(error?.code!=='ENOENT')fail('SETUP_PRIVATE_PATH_REQUIRED');}
}
// Equivalent strict runtime contract, intentionally pure: importing runtime here
// would load the signer/SQLite graph into a credentials-only offline CLI.
// Compatibility with the actual runtime loader is exercised by synthetic tests.
function validateConfig(input){
  fields(input,CONFIG_KEYS);
  try{
    if(input.developmentProjectConfirmed!==true||!UUID4.test(input.projectId)||!Number.isInteger(input.enrollmentPort)||input.enrollmentPort<1024||input.enrollmentPort>65535||
      ![3600000,14400000,86400000].includes(input.durationMs)||!/^acct_[A-Za-z0-9]{8,100}$/.test(input.merchantAccount)||
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.policyId)||typeof input.fromBlock!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(input.fromBlock))throw new Error();
    for(const path of [input.stateDir,input.orderDirectory])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw new Error();
    if(input.orderDirectory===input.stateDir||input.orderDirectory.startsWith(input.stateDir+'/')||input.stateDir.startsWith(input.orderDirectory+'/'))throw new Error();
    const origin=new URL(input.onboardingOrigin);
    if(origin.origin!==input.onboardingOrigin||origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||!origin.port||Number(origin.port)===input.enrollmentPort)throw new Error();
    validateGrant({grantId:input.projectId,userId:input.projectId,wallet:input.expectedWallet,network:NETWORK,asset:TOKEN,payTo:input.payTo,
      merchantOrigin:input.merchantOrigin,perCallAtomic:input.perCallAtomic,totalAtomic:input.totalAtomic,expiresAt:Date.now()+input.durationMs});
    if(BigInt(input.perCallAtomic)%10000n||BigInt(input.totalAtomic)%10000n)throw new Error();
    if([input.policyId,input.merchantAccount].some(value=>/REPLACE|PLACEHOLDER|YOUR_/i.test(value))||new URL(input.merchantOrigin).hostname==='merchant.example')throw new Error();
  }catch{fail('SETUP_OPERATOR_CONFIGURATION_REQUIRED');}
  privateDirectoryLocation(input.stateDir);privateDirectoryLocation(input.orderDirectory);
  return {...input};
}
function stripeKey(value){if(typeof value!=='string'||!/^sk_test_[A-Za-z0-9]{20,200}$/.test(value))fail('SETUP_SANDBOX_KEY_REQUIRED');return value;}
function validateBundle(value){
  fields(value,['config','credentials']);fields(value.credentials,['apiKeyId','apiKeySecret','walletSecret','stripeTestKey']);
  return {config:validateConfig(value.config),credentials:{...validateCdp(Object.fromEntries(['apiKeyId','apiKeySecret','walletSecret'].map(key=>[key,value.credentials[key]]))),stripeTestKey:stripeKey(value.credentials.stripeTestKey)}};
}
function outputPath(path){
  privatePath(path);
  try{lstatSync(path);fail('SETUP_OUTPUT_EXISTS');}
  catch(error){if(error instanceof SetupFileError)throw error;if(error?.code!=='ENOENT')fail('SETUP_PRIVATE_PATH_REQUIRED');}
  if(!outside(join(realpathSync(dirname(path)),basename(path))))fail('SETUP_PRIVATE_PATH_REQUIRED');
}
function writeExclusive(path,value,verify){
  outputPath(path);let fd,created;
  try{
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=fstatSync(fd);if(!privateFile(created))fail('SETUP_OUTPUT_UNCONFIRMED');
    writeFileSync(fd,JSON.stringify(value,null,2)+'\n',{encoding:'utf8'});fsyncSync(fd);
    verify?.(path);
  }catch(error){
    if(created){
      try{const current=lstatSync(path);if(current.isFile()&&!current.isSymbolicLink()&&owner(current)&&current.dev===created.dev&&current.ino===created.ino&&current.nlink===1)unlinkSync(path);}
      catch{/* Never delete a changed/unidentifiable target or any directory. */}
    }
    if(error instanceof SetupFileError)throw error;
    fail(error?.code==='EEXIST'?'SETUP_OUTPUT_EXISTS':'SETUP_OUTPUT_UNCONFIRMED');
  }finally{if(fd!==undefined)closeSync(fd);}
}

export function importCdpFiles({apiKeyFile,walletSecretFile,outputFile}){
  outputPath(outputFile);
  const input=readJson(apiKeyFile);let api;
  // Official Coinbase configure_from_json documents name-or-id + privateKey:
  // https://raw.githubusercontent.com/coinbase/cdp-sdk-python/master/cdp/cdp.py
  // Exact two-field shapes only; no guesses about future Portal export formats.
  if(input&&Object.hasOwn(input,'name')){fields(input,['name','privateKey']);api=validateApiKey(input.name,input.privateKey);}
  else if(input&&Object.hasOwn(input,'id')){fields(input,['id','privateKey']);api=validateApiKey(input.id,input.privateKey);}
  else{fields(input,['apiKeyId','apiKeySecret']);api=validateApiKey(input.apiKeyId,input.apiKeySecret);}
  const credentials={...api,walletSecret:walletSecret(readText(walletSecretFile,8192).trim())};
  writeExclusive(outputFile,credentials);
  return {cdpImported:true,providerConfigurationVerified:false,paymentInitiated:false,fundingAccepted:false};
}
export function buildOperatorFiles({configFile,cdpFile,stripeKeyFile,outputFile}){
  outputPath(outputFile);
  const config=validateConfig(readJson(configFile)),cdp=validateCdp(readJson(cdpFile));
  const bundle=validateBundle({config,credentials:{...cdp,stripeTestKey:stripeKey(readText(stripeKeyFile,4096).trim())}});
  writeExclusive(outputFile,bundle,path=>{validateBundle(readJson(path,32768));});
  return {operatorBuilt:true,testnetOnly:true,providerConfigurationVerified:false,paymentInitiated:false,fundingAccepted:false};
}
