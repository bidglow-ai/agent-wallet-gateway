import {randomBytes} from 'node:crypto';
import {lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicClient,http} from 'viem';
import {baseSepolia} from 'viem/chains';
import {validateGrant,validateOrder,NETWORK,TOKEN,PaymentError} from './intent.mjs';
import {PaymentStore} from './store.mjs';
import {EnrollmentStore} from './enrollment-store.mjs';
import {EnrollmentAuthority,createEnrollmentHttpServer} from './enrollment.mjs';
import {createBrokerHttpServer} from './http.mjs';
import {TestnetBroker} from './broker.mjs';
import {createCdpSigner} from './cdp-signer.mjs';
import {createTestnetMerchant} from './merchant.mjs';
import {ChainStripeVerifier} from './chain-stripe-verifier.mjs';
import {readPrivateJson} from './private-json.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const KEYS=['developmentProjectConfirmed','projectId','expectedWallet','payTo','merchantOrigin','perCallAtomic','totalAtomic','durationMs','policyId','merchantAccount','fromBlock','stateDir','orderDirectory','onboardingOrigin','enrollmentPort'];
function strict(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw new PaymentError('INVALID_OPERATOR_CONFIGURATION');}
function privateDirectory(path){
  if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw new PaymentError('PRIVATE_STATE_DIRECTORY_REQUIRED');
  try{mkdirSync(path,{mode:0o700,recursive:true});const s=lstatSync(path);if(s.isSymbolicLink()||!s.isDirectory()||(s.mode&0o777)!==0o700||(process.getuid&&s.uid!==process.getuid()))throw new Error();}
  catch{throw new PaymentError('PRIVATE_STATE_DIRECTORY_REQUIRED');}
  return path;
}
export function validateOperatorConfig(input){
  strict(input,KEYS);
  if(input.developmentProjectConfirmed!==true||!UUID.test(input.projectId)||!Number.isInteger(input.enrollmentPort)||input.enrollmentPort<1024||input.enrollmentPort>65535||
    ![3600000,14400000,86400000].includes(input.durationMs)||!/^acct_[A-Za-z0-9]{8,100}$/.test(input.merchantAccount)||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.policyId)||typeof input.fromBlock!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(input.fromBlock))throw new PaymentError('INVALID_OPERATOR_CONFIGURATION');
  for(const path of [input.stateDir,input.orderDirectory])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw new PaymentError('PRIVATE_STATE_DIRECTORY_REQUIRED');
  if(input.orderDirectory===input.stateDir||input.orderDirectory.startsWith(input.stateDir+'/')||input.stateDir.startsWith(input.orderDirectory+'/'))throw new PaymentError('SEPARATE_ORDER_DIRECTORY_REQUIRED');
  let origin;try{origin=new URL(input.onboardingOrigin);}catch{throw new PaymentError('LOCAL_ONBOARDING_ORIGIN_REQUIRED');}
  if(origin.origin!==input.onboardingOrigin||origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||!origin.port||Number(origin.port)===input.enrollmentPort)throw new PaymentError('LOCAL_ONBOARDING_ORIGIN_REQUIRED');
  validateGrant({grantId:input.projectId,userId:input.projectId,wallet:input.expectedWallet,network:NETWORK,asset:TOKEN,payTo:input.payTo,
    merchantOrigin:input.merchantOrigin,perCallAtomic:input.perCallAtomic,totalAtomic:input.totalAtomic,expiresAt:Date.now()+input.durationMs});
  if(BigInt(input.perCallAtomic)%10000n||BigInt(input.totalAtomic)%10000n)throw new PaymentError('AMOUNT_NOT_WHOLE_CENTS');
  return Object.freeze({...input});
}
export function loadOperatorBundle(path){
  let actual;try{actual=realpathSync(path);}catch{throw new PaymentError('PRIVATE_OPERATOR_FILE_REQUIRED');}
  if(actual===REPOSITORY||actual.startsWith(REPOSITORY+'/'))throw new PaymentError('OPERATOR_CONFIG_MUST_BE_OUTSIDE_REPOSITORY');
  const bundle=readPrivateJson(path);strict(bundle,['config','credentials']);
  const config=validateOperatorConfig(bundle.config);
  strict(bundle.credentials,['apiKeyId','apiKeySecret','walletSecret','stripeTestKey']);
  for(const name of ['apiKeyId','apiKeySecret','walletSecret'])if(typeof bundle.credentials[name]!=='string'||bundle.credentials[name].length<11)throw new PaymentError('PROVIDER_CONFIGURATION_REQUIRED');
  if(!/^sk_test_[A-Za-z0-9]{20,200}$/.test(bundle.credentials.stripeTestKey||''))throw new PaymentError('SANDBOX_EVIDENCE_CONFIGURATION_REQUIRED');
  return {config,credentials:{...bundle.credentials}};
}
function listen(server,port){return new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);accept();});});}
function close(server){return new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}

