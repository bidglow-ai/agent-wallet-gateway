import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {PaymentError} from './intent.mjs';
import {PaymentStoreError} from './store.mjs';

// Experimental service factory, never mounted by the existing AWAL entrypoint.
// The transport must authenticate a client to exactly one pre-authorized broker.
// No developer key, email token, arbitrary order or generic signing input is a tool.
export function createTestnetPaymentServer({broker,orderProvider}){
  const server=new McpServer({name:'bidglow-testnet-payment-broker',version:'0.0.1'},
    {instructions:'Experimental Base Sepolia TEST USDC only. No mainnet or funding acceptance. Use only orders covered by the owner mandate. Never request keys, OTP or developer credentials. Existing orders must be inspected/reconciled, not paid again under new IDs. This is not native-model or production ranking acceptance.'});
  const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
  const safe=fn=>async args=>{
    try{const value=await fn(args);return {...reply(value),...(value?.error?{isError:true}:{})};}
    catch(error){return {...reply({error:error instanceof PaymentError||error instanceof PaymentStoreError?error.code:'PAYMENT_REQUEST_REJECTED',automaticRetryAllowed:false}),isError:true};}
  };
  const read={readOnlyHint:true,destructiveHint:false};
  server.registerTool('testnet_payment_readiness',{description:'Development only. Funding and mainnet payments are not accepted.',inputSchema:{},annotations:read},safe(()=>({testnetOnly:true,mainnetEnabled:false,fundingAccepted:false,providerAcceptance:false,productionRankingAccepted:false})));
  server.registerTool('testnet_pay_order',{description:'Spend TEST USDC from this pre-authorized broker on one authenticated frozen order. Cannot sign arbitrary data or spend mainnet money.',inputSchema:{orderId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},safe(async({orderId})=>{
    const order=await orderProvider.get(orderId);
    if(!order||order.id!==orderId)throw new PaymentError('AUTHENTICATED_ORDER_REQUIRED');
    return broker.pay(order);
  }));
  server.registerTool('testnet_payment_status',{description:'Inspect saved payment without signing or sending again.',inputSchema:{orderId:z.string().uuid()},annotations:read},safe(({orderId})=>broker.inspect(orderId)));
  server.registerTool('testnet_payment_reconcile',{description:'Verify an existing test payment from chain/Stripe evidence; never signs or transfers. May record Stripe sandbox evidence.',inputSchema:{orderId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},safe(({orderId})=>broker.reconcile(orderId)));
  return server;
}
