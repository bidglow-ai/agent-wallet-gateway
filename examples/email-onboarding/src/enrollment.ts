// Browser-only protocol validation. No wallet/developer secret is configured here.
export class EnrollmentError extends Error {}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADDRESS=/^0x[0-9a-f]{40}$/;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
export type Mandate = {grantId:string;userId:string;wallet:string;network:string;asset:string;payTo:string;merchantOrigin:string;perCallAtomic:string;totalAtomic:string;expiresAt:number};
export type Proposal = {nonce:string;challengeExpiresAt:number;grant:Mandate;existing:boolean};
export type AgentConnection = {brokerOrigin:string;clientToken:string};
function reject():never{throw new EnrollmentError('ENROLLMENT_RESPONSE_REQUIRES_REVIEW');}
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))return reject();
  return value as Record<string,unknown>;
}
export function enrollmentOrigin(value:string){
  let url;try{url=new URL(value);}catch{throw new EnrollmentError('TRUSTED_ENROLLMENT_ORIGIN_REQUIRED');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.origin!==value||url.username||url.password)throw new EnrollmentError('TRUSTED_ENROLLMENT_ORIGIN_REQUIRED');
  return value;
}
function flags(value:Record<string,unknown>){if(value.testnetOnly!==true||value.mainnetEnabled!==false||value.fundingAccepted!==false)reject();}
function mandate(value:unknown,wallet:string,userId:string,allowExpired=false):Mandate{
  const g=record(value,['grantId','userId','wallet','network','asset','payTo','merchantOrigin','perCallAtomic','totalAtomic','expiresAt']);
  if(typeof g.grantId!=='string'||!UUID.test(g.grantId)||typeof g.userId!=='string'||!UUID.test(g.userId)||g.userId!==userId||g.wallet!==wallet||
    typeof g.payTo!=='string'||!ADDRESS.test(g.payTo)||/^0x0{40}$/.test(g.payTo)||
    g.network!=='eip155:84532'||g.asset!=='0x036cbd53842c5426634e7929541ec2318f3dcf7e'||
    g.perCallAtomic!=='5000000'||g.totalAtomic!=='10000000'||typeof g.expiresAt!=='number'||!Number.isSafeInteger(g.expiresAt)||
    g.expiresAt<=0||(!allowExpired&&g.expiresAt<=Date.now())||g.expiresAt>Date.now()+86400000||typeof g.merchantOrigin!=='string')reject();
  let origin;try{origin=new URL(g.merchantOrigin as string);}catch{return reject();}
  if(origin.protocol!=='https:'||origin.origin!==g.merchantOrigin||origin.username||origin.password)reject();
  return Object.freeze({...g}) as Mandate;
}
export function validateProposal(value:unknown,wallet:string,userId:string):Proposal{
  const p=record(value,['nonce','challengeExpiresAt','grant','existing','testnetOnly','mainnetEnabled','fundingAccepted']);flags(p);
  const grant=mandate(p.grant,wallet,userId);
  if(typeof p.nonce!=='string'||!NONCE.test(p.nonce)||typeof p.existing!=='boolean'||typeof p.challengeExpiresAt!=='number'||
    !Number.isSafeInteger(p.challengeExpiresAt)||p.challengeExpiresAt<=Date.now()||p.challengeExpiresAt>Date.now()+120000||p.challengeExpiresAt>grant.expiresAt)reject();
  return Object.freeze({nonce:p.nonce,challengeExpiresAt:p.challengeExpiresAt,grant,existing:p.existing}) as Proposal;
}
export function validateConfirmation(value:unknown,proposal:Proposal,wallet:string,userId:string){
  const p=record(value,['grant','agentConnection','testnetOnly','mainnetEnabled','fundingAccepted']);flags(p);
  const grant=mandate(p.grant,wallet,userId);
  if(Object.keys(grant).some(key=>grant[key as keyof Mandate]!==proposal.grant[key as keyof Mandate]))reject();
  const c=record(p.agentConnection,['brokerOrigin','clientToken']);
  if(typeof c.brokerOrigin!=='string'||typeof c.clientToken!=='string'||!NONCE.test(c.clientToken))reject();
  enrollmentOrigin(c.brokerOrigin);
  return {grant,connection:Object.freeze({brokerOrigin:c.brokerOrigin,clientToken:c.clientToken}) as AgentConnection};
}
export function validateRecovery(value:unknown,wallet:string,userId:string){
  const p=record(value,['grant','agentConnection','recoveryOnly','testnetOnly','mainnetEnabled','fundingAccepted']);flags(p);
  if(p.recoveryOnly!==true)reject();
  const grant=mandate(p.grant,wallet,userId,true),c=record(p.agentConnection,['brokerOrigin','clientToken']);
  if(typeof c.brokerOrigin!=='string'||typeof c.clientToken!=='string'||!NONCE.test(c.clientToken))reject();
  enrollmentOrigin(c.brokerOrigin);
  return {grant,connection:Object.freeze({brokerOrigin:c.brokerOrigin,clientToken:c.clientToken}) as AgentConnection};
}
export function validateRevocation(value:unknown){
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)return reject();
  const result=value as Record<string,unknown>;
  if(result.revoked!==true||Object.keys(result).some(key=>!['revoked','issuedSignaturesMayRemainValidUntilExpiry'].includes(key))||
    (result.issuedSignaturesMayRemainValidUntilExpiry!==undefined&&result.issuedSignaturesMayRemainValidUntilExpiry!==true))reject();
}
export async function enrollmentRequest(origin:string,action:'proposal'|'confirm'|'revoke'|'recover',accessToken:string|null,body:object,transport:typeof fetch){
  enrollmentOrigin(origin);
  if(typeof accessToken!=='string'||! /^[A-Za-z0-9._~-]{1,16384}$/.test(accessToken))throw new EnrollmentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
  try{
    const response=await transport(`${origin}/enrollment/v1/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+accessToken},
      body:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.headers.get('Content-Type')?.startsWith('application/json'))throw new Error();
    return await response.json() as unknown;
  }catch{throw new EnrollmentError('ENROLLMENT_OUTCOME_UNCONFIRMED');}
}