// Orders are created by a trusted isolated merchant/operator, not MCP arguments.
// They are immutable owner-only JSON files named by UUID. No network destination,
// amount, business scope, private state path or signature comes from an AI caller.
export class PrivateOrderProvider {
  #directory;#grant;#account;
  constructor({directory,grant,merchantAccount}){this.#directory=privateDirectory(directory);this.#grant=validateGrant(grant);this.#account=merchantAccount;}
  get(id){
    if(typeof id!=='string'||!UUID.test(id))throw new PaymentError('INVALID_ORDER_ID');
    const order=validateOrder(readPrivateJson(join(this.#directory,id+'.json'),8192),this.#grant);
    if(order.id!==id||order.merchantAccount!==this.#account)throw new PaymentError('AUTHENTICATED_ORDER_REQUIRED');
    return order;
  }
}

// Start explicitly and locally. No setup mutates provider policy, no test funds
// are requested and no payment is initiated merely by starting this service.
// Injected dependencies in tests are fixtures, never evidence of provider success.
export async function startDevelopmentRuntime({config:input,credentials,dependencies={}}){
  const config=validateOperatorConfig(input);privateDirectory(config.stateDir);privateDirectory(config.orderDirectory);
  const signer=dependencies.signer||createCdpSigner({...credentials,policyId:config.policyId});
  const registry=new EnrollmentStore(join(config.stateDir,'enrollment'),{projectId:config.projectId,expectedWallet:config.expectedWallet});
  let connection,activation,resources,listener,recoveryConnection,recovering,recoveryResources;
  const verifier=()=>dependencies.verifier||new ChainStripeVerifier({client:createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org',{retryCount:0,timeout:15000})}),stripeTestKey:credentials.stripeTestKey,merchantAccount:config.merchantAccount,fromBlock:BigInt(config.fromBlock)});
  const activate=grant=>{
    if(connection){if(resources.grantId!==grant.grantId)throw new PaymentError('GRANT_MISMATCH');resources.payer.assertActive();return Promise.resolve(connection);}
    if(activation)return activation;
    activation=(async()=>{
      let payer,merchant,server;
      try{
        // Registry verifies its preexisting payer ledger before exposing grant.
        const persisted=registry.get();if(!persisted||persisted.grantId!==grant.grantId)throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
        payer=new PaymentStore(registry.budgetStateDir,grant);payer.assertActive();
        merchant=new PaymentStore(join(config.stateDir,'merchant'),grant);
        const orderProvider=dependencies.orderProvider||new PrivateOrderProvider({directory:config.orderDirectory,grant,merchantAccount:config.merchantAccount});
        const merchantAdapter=dependencies.merchant||await createTestnetMerchant({store:merchant});
        const broker=new TestnetBroker({store:payer,signer,merchant:merchantAdapter,verifier:verifier()});
        const clientToken=randomBytes(32).toString('base64url');
        server=createBrokerHttpServer({broker,orderProvider,clientToken});await listen(server,0);
        // Revocation may have committed while facilitator initialization/listen
        // awaited. Never publish a new capability for that stopped mandate.
        payer.assertActive();
        resources={payer,merchant,server,broker,grantId:grant.grantId};
        connection=Object.freeze({brokerOrigin:`http://127.0.0.1:${server.address().port}`,clientToken});return connection;
      }catch(error){if(server?.listening)await close(server);payer?.close();merchant?.close();throw error;}
    })().finally(()=>{activation=undefined;});return activation;
  };
  const revoke=async grant=>{
    // Durable local stop first, even when activation/provider is unavailable.
    // A new login/session can never undo this flag or renew the original grant.
    const payer=resources?.payer||new PaymentStore(registry.budgetStateDir,grant);
    try{payer.revoke();}finally{if(payer!==resources?.payer)payer.close();}
    await signer.revoke(grant);
    return {revoked:true,issuedSignaturesMayRemainValidUntilExpiry:true};
  };
  const recover=grant=>{
    if(recoveryConnection)return Promise.resolve(recoveryConnection);
    if(recovering)return recovering;
    recovering=(async()=>{
      let payer,server;
      try{
        const persisted=registry.get();if(!persisted||persisted.grantId!==grant.grantId)throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
        payer=new PaymentStore(registry.budgetStateDir,grant);
        const forbidden=()=>{throw new PaymentError('BROKER_RECOVERY_ONLY');};
        // Never initialize a facilitator or expose a signer in recovery mode.
        const broker=new TestnetBroker({store:payer,signer:{sign:forbidden,revoke:forbidden},merchant:{settle:forbidden},verifier:verifier()});
        const clientToken=randomBytes(32).toString('base64url');
        server=createBrokerHttpServer({broker,orderProvider:{get:forbidden},clientToken,allowPayment:false});await listen(server,0);
        recoveryResources={payer,server};recoveryConnection=Object.freeze({brokerOrigin:`http://127.0.0.1:${server.address().port}`,clientToken});return recoveryConnection;
      }catch(error){if(server?.listening)await close(server);payer?.close();throw error;}
    })().finally(()=>{recovering=undefined;});return recovering;
  };
  const authority=new EnrollmentAuthority({signer,registry,config:Object.fromEntries(['projectId','expectedWallet','payTo','merchantOrigin','perCallAtomic','totalAtomic','durationMs'].map(key=>[key,config[key]])),activate,revoke,recover});
  listener=createEnrollmentHttpServer({authority,onboardingOrigin:config.onboardingOrigin});
  try{await listen(listener,config.enrollmentPort);}catch(error){registry.close();throw error;}
  return {enrollmentOrigin:`http://127.0.0.1:${config.enrollmentPort}`,testnetOnly:true,fundingAccepted:false,
    async close(){await close(listener);if(activation)await activation.catch(()=>{});if(recovering)await recovering.catch(()=>{});if(resources){await close(resources.server);resources.payer.close();resources.merchant.close();}if(recoveryResources){await close(recoveryResources.server);recoveryResources.payer.close();}registry.close();}};
}
