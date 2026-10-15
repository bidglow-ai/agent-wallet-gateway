import {CdpClient} from '@coinbase/cdp-sdk';
import {AUTH_TYPES,TOKEN,PaymentError,validateGrant,paymentTypedData,paymentPayload} from './intent.mjs';
let configured=false;

// Reviewed public SDK only: no private AWAL IPC or raw signing tool for agents.
// This template is a proposed provider restriction, NOT evidence of deployment.
export function providerPolicy(grant){
  const g=validateGrant(grant);
  const reject=(operation,criteria)=>({action:'reject',operation,...(criteria?{criteria}: {})});
  const network=[{type:'evmNetwork',networks:['base','base-sepolia','ethereum','ethereum-sepolia','avalanche','polygon','optimism','arbitrum'],operator:'in'}];
  return {scope:'project',description:'BidGlow testnet typed payment only',rules:[
    {action:'accept',operation:'signEndUserEvmTypedData',criteria:[
      {type:'evmTypedDataVerifyingContract',addresses:[TOKEN],operator:'in'},
      {type:'evmTypedDataField',types:{types:AUTH_TYPES,primaryType:'TransferWithAuthorization'},conditions:[
        {path:'to',addresses:[g.payTo],operator:'in'},
        {path:'value',value:g.perCallAtomic,operator:'<='},
        {path:'value',value:'1',operator:'>='},
        {path:'validAfter',value:'0',operator:'=='},
      ]},
    ]},
    reject('signEndUserEvmHash'),
    reject('signEndUserEvmMessage',[{type:'evmMessage',match:'(?s).*'}]),
    reject('signEndUserEvmTransaction',[{type:'ethValue',ethValue:'0',operator:'>='}]),
    reject('sendEndUserEvmTransaction',network),
    reject('sendEndUserEvmAsset',network),
    reject('createEndUserEvmSwap',network),
    reject('sendEndUserOperation',[{type:'evmAddress',addresses:['0x0000000000000000000000000000000000000000'],operator:'not in'}]),
  ]};
}
function stable(value){
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export class CdpDelegatedSigner {
  #client;#policyId;
  constructor({client,policyId}){
    if(!client||typeof policyId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(policyId))throw new PaymentError('PROVIDER_CONFIGURATION_REQUIRED');
    this.#client=client;this.#policyId=policyId;
  }
  async verifySession({accessToken,wallet}){
    // Trusted HTTPS enrollment handler only, never an MCP tool. The subject
    // comes from Coinbase verification, not a client email/UUID/address claim.
    if(typeof accessToken!=='string'||accessToken.length<1||accessToken.length>16384||
      typeof wallet!=='string'||!/^0x[0-9a-f]{40}$/.test(wallet))throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
    try{
      const subject=await this.#client.endUser.validateAccessToken({accessToken});
      if(typeof subject?.userId!=='string')throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
      const user=await this.#client.endUser.getEndUser({userId:subject.userId});
      const account=user?.evmAccountObjects?.find(a=>a.address?.toLowerCase()===wallet);
      if(user?.userId!==subject.userId||!account||account.ejectedAt||account.exportedAt)throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
      return Object.freeze({userId:subject.userId,wallet});
    }catch(error){if(error instanceof PaymentError)throw error;throw new PaymentError('AUTHENTICATED_ENROLLMENT_UNCONFIRMED');}
  }
  async verifyEnrollment(input){
    const subject=await this.verifySession(input);
    try{
      const delegation=await this.#client.endUser.getDelegationForEndUserAccount({userId:subject.userId,address:subject.wallet});
      const expiresAt=Date.parse(delegation?.expiresAt),now=Date.now();
      if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+86400000)throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
      return Object.freeze({...subject,delegationExpiresAt:expiresAt});
    }catch(error){if(error instanceof PaymentError)throw error;throw new PaymentError('AUTHENTICATED_ENROLLMENT_UNCONFIRMED');}
  }
  async sign(order,grant,now=Date.now()){
    const g=validateGrant(grant),data=paymentTypedData(order,g,now);
    try{
      const [user,delegation,policy,projectPolicies]=await Promise.all([
        this.#client.endUser.getEndUser({userId:g.userId}),
        this.#client.endUser.getDelegationForEndUserAccount({userId:g.userId,address:g.wallet}),
        this.#client.policies.getPolicyById({id:this.#policyId}),
        this.#client.policies.listPolicies({scope:'project',pageSize:100}),
      ]);
      const account=user?.evmAccountObjects?.find(a=>a.address?.toLowerCase()===g.wallet);
      if(user?.userId!==g.userId||!account||account.ejectedAt||account.exportedAt)throw new PaymentError('PROVIDER_WALLET_UNVERIFIED');
      const until=Date.parse(delegation?.expiresAt);
      if(!Number.isSafeInteger(until)||until<=Date.now()||until<order.expiresAt||until>now+86400000)throw new PaymentError('DELEGATION_EXPIRED_OR_UNBOUNDED');
      const expected=providerPolicy(g);
      if(policy?.id!==this.#policyId||policy.scope!=='project'||stable(policy.rules)!==stable(expected.rules)||
        projectPolicies?.nextPageToken||projectPolicies?.pageToken||projectPolicies?.policies?.length!==1||
        projectPolicies.policies[0].id!==this.#policyId||stable(projectPolicies.policies[0].rules)!==stable(expected.rules))throw new PaymentError('PROVIDER_POLICY_UNVERIFIED');
      // Fresh local reconstruction, not arbitrary caller typed data. SDK expects
      // JSON uint256 strings. No signature returned until independent recovery.
      const typedData={...data,domain:{...data.domain},types:structuredClone(data.types),message:Object.fromEntries(Object.entries(data.message).map(([k,v])=>[k,typeof v==='bigint'?String(v):v]))};
      if(Date.now()>=Math.min(order.expiresAt,g.expiresAt))throw new PaymentError('ORDER_EXPIRED_OR_INVALID');
      const result=await this.#client.endUser.signEvmTypedData({userId:g.userId,address:g.wallet,typedData,idempotencyKey:order.id});
      await paymentPayload(order,g,result?.signature);
      return result.signature;
    }catch(error){
      if(error instanceof PaymentError)throw error;
      throw new PaymentError('PROVIDER_SIGNING_UNCONFIRMED');
    }
  }
  async revoke(grant){
    const g=validateGrant(grant);
    try{await this.#client.endUser.revokeDelegationForEndUserAccount({userId:g.userId,address:g.wallet});}
    catch{throw new PaymentError('PROVIDER_REVOCATION_UNCONFIRMED');}
  }
}

// Called only by a trusted operator process, never through MCP arguments. Do not
// pass these credentials to an AI process or publish them in configuration guides.
export function createCdpSigner({apiKeyId,apiKeySecret,walletSecret,policyId}){
  if(![apiKeyId,apiKeySecret,walletSecret].every(x=>typeof x==='string'&&x.length>10)||
    typeof policyId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(policyId))throw new PaymentError('PROVIDER_CONFIGURATION_REQUIRED');
  // The pinned SDK configures shared API state: isolate different projects in
  // different trusted processes, never overwrite each other's credentials.
  if(configured)throw new PaymentError('ONE_CDP_PROJECT_PER_PROCESS');
  process.env.DISABLE_CDP_ERROR_REPORTING='true';process.env.DISABLE_CDP_USAGE_TRACKING='true';
  const signer=new CdpDelegatedSigner({client:new CdpClient({apiKeyId,apiKeySecret,walletSecret,debugging:false}),policyId});
  configured=true;return signer;
}
