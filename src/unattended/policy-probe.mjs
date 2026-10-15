import {randomBytes,randomUUID} from 'node:crypto';
import {isNativeError} from 'node:util/types';
import {recoverTypedDataAddress} from 'viem';
import {providerPolicy} from './cdp-signer.mjs';
import {AUTH_TYPES,CHAIN_ID,NETWORK,TOKEN,validateGrant} from './intent.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADDRESS=/^0x[0-9a-f]{40}$/;
const EVIDENCE_KEYS=['projectId','userId','wallet','payTo','merchantAccount','testnetOnly','fundingAccepted'];
const POLICY_KEYS=['id','scope','rules'];
const FIXTURE_ONE='0x1111111111111111111111111111111111111111';
const FIXTURE_TWO='0x2222222222222222222222222222222222222222';
const CATEGORIES=new Set(['EXPIRED_CONTROLS_PASSED','CONFIGURATION_REQUIRED','PRECONDITIONS_UNVERIFIED',
  'POSITIVE_CONTROL_UNCONFIRMED','POSITIVE_RECOVERY_UNCONFIRMED','NEGATIVE_NOT_POLICY_REJECTED','NEGATIVE_SIGNING_NOT_REJECTED']);

function fields(input,keys){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.getOwnPropertySymbols(input).length||
    Object.keys(input).sort().join('|')!==[...keys].sort().join('|'))throw new Error();
  const result={};
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value'))throw new Error();result[key]=d.value;}
  return result;
}
// Bounded, data-property-only comparison. Never stringify an SDK error or a
// caller object with accessors/toJSON hooks into a diagnostic.
function stable(value,depth=0){
  if(depth>20)throw new Error();
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value)){
    if(value.length>100)throw new Error();
    return '['+Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))throw new Error();return stable(d.value,depth+1);}).join(',')+']';
  }
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.getOwnPropertySymbols(value).length)throw new Error();
  const keys=Object.keys(value).sort();if(keys.length>100)throw new Error();
  return '{'+keys.map(key=>{const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))throw new Error();return JSON.stringify(key)+':'+stable(d.value,depth+1);}).join(',')+'}';
}
function configuration(evidence,installedPolicy,now){
  const e=fields(evidence,EVIDENCE_KEYS),p=fields(installedPolicy,POLICY_KEYS);
  if(!Number.isSafeInteger(now)||now<=0||!UUID.test(e.projectId)||!UUID.test(e.userId)||
    ![e.wallet,e.payTo].every(a=>typeof a==='string'&&ADDRESS.test(a)&&a!=='0x'+'0'.repeat(40))||
    !/^acct_[A-Za-z0-9]{8,100}$/.test(e.merchantAccount)||e.testnetOnly!==true||e.fundingAccepted!==false||
    typeof p.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(p.id)||p.scope!=='project')throw new Error();
  // Only payTo and the fixed five-test-USDC cap affect the proposed provider
  // policy. These local metadata values grant no new spending authority.
  const g=validateGrant({grantId:e.projectId,userId:e.userId,wallet:e.wallet,network:NETWORK,asset:TOKEN,
    payTo:e.payTo,merchantOrigin:'https://expired-policy-probe.invalid',perCallAtomic:'5000000',totalAtomic:'10000000',expiresAt:now+3600000});
  const expected=stable(providerPolicy(g).rules);
  if(stable(p.rules)!==expected)throw new Error();
  return {e:Object.freeze(e),policyId:p.id,expected};
}
async function verifyPreconditions(client,config,clock){
  const {e,policyId,expected}=config;
  const [user,delegation,policy,all]=await Promise.all([
    client.endUser.getEndUser({userId:e.userId}),
    client.endUser.getDelegationForEndUserAccount({userId:e.userId,address:e.wallet}),
    client.policies.getPolicyById({id:policyId}),
    client.policies.listPolicies({scope:'project',pageSize:100}),
  ]);
  const now=clock(),until=Date.parse(delegation?.expiresAt),accounts=user?.evmAccountObjects;
  if(!Number.isSafeInteger(now)||now<=0||!Number.isSafeInteger(until)||until<=now||until>now+86400000||
    user?.userId!==e.userId||!Array.isArray(accounts)||accounts.length!==1||
    typeof accounts[0]?.address!=='string'||accounts[0].address.toLowerCase()!==e.wallet||accounts[0].ejectedAt||accounts[0].exportedAt||
    policy?.id!==policyId||policy.scope!=='project'||stable(policy.rules)!==expected||
    all?.nextPageToken||all?.pageToken||!Array.isArray(all?.policies)||all.policies.length!==1||
    all.policies[0]?.id!==policyId||all.policies[0].scope!=='project'||stable(all.policies[0].rules)!==expected)throw new Error();
}
function typedData(e,change){
  const data={domain:{name:'USDC',version:'2',chainId:CHAIN_ID,verifyingContract:TOKEN},
    types:structuredClone(AUTH_TYPES),primaryType:'TransferWithAuthorization',
    message:{from:e.wallet,to:e.payTo,value:'5000000',validAfter:'0',validBefore:'1',nonce:'0x'+randomBytes(32).toString('hex')}};
  if(change==='wrong_payee')data.message.to=e.payTo===FIXTURE_ONE?FIXTURE_TWO:FIXTURE_ONE;
  else if(change==='excess_value')data.message.value='5000001';
  else if(change==='wrong_contract')data.domain.verifyingContract=FIXTURE_TWO;
  else if(change==='different_type'){
    data.types={ExpiredProbeAuthorization:data.types.TransferWithAuthorization};data.primaryType='ExpiredProbeAuthorization';
  }
  return data;
}
function report(status,category,{preconditionsVerified=false,positiveControlVerified=false,negativeTestsAttempted=0,negativeTestsRejected=0}={}){
  return Object.freeze({status,category:CATEGORIES.has(category)?category:'CONFIGURATION_REQUIRED',preconditionsVerified,positiveControlVerified,
    negativeTestsAttempted,negativeTestsRejected,testnetOnly:true,expiredAuthorizationsOnly:true,signingOnly:true,paymentInitiated:false,fundingAccepted:false});
}
function policyViolation(error){
  // Pinned SDK APIError extends Error and sets all three own data properties.
  // Its public root does not export APIError: do not import private SDK paths.
  // Plain errors/objects, accessors and inherited/nested fields are not proof.
  // No single HTTP status proves policy enforcement. The published OpenAPI
  // does not map policy_violation to one status, so accept only a structured
  // APIError 4xx, excluding auth/billing/missing/timeout/rate-limit statuses.
  try{
    if(!isNativeError(error))return false;
    const own=key=>Object.getOwnPropertyDescriptor(error,key)?.value;
    const status=own('statusCode');
    return own('name')==='APIError'&&own('errorType')==='policy_violation'&&
      Number.isInteger(status)&&status>=400&&status<500&&![401,402,404,408,429].includes(status);
  }catch{return false;}
}

