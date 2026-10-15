import {HTTPFacilitatorClient,x402ResourceServer} from '@x402/core/server';
import {ExactEvmScheme} from '@x402/evm/exact/server';
import {NETWORK,requirements,verifyOrderPayload,PaymentError} from './intent.mjs';

export async function createTestnetMerchant({store,facilitator}){
  const server=new x402ResourceServer(facilitator||new HTTPFacilitatorClient({url:'https://x402.org/facilitator',timeoutMs:15000}))
    .register(NETWORK,new ExactEvmScheme());
  await server.initialize();
  return {async settle(order,input){
    const payload=await verifyOrderPayload(order,store.grant,input);
    // In the production application this order must come from an authenticated,
    // frozen listing-owner quote. This isolated merchant is not a public route.
    store.reserve(order);
    try{
      const verified=await server.verifyPayment(payload,requirements(order));
      if(!verified.isValid||verified.payer?.toLowerCase()!==order.wallet)throw new PaymentError('FACILITATOR_VERIFICATION_REJECTED');
      store.transition(order.id,'reserved','signed');
      store.transition(order.id,'signed','settling');
      const result=await server.settlePayment(payload,requirements(order));
      if(!result.success||result.network!==NETWORK||result.payer?.toLowerCase()!==order.wallet||
        !/^0x[0-9a-fA-F]{64}$/.test(result.transaction||'')||(result.amount!==undefined&&result.amount!==order.amountAtomic))throw new PaymentError('SETTLEMENT_UNCONFIRMED');
      const transactionHash=result.transaction.toLowerCase();
      store.transition(order.id,'settling','settled',{transactionHash});
      return {transactionHash};
    }catch(error){
      const entry=store.get(order.id);
      if(entry&&['reserved','signed','settling'].includes(entry.state))store.transition(order.id,entry.state,'unknown',{reasonCode:'OUTCOME_UNCONFIRMED'});
      if(error instanceof PaymentError)throw error;
      throw new PaymentError('SETTLEMENT_UNCONFIRMED');
    }
  }};
}
