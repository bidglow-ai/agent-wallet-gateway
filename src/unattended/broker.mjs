import {validateOrder,paymentPayload,orderNonce,PaymentError} from './intent.mjs';

function merchantAttested(value,order){
  try{
    const keys=['merchantVerified','testnetOnly','fundingAccepted','orderDigest'];
    if(!value||Object.getPrototypeOf(value)!==Object.prototype)return false;
    const ownKeys=Reflect.ownKeys(value);
    if(ownKeys.length!==keys.length||ownKeys.some(key=>!keys.includes(key)))return false;
    const fields=Object.fromEntries(keys.map(key=>{const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))throw new Error();return [key,d.value];}));
    return fields.merchantVerified===true&&fields.testnetOnly===true&&fields.fundingAccepted===false&&fields.orderDigest===orderNonce(order);
  }catch{return false;}
}

// Trusted service object. Do NOT pass the signer/CDP credentials to AI clients.
// Default AWAL MCP server does not import or expose this experimental broker.
export class TestnetBroker {
  #store;#signer;#merchant;#verifier;
  constructor({store,signer,merchant,verifier}){this.#store=store;this.#signer=signer;this.#merchant=merchant;this.#verifier=verifier;}
  inspect(id){
    const entry=this.#store.get(id);
    return entry?{orderId:id,state:entry.state,evidence:entry.evidence,automaticRetryAllowed:false,testnetOnly:true,productionRankUpdated:false}: {found:false};
  }
  async pay(input){
    const order=validateOrder(input,this.#store.grant);
    this.#store.assertActive();
    if(this.#store.get(order.id))throw new PaymentError('ORDER_ALREADY_EXISTS');
    // Pure merchant GETs precede allocation: failure cannot burn the allowance.
    // They are not a payment retry or authority to change a persisted budget.
    try{
      if(typeof this.#verifier?.preflight!=='function'||!merchantAttested(await this.#verifier.preflight(order),order))throw new Error();
    }catch{throw new PaymentError('MERCHANT_PREFLIGHT_UNVERIFIED');}
    // Reserve revalidates expiry, revocation, uniqueness and budget after the
    // await, and still commits BEFORE any signing or money-moving operation.
    this.#store.reserve(order);
    try{
      this.#store.assertActive();
      const signature=await this.#signer.sign(order,this.#store.grant);
      const payload=await paymentPayload(order,this.#store.grant,signature);
      this.#store.transition(order.id,'reserved','signed');
      this.#store.assertActive();
      this.#store.transition(order.id,'signed','settling');
      const settlement=await this.#merchant.settle(order,payload);
      // Treat provider success as provisional; preserve its transaction before
      // independent chain/Stripe checks so a later retry cannot transfer again.
      if(typeof settlement?.transactionHash!=='string'||!/^0x[0-9a-f]{64}$/.test(settlement.transactionHash))throw new PaymentError('SETTLEMENT_UNCONFIRMED');
      this.#store.transition(order.id,'settling','settled',{transactionHash:settlement.transactionHash});
      return await this.reconcile(order.id);
    }catch(error){
      const entry=this.#store.get(order.id);
      if(entry&&['reserved','signed','settling'].includes(entry.state))this.#store.transition(order.id,entry.state,'unknown',{reasonCode:'OUTCOME_UNCONFIRMED'});
      // No raw SDK responses, signatures, email or diagnostic text to an agent.
      return {...this.inspect(order.id),error:error instanceof PaymentError?error.code:'PAYMENT_UNCONFIRMED',needsReconciliation:true};
    }
  }
  async reconcile(id){
    const entry=this.#store.get(id);
    if(!entry)throw new PaymentError('ORDER_NOT_FOUND');
    if(entry.state==='confirmed')return this.inspect(id);
    if(!['reserved','signed','settling','settled','unknown'].includes(entry.state))throw new PaymentError('NO_SETTLEMENT_TO_RECONCILE');
    // Verifier obtains independent chain/provider evidence. Never a signing or
    // settling operation; callers cannot supply an arbitrary transaction hash.
    const evidence=await this.#verifier.verify(entry.order,entry.evidence.transactionHash);
    if(!evidence||evidence.orderId!==id||evidence.nonce!==entry.nonce||
      evidence.amountAtomic!==entry.order.amountAtomic||evidence.network!==entry.order.network||
      typeof evidence.transactionHash!=='string'||!/^0x[0-9a-f]{64}$/.test(evidence.transactionHash)||
      (entry.evidence.transactionHash&&evidence.transactionHash!==entry.evidence.transactionHash)||
      typeof evidence.paymentIntentId!=='string'||!/^pi_[A-Za-z0-9]+$/.test(evidence.paymentIntentId))throw new PaymentError('INDEPENDENT_EVIDENCE_UNVERIFIED');
    // A process may have died without running pay()'s catch handler. Recover
    // interrupted states from existing verified evidence, never by paying again.
    const current=this.#store.get(id);
    if(current.state==='confirmed')return this.inspect(id);
    if(['reserved','signed'].includes(current.state))this.#store.transition(id,current.state,'unknown',{reasonCode:'INTERRUPTED_OPERATION'});
    const state=this.#store.get(id).state;
    if(state==='settling')this.#store.transition(id,'settling','settled',{transactionHash:evidence.transactionHash});
    if(state==='unknown')this.#store.reconcileSettlement(id,{transactionHash:evidence.transactionHash});
    this.#store.transition(id,'settled','confirmed',{paymentIntentId:evidence.paymentIntentId});
    return this.inspect(id);
  }
  async revoke(){
    this.#store.revoke(); // Local stop is durable even if provider is unavailable.
    await this.#signer.revoke(this.#store.grant);
    return {revoked:true,issuedSignaturesMayRemainValidUntilExpiry:true};
  }
}