// Trusted development operator only, NOT an MCP tool or generic signing API.
// Five finite, forever-expired sign-only requests; no transaction, settlement,
// facilitator, Stripe, faucet, broadcast or persistent budget is reachable here.
// Project identity remains the operator's isolated-key assertion: these SDK GET
// responses do not independently expose the project ID.
export async function runExpiredPolicyProbe({client,evidence,installedPolicy,clock=Date.now}={}){
  let config;
  try{config=configuration(evidence,installedPolicy,clock());}
  catch{return report('INCONCLUSIVE','CONFIGURATION_REQUIRED');}
  const counts={preconditionsVerified:false,positiveControlVerified:false,negativeTestsAttempted:0,negativeTestsRejected:0};
  try{await verifyPreconditions(client,config,clock);counts.preconditionsVerified=true;}
  catch{return report('INCONCLUSIVE','PRECONDITIONS_UNVERIFIED',counts);}
  const control=typedData(config.e);
  let result;
  try{result=await client.endUser.signEvmTypedData({userId:config.e.userId,address:config.e.wallet,typedData:control,idempotencyKey:randomUUID()});}
  catch{return report('INCONCLUSIVE','POSITIVE_CONTROL_UNCONFIRMED',counts);}
  try{
    if(typeof result?.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(result.signature)||
      (await recoverTypedDataAddress({...control,signature:result.signature})).toLowerCase()!==config.e.wallet)throw new Error();
    counts.positiveControlVerified=true;
  }catch{return report('INCONCLUSIVE','POSITIVE_RECOVERY_UNCONFIRMED',counts);}
  finally{result=undefined;}
  for(const name of ['wrong_payee','excess_value','wrong_contract','different_type']){
    try{await verifyPreconditions(client,config,clock);}
    catch{return report('INCONCLUSIVE','PRECONDITIONS_UNVERIFIED',counts);}
    const data=typedData(config.e,name);counts.negativeTestsAttempted++;
    try{
      // Deliberately discard even an unexpected signature. Every request has
      // validBefore=1, so this suite cannot produce a live authorization.
      await client.endUser.signEvmTypedData({userId:config.e.userId,address:config.e.wallet,typedData:data,idempotencyKey:randomUUID()});
      return report('FAILED','NEGATIVE_SIGNING_NOT_REJECTED',counts);
    }catch(error){
      if(!policyViolation(error))return report('INCONCLUSIVE','NEGATIVE_NOT_POLICY_REJECTED',counts);
      counts.negativeTestsRejected++;
    }
  }
  return report('PASSED','EXPIRED_CONTROLS_PASSED',counts);
}
