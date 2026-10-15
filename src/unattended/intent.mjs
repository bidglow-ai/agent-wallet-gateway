import {createHash} from 'node:crypto';
import {recoverTypedDataAddress} from 'viem';

// No environment variable can switch this implementation to mainnet.
export const NETWORK='eip155:84532';
export const CHAIN_ID=84532;
export const TOKEN='0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADDRESS=/^0x[0-9a-f]{40}$/;
const HASH=/^0x[0-9a-f]{64}$/;
const GRANT_KEYS=['grantId','userId','wallet','network','asset','payTo','merchantOrigin','perCallAtomic','totalAtomic','expiresAt'];
const ORDER_KEYS=['version','id','grantId','salt','merchantOrigin','merchantAccount','resourceURL','listingId','board','quoteId','wallet','payTo','network','asset','amountAtomic','createdAt','expiresAt'];
export class PaymentError extends Error {constructor(code){super(code);this.code=code;}}
function fail(code){throw new PaymentError(code);}
function plain(value,keys){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||
    Object.keys(value).sort().join('|')!==[...keys].sort().join('|')) fail('INVALID_FIELDS');
  // Copy only data properties; invoking getters or custom iterators is forbidden.
  const result={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!('value' in descriptor))fail('INVALID_FIELDS');result[key]=descriptor.value;}
  return result;
}
function address(value){if(typeof value!=='string'||!ADDRESS.test(value)||/^0x0{40}$/.test(value))fail('INVALID_ADDRESS');}
function integer(value){if(!Number.isSafeInteger(value)||value<=0)fail('INVALID_TIME');}
function atomic(value,max){if(typeof value!=='string'||!/^[1-9][0-9]{0,7}$/.test(value)||BigInt(value)>max)fail('INVALID_AMOUNT');}
function origin(value){let url;try{url=new URL(value);}catch{fail('INVALID_MERCHANT');}
  if(typeof value!=='string'||url.protocol!=='https:'||url.origin!==value||url.username||url.password)fail('INVALID_MERCHANT');}
export function validateGrant(input){
  const g=plain(input,GRANT_KEYS);
  if(!UUID.test(g.grantId)||!UUID.test(g.userId))fail('INVALID_GRANT_ID');
  address(g.wallet);address(g.payTo);origin(g.merchantOrigin);integer(g.expiresAt);
  if(g.network!==NETWORK||g.asset!==TOKEN)fail('TESTNET_USDC_ONLY');
  atomic(g.perCallAtomic,5000000n);atomic(g.totalAtomic,10000000n);
  if(BigInt(g.perCallAtomic)>BigInt(g.totalAtomic))fail('INVALID_AMOUNT');
  return Object.freeze(g);
}
export function validateOrder(input,grant,now=Date.now()){
  const g=validateGrant(grant),o=plain(input,ORDER_KEYS);
  if(o.version!==1||!UUID.test(o.id)||!UUID.test(o.quoteId)||o.grantId!==g.grantId||!HASH.test(o.salt)||/^0x0{64}$/.test(o.salt))fail('INVALID_ORDER_ID');
  if(typeof o.merchantAccount!=='string'||!/^acct_[A-Za-z0-9]{8,100}$/.test(o.merchantAccount)||
    typeof o.listingId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(o.listingId)||!['all','today'].includes(o.board))fail('INVALID_ORDER_SCOPE');
  for(const key of ['wallet','payTo','network','asset','merchantOrigin'])if(o[key]!==g[key])fail('ORDER_GRANT_MISMATCH');
  if(o.resourceURL!==`${g.merchantOrigin}/orders/${o.id}`)fail('ORDER_RESOURCE_MISMATCH');
  atomic(o.amountAtomic,BigInt(g.perCallAtomic));
  if(BigInt(o.amountAtomic)%10000n!==0n)fail('AMOUNT_NOT_WHOLE_CENTS');
  integer(o.createdAt);integer(o.expiresAt);integer(now);
  if(o.createdAt>now||o.expiresAt<=now||o.expiresAt>g.expiresAt||o.expiresAt-o.createdAt>300000||o.expiresAt<=o.createdAt||
    Math.floor(o.expiresAt/1000)<=Math.floor(now/1000)||
    (o.board==='today'&&o.expiresAt>new Date(o.createdAt).setUTCHours(24,0,0,0)))fail('ORDER_EXPIRED_OR_INVALID');
  return Object.freeze(o);
}
export function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isSafeInteger(value)))return JSON.stringify(value);
  if(value&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('INVALID_CANONICAL_VALUE');
}
export function orderNonce(order){return '0x'+createHash('sha256').update('BidGlow:EIP3009:FrozenOrder:v1\n'+canonical(order)).digest('hex');}
export const AUTH_TYPES=Object.freeze({TransferWithAuthorization:Object.freeze([
  Object.freeze({name:'from',type:'address'}),Object.freeze({name:'to',type:'address'}),
  Object.freeze({name:'value',type:'uint256'}),Object.freeze({name:'validAfter',type:'uint256'}),
  Object.freeze({name:'validBefore',type:'uint256'}),Object.freeze({name:'nonce',type:'bytes32'}),
])});
export function paymentTypedData(input,grant,now=Date.now()){
  const o=validateOrder(input,grant,now);
  return Object.freeze({domain:Object.freeze({name:'USDC',version:'2',chainId:CHAIN_ID,verifyingContract:TOKEN}),
    types:AUTH_TYPES,primaryType:'TransferWithAuthorization',message:Object.freeze({from:o.wallet,to:o.payTo,
      value:BigInt(o.amountAtomic),validAfter:0n,validBefore:BigInt(Math.floor(o.expiresAt/1000)),nonce:orderNonce(o)})});
}
export async function paymentPayload(order,grant,signature,now=Date.now()){
  const data=paymentTypedData(order,grant,now);
  if(typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature))fail('INVALID_SIGNATURE');
  let signer;try{signer=await recoverTypedDataAddress({...data,signature});}catch{fail('INVALID_SIGNATURE');}
  if(signer.toLowerCase()!==order.wallet)fail('SIGNER_MISMATCH');
  return {x402Version:2,resource:{url:order.resourceURL,description:'Isolated BidGlow order; no production ranking',mimeType:'application/json'},
    accepted:requirements(order),payload:{signature,authorization:{from:order.wallet,to:order.payTo,value:order.amountAtomic,
      validAfter:'0',validBefore:String(data.message.validBefore),nonce:data.message.nonce}}};
}
export function requirements(order){return {scheme:'exact',network:NETWORK,asset:TOKEN,amount:order.amountAtomic,payTo:order.payTo,maxTimeoutSeconds:300,extra:{name:'USDC',version:'2'}};}

// Merchant independently recomputes the signed nonce and recovers the payer.
// An unsigned resource/envelope rewrite cannot retarget the authorization.
export async function verifyOrderPayload(order,grant,input,now=Date.now()){
  validateOrder(order,grant,now);
  const p=plain(input,['x402Version','resource','accepted','payload']);
  const body=plain(p.payload,['signature','authorization']);
  const expected=await paymentPayload(order,grant,body.signature,now);
  if(canonical(p)!==canonical(expected))fail('PAYMENT_ORDER_BINDING_MISMATCH');
  return expected;
}
