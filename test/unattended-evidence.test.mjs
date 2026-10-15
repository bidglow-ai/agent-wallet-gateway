import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeEventTopics,encodeAbiParameters,parseAbi,parseAbiParameters} from 'viem';
import {fixture} from './helpers/unattended.mjs';
import {TOKEN,orderNonce} from '../src/unattended/intent.mjs';
import {ChainStripeVerifier,verifyReceipt} from '../src/unattended/chain-stripe-verifier.mjs';
const ABI=parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)','event Transfer(address indexed from, address indexed to, uint256 value)']);
const tx='0x'+'aa'.repeat(32);
function receipt(order){return {status:'success',transactionHash:tx,blockHash:'0x'+'cc'.repeat(32),blockNumber:10n,logs:[
  {address:TOKEN,topics:encodeEventTopics({abi:ABI,eventName:'AuthorizationUsed',args:{authorizer:order.wallet,nonce:orderNonce(order)}}),data:'0x'},
  {address:TOKEN,topics:encodeEventTopics({abi:ABI,eventName:'Transfer',args:{from:order.wallet,to:order.payTo}}),data:encodeAbiParameters(parseAbiParameters('uint256'),[BigInt(order.amountAtomic)])},
]};}
function setup(){
  const f=fixture(),r=receipt(f.order),calls=[];
  const pi={object:'payment_intent',id:'pi_isolated',livemode:false,status:'succeeded',currency:'usd',amount:500,amount_received:500,payment_method_types:['crypto'],
    metadata:{broker_order_id:f.order.id,broker_order_digest:orderNonce(f.order),listing_id:f.order.listingId,board:f.order.board},
    payment_method_options:{crypto:{mode:'transaction_verification',transaction_verification_options:{network:'base',transaction_hash:tx}}}};
  const client={getChainId:async()=>84532,getTransactionReceipt:async()=>r,getBlockNumber:async()=>11n,
    getBlock:async args=>args.blockTag?{number:10n}:{number:10n,hash:r.blockHash},getLogs:async()=>[{transactionHash:tx}]};
  const transport=async(url,init)=>{calls.push({url,...init});const path=new URL(url).pathname;
    if(path==='/v1/account')return Response.json({object:'account',id:f.order.merchantAccount});
    if(path==='/v1/balance')return Response.json({object:'balance',livemode:false});
    if(init.method==='POST')return Response.json({id:pi.id});
    return Response.json(pi);
  };
  const options={client,stripeTestKey:'sk_test_'+'a'.repeat(24),merchantAccount:f.order.merchantAccount,fromBlock:1n,transport};
  return {...f,r,pi,client,transport,calls,options,verifier:new ChainStripeVerifier(options)};
}
test('independent receipt requires exact token, payer, payee, value and order-bound nonce',()=>{
  const {order}=fixture(),r=receipt(order);assert.equal(verifyReceipt(order,r,11n,{number:10n}).nonce,orderNonce(order));
  for(const changed of [{...r,status:'reverted'},{...r,logs:r.logs.slice(1)},{...r,logs:[...r.logs,r.logs[1]]},
    {...r,logs:r.logs.map(log=>({...log,address:'0x'+'22'.repeat(20)}))}])assert.throws(()=>verifyReceipt(order,changed,11n,{number:10n}));
  assert.throws(()=>verifyReceipt({...order,listingId:'different'},r,11n,{number:10n}));
  assert.throws(()=>verifyReceipt(order,r,10n,{number:10n}),/CHAIN_CONFIRMATION_PENDING/);
  assert.throws(()=>verifyReceipt(order,r,11n,{number:9n}),/CHAIN_CONFIRMATION_PENDING/);
});
test('fresh chain plus test-account plus Stripe PI evidence required, metadata is order-bound',async()=>{
  const f=setup(),result=await f.verifier.verify(f.order,tx);
  assert.equal(result.paymentIntentId,'pi_isolated');assert.equal(result.transactionHash,tx);
  const post=f.calls.find(call=>call.method==='POST');
  assert.equal(new URLSearchParams(post.body).get('metadata[broker_order_digest]'),orderNonce(f.order));
  assert.equal(post.headers['Idempotency-Key'],'bidglow-broker-test:'+tx);
  for(const call of f.calls)assert.equal(call.redirect,'error');
});
test('unknown settlement lookup is by exact wallet+signed nonce, not user supplied hash',async()=>{
  const f=setup();let queried;
  f.client.getLogs=async args=>{queried=args;return[{transactionHash:tx}];};
  assert.equal((await f.verifier.verify(f.order)).transactionHash,tx);
  assert.equal(queried.args.nonce,orderNonce(f.order));assert.equal(queried.args.authorizer,f.order.wallet);
  f.client.getLogs=async()=>[];await assert.rejects(()=>f.verifier.verify(f.order),/SETTLEMENT_NOT_LOCATED/);
});
test('wrong chain or receipt prevents ALL Stripe requests',async()=>{
  for(const mutate of [f=>{f.client.getChainId=async()=>8453;},f=>{f.r.logs=[];},f=>{f.r.transactionHash='0x'+'bb'.repeat(32);},
    f=>{f.client.getBlock=async args=>args.blockTag?{number:9n}:{number:10n,hash:f.r.blockHash};},
    f=>{f.client.getBlock=async()=>({number:10n,hash:'0x'+'ee'.repeat(32)});}]){
    const f=setup();mutate(f);await assert.rejects(()=>f.verifier.verify(f.order,tx));assert.equal(f.calls.length,0);
  }
});
test('Stripe pending, partial, wrong mode/metadata/transaction never confirms',async()=>{
  for(const changes of [{status:'processing',amount_received:0},{amount_received:499},{livemode:true},{currency:'eur'},
    {metadata:{}},{payment_method_types:['card']},{payment_method_options:{crypto:{mode:'other'}}}]){
    const f=setup();Object.assign(f.pi,changes);await assert.rejects(()=>f.verifier.verify(f.order,tx));
  }
});
test('Stripe recording retries are byte-identical and never interact with a signer or facilitator',async()=>{
  const f=setup();f.pi.status='processing';await assert.rejects(()=>f.verifier.verify(f.order,tx),/STRIPE_CONFIRMATION_PENDING/);
  f.pi.status='succeeded';await f.verifier.verify(f.order,tx);
  const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body,posts[1].body);
  assert.equal(posts[0].headers['Idempotency-Key'],posts[1].headers['Idempotency-Key']);
});
test('live keys, account-mode mismatch and provider errors fail without leaking diagnostics',async()=>{
  const f=setup();assert.throws(()=>new ChainStripeVerifier({...f.options,stripeTestKey:'sk_live_'+'a'.repeat(24)}));
  const fail=new ChainStripeVerifier({...f.options,transport:async()=>{throw new Error('sensitive-example');}});
  await assert.rejects(()=>fail.verify(f.order,tx),e=>e.code==='STRIPE_EVIDENCE_UNAVAILABLE'&&!e.message.includes('sensitive-example'));
  const wrong=new ChainStripeVerifier({...f.options,transport:async()=>Response.json({object:'balance',livemode:true})});
  await assert.rejects(()=>wrong.verify(f.order,tx),/STRIPE_SANDBOX_IDENTITY_MISMATCH/);
});
