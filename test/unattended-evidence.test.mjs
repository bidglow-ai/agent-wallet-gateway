import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeEventTopics,encodeAbiParameters,parseAbi,parseAbiParameters,getAddress} from 'viem';
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
  const account={object:'account',id:f.order.merchantAccount,capabilities:{crypto_payments:'active'}},balance={object:'balance',livemode:false};
  const deposit={id:'cda_synthetic',object:'crypto.deposit_address',address:f.order.payTo,created:1,metadata:{},livemode:false,network:'base',
    supported_tokens:[{token_currency:'usdc',token_contract_address:TOKEN}]};
  const deposits={object:'list',data:[deposit],has_more:false};
  const pi={object:'payment_intent',id:'pi_isolated',livemode:false,status:'succeeded',currency:'usd',amount:500,amount_received:500,payment_method_types:['crypto'],
    metadata:{broker_order_id:f.order.id,broker_order_digest:orderNonce(f.order),listing_id:f.order.listingId,board:f.order.board},
    payment_method_options:{crypto:{mode:'transaction_verification',transaction_verification_options:{network:'base',transaction_hash:tx}}}};
  const client={getChainId:async()=>84532,getTransactionReceipt:async()=>r,getBlockNumber:async()=>11n,
    getBlock:async args=>args.blockTag?{number:10n}:{number:10n,hash:r.blockHash},getLogs:async()=>[{transactionHash:tx}]};
  const transport=async(url,init)=>{calls.push({url,...init});const path=new URL(url).pathname;
    if(path==='/v1/account')return Response.json(account);
    if(path==='/v1/balance')return Response.json(balance);
    if(path==='/v1/crypto/deposit_addresses')return Response.json(deposits);
    if(init.method==='POST')return Response.json({id:pi.id});
    return Response.json(pi);
  };
  const options={client,stripeTestKey:'sk_test_'+'a'.repeat(24),merchantAccount:f.order.merchantAccount,fromBlock:1n,transport};
  return {...f,r,pi,account,balance,deposit,deposits,client,transport,calls,options,verifier:new ChainStripeVerifier(options)};
}
test('merchant preflight is only three GETs, exact scope and per-request preview versions',async()=>{
  const f=setup();for(const key of Object.keys(f.client))f.client[key]=()=>assert.fail('preflight must not use RPC');
  assert.deepEqual(await f.verifier.preflight(f.order),{merchantVerified:true,testnetOnly:true,fundingAccepted:false,orderDigest:orderNonce(f.order)});
  assert.deepEqual(f.calls.map(call=>({url:call.url,method:call.method,version:call.headers['Stripe-Version']})),[
    {url:'https://api.stripe.com/v1/account',method:'GET',version:'2026-05-27.preview'},
    {url:'https://api.stripe.com/v1/balance',method:'GET',version:'2026-05-27.preview'},
    {url:'https://api.stripe.com/v1/crypto/deposit_addresses?network=base&address='+f.order.payTo+'&limit=2',method:'GET',version:'2026-10-14.preview'},
  ]);
  for(const call of f.calls){assert.equal(call.redirect,'error');assert.equal(call.body,undefined);assert.equal(call.headers.Authorization,'Bearer '+f.options.stripeTestKey);}
});
test('preflight rejects wrong scope locally before any Stripe or RPC request',async()=>{
  for(const changes of [{network:'eip155:8453'},{asset:'0x'+'a'.repeat(40)},{merchantAccount:'acct_different'},
    {payTo:'0x'+'A'.repeat(40)},{payTo:'0x'+'0'.repeat(40)},{payTo:'not-an-address'}]){
    const f=setup();await assert.rejects(()=>f.verifier.preflight({...f.order,...changes}),/SANDBOX_EVIDENCE_CONFIGURATION_REQUIRED/);
    await assert.rejects(()=>f.verifier.verify({...f.order,...changes},tx),/SANDBOX_EVIDENCE_CONFIGURATION_REQUIRED/);assert.equal(f.calls.length,0);
  }
});
test('provider EIP-55 address casing matches the exact canonical bytes, without trimming or fuzzy matching',async()=>{
  const f=setup();f.order.payTo='0x'+'ab'.repeat(20);f.deposit.address=getAddress(f.order.payTo);
  f.deposit.supported_tokens[0].token_contract_address=getAddress(TOKEN);
  assert.equal((await f.verifier.preflight(f.order)).orderDigest,orderNonce(f.order));
  for(const value of ['0x'+'ac'.repeat(20),f.deposit.address+' ',' '+f.deposit.address,'0x'+'g'.repeat(40),'0x'+'a'.repeat(39)]){
    const address=f.deposit.address;f.deposit.address=value;await assert.rejects(()=>f.verifier.preflight(f.order),/STRIPE_MERCHANT_PREFLIGHT_UNVERIFIED/);f.deposit.address=address;
  }
  for(const value of ['0x'+'ac'.repeat(20),getAddress(TOKEN)+' ','0x'+'g'.repeat(40),'0x'+'a'.repeat(39)]){
    f.deposit.supported_tokens[0].token_contract_address=value;await assert.rejects(()=>f.verifier.preflight(f.order),/STRIPE_MERCHANT_PREFLIGHT_UNVERIFIED/);
  }
});
test('merchant identity, inactive/pending capability, live balance and ambiguous deposit ownership all reject',async()=>{
  for(const mutate of [f=>{f.account.id='acct_different';},f=>{f.account.object='other';},f=>{delete f.account.capabilities;},
    f=>{f.account.capabilities.crypto_payments='pending';},f=>{f.account.capabilities.crypto_payments='inactive';},f=>{f.balance.livemode=true;},
    f=>{f.deposits.object='other';},f=>{f.deposits.data=[];},f=>{f.deposits.data.push({...f.deposit});},f=>{f.deposits.has_more=true;},f=>{delete f.deposits.has_more;},
    f=>{f.deposit.object='other';},f=>{f.deposit.address='0x'+'2'.repeat(40);},f=>{f.deposit.livemode=true;},f=>{f.deposit.network='solana';},
    f=>{f.deposit.customer='cus_other';},f=>{f.deposit.customer_account='acct_other';},f=>{f.deposit.customer='';},
    f=>{f.deposit.supported_tokens=[];},f=>{f.deposit.supported_tokens.push({...f.deposit.supported_tokens[0]});},
    f=>{f.deposit.supported_tokens[0].token_currency='eurc';},f=>{f.deposit.supported_tokens[0].token_contract_address='0x'+'a'.repeat(40);},
    f=>{f.deposit.supported_tokens[0].extra=true;}]){
    const f=setup();mutate(f);await assert.rejects(()=>f.verifier.preflight(f.order),/STRIPE_MERCHANT_PREFLIGHT_UNVERIFIED/);
    assert.ok(f.calls.every(call=>call.method==='GET'));assert.ok(!f.calls.some(call=>call.url.includes('payment_intents')));
  }
});
test('unsupported deposit GET preview, HTML/404 and transport diagnostics fail closed without version fallback',async()=>{
  for(const result of [()=>new Response('<html>synthetic-private</html>',{status:404}),()=>new Response('<html>synthetic-private</html>',{status:200}),
    ()=>Response.json({error:{message:'synthetic-private'}},{status:400}),()=>{throw new Error('synthetic-private');}]){
    const f=setup(),calls=[],verifier=new ChainStripeVerifier({...f.options,transport:async(url,init)=>{
      if(!url.includes('/crypto/deposit_addresses'))return f.transport(url,init);
      calls.push({url,...init});return result();
    }});
    await assert.rejects(()=>verifier.preflight(f.order),error=>error.code==='STRIPE_EVIDENCE_UNAVAILABLE'&&error.message==='STRIPE_EVIDENCE_UNAVAILABLE'&&
      !JSON.stringify(error).includes(f.options.stripeTestKey)&&!JSON.stringify(error).includes(f.order.payTo)&&!JSON.stringify(error).includes('synthetic-private'));
    assert.equal(calls.length,1);assert.equal(calls[0].headers['Stripe-Version'],'2026-10-14.preview');
  }
});
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
  assert.ok(f.calls.every(call=>call.headers['Stripe-Version']==='2026-05-27.preview'));
  assert.ok(!f.calls.some(call=>call.url.includes('/crypto/deposit_addresses')));
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
