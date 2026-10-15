import {decodeEventLog,parseAbi} from 'viem';
import {TOKEN,CHAIN_ID,NETWORK,orderNonce,PaymentError} from './intent.mjs';
const ABI=parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)']);
const TX=/^0x[0-9a-f]{64}$/;

export function verifyReceipt(order,receipt,head,finalizedBlock){
  if(receipt?.status!=='success'||!TX.test(receipt.transactionHash||'')||typeof receipt.blockNumber!=='bigint'||
    !TX.test(receipt.blockHash||'')||typeof head!=='bigint'||head<receipt.blockNumber+1n||
    typeof finalizedBlock?.number!=='bigint'||finalizedBlock.number<receipt.blockNumber)throw new PaymentError('CHAIN_CONFIRMATION_PENDING');
  const transfers=[],authorizations=[];
  for(const log of receipt.logs||[]){
    if(log.address?.toLowerCase()!==TOKEN)continue;
    let event;try{event=decodeEventLog({abi:ABI,data:log.data,topics:log.topics});}catch{continue;}
    if(event.eventName==='Transfer'&&event.args.from.toLowerCase()===order.wallet)transfers.push(event.args);
    if(event.eventName==='AuthorizationUsed'&&event.args.authorizer.toLowerCase()===order.wallet)authorizations.push(event.args);
  }
  if(transfers.length!==1||authorizations.length!==1||transfers[0].to.toLowerCase()!==order.payTo||
    transfers[0].value!==BigInt(order.amountAtomic)||authorizations[0].nonce.toLowerCase()!==orderNonce(order))throw new PaymentError('CHAIN_ORDER_EVIDENCE_MISMATCH');
  return {transactionHash:receipt.transactionHash,nonce:orderNonce(order)};
}

export class ChainStripeVerifier {
  #client;#key;#account;#fetch;#fromBlock;
  constructor({client,stripeTestKey,merchantAccount,fromBlock,transport=fetch}){
    if(!/^sk_test_[A-Za-z0-9]{20,200}$/.test(stripeTestKey||'')||!/^acct_[A-Za-z0-9]{8,100}$/.test(merchantAccount||'')||
      typeof fromBlock!=='bigint'||fromBlock<0n)throw new PaymentError('SANDBOX_EVIDENCE_CONFIGURATION_REQUIRED');
    this.#client=client;this.#key=stripeTestKey;this.#account=merchantAccount;this.#fetch=transport;this.#fromBlock=fromBlock;
  }
  async #stripe(path,init={method:'GET'}){
    try{
      const response=await this.#fetch('https://api.stripe.com/v1'+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Authorization:'Bearer '+this.#key,'Stripe-Version':'2026-05-27.preview',
          'Content-Type':'application/x-www-form-urlencoded',...init.headers}});
      if(!response.ok)throw new Error();
      return await response.json();
    }catch{throw new PaymentError('STRIPE_EVIDENCE_UNAVAILABLE');}
  }
  async verify(order,transactionHash){
    if(order.network!==NETWORK||order.asset!==TOKEN||order.merchantAccount!==this.#account)throw new PaymentError('SANDBOX_EVIDENCE_CONFIGURATION_REQUIRED');
    let chain;
    try{
      if(await this.#client.getChainId()!==CHAIN_ID)throw new PaymentError('RPC_NETWORK_MISMATCH');
      if(!transactionHash){
        const logs=await this.#client.getLogs({address:TOKEN,abi:ABI,event:ABI[0],args:{authorizer:order.wallet,nonce:orderNonce(order)},fromBlock:this.#fromBlock,toBlock:'latest'});
        if(logs.length!==1||!TX.test(logs[0].transactionHash||''))throw new PaymentError('SETTLEMENT_NOT_LOCATED');
        transactionHash=logs[0].transactionHash;
      }
      if(!TX.test(transactionHash))throw new PaymentError('INVALID_TRANSACTION_HASH');
      const receipt=await this.#client.getTransactionReceipt({hash:transactionHash});
      if(receipt.transactionHash!==transactionHash)throw new PaymentError('CHAIN_ORDER_EVIDENCE_MISMATCH');
      const [head,finalizedBlock,canonicalBlock]=await Promise.all([
        this.#client.getBlockNumber(),this.#client.getBlock({blockTag:'finalized'}),
        this.#client.getBlock({blockNumber:receipt.blockNumber}),
      ]);
      if(canonicalBlock.hash!==receipt.blockHash||canonicalBlock.number!==receipt.blockNumber)throw new PaymentError('CHAIN_CANONICAL_BLOCK_MISMATCH');
      chain=verifyReceipt(order,receipt,head,finalizedBlock);
    }catch(error){if(error instanceof PaymentError)throw error;throw new PaymentError('CHAIN_EVIDENCE_UNAVAILABLE');}
    const [account,balance]=await Promise.all([this.#stripe('/account'),this.#stripe('/balance')]);
    if(account.object!=='account'||account.id!==this.#account||balance.object!=='balance'||balance.livemode!==false)throw new PaymentError('STRIPE_SANDBOX_IDENTITY_MISMATCH');
    const amount=String(BigInt(order.amountAtomic)/10000n);
    if(BigInt(order.amountAtomic)%10000n!==0n)throw new PaymentError('AMOUNT_NOT_WHOLE_CENTS');
    const body=new URLSearchParams({amount,currency:'usd',confirm:'true','payment_method_data[type]':'crypto','allowed_payment_method_types[0]':'crypto',
      'payment_method_options[crypto][mode]':'transaction_verification',
      'payment_method_options[crypto][transaction_verification_options][network]':'base',
      'payment_method_options[crypto][transaction_verification_options][transaction_hash]':chain.transactionHash,
      'metadata[broker_order_id]':order.id,'metadata[broker_order_digest]':chain.nonce,'metadata[listing_id]':order.listingId,'metadata[board]':order.board});
    const recorded=await this.#stripe('/payment_intents',{method:'POST',body:body.toString(),headers:{'Idempotency-Key':'bidglow-broker-test:'+chain.transactionHash}});
    if(!/^pi_[A-Za-z0-9]+$/.test(recorded.id||''))throw new PaymentError('STRIPE_EVIDENCE_MISMATCH');
    const pi=await this.#stripe('/payment_intents/'+recorded.id),tx=pi.payment_method_options?.crypto?.transaction_verification_options;
    if(pi.object!=='payment_intent'||pi.id!==recorded.id||pi.livemode!==false||pi.currency!=='usd'||pi.amount!==Number(amount)||
      pi.metadata?.broker_order_id!==order.id||pi.metadata?.broker_order_digest!==chain.nonce||pi.metadata?.listing_id!==order.listingId||pi.metadata?.board!==order.board||
      !pi.payment_method_types?.includes('crypto')||pi.payment_method_options?.crypto?.mode!=='transaction_verification'||tx?.network!=='base'||tx.transaction_hash?.toLowerCase()!==chain.transactionHash)throw new PaymentError('STRIPE_EVIDENCE_MISMATCH');
    if(pi.status==='processing')throw new PaymentError('STRIPE_CONFIRMATION_PENDING');
    if(pi.status!=='succeeded'||pi.amount_received!==Number(amount))throw new PaymentError('STRIPE_EVIDENCE_MISMATCH');
    return {orderId:order.id,nonce:chain.nonce,amountAtomic:order.amountAtomic,network:NETWORK,transactionHash:chain.transactionHash,paymentIntentId:pi.id};
  }
}
