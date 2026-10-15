import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createTestnetPaymentServer} from '../src/unattended/mcp.mjs';
import {fixture} from './helpers/unattended.mjs';
import {anotherOrder} from './helpers/unattended.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentStore} from '../src/unattended/store.mjs';
import {TestnetBroker} from '../src/unattended/broker.mjs';
import {paymentTypedData,orderNonce} from '../src/unattended/intent.mjs';

for(const name of ['Codex-protocol-fixture','Claude-protocol-fixture','Gemini-protocol-fixture','Cursor-protocol-fixture','Cline-protocol-fixture']){
  test(`${name}: restricted common payment tools, not native-vendor acceptance`,async()=>{
    const f=fixture();let calls=0;
    const broker={pay:async order=>{assert.equal(order.id,f.order.id);calls++;return{state:'confirmed',testnetOnly:true,productionRankUpdated:false};},
      inspect:()=>({state:'confirmed'}),reconcile:async()=>({state:'confirmed'})};
    const server=createTestnetPaymentServer({broker,orderProvider:{get:async id=>id===f.order.id?f.order:null}});
    const client=new Client({name,version:'0.0.0'}),[a,b]=InMemoryTransport.createLinkedPair();
    try{
      await Promise.all([server.connect(a),client.connect(b)]);
      const tools=await client.listTools();assert.equal(tools.tools.length,4);
      assert.ok(!tools.tools.some(t=>/sign|send|key|delegate|login/.test(t.name)));
      const ready=await client.callTool({name:'testnet_payment_readiness',arguments:{}});
      assert.equal(JSON.parse(ready.content[0].text).fundingAccepted,false);
      const result=await client.callTool({name:'testnet_pay_order',arguments:{orderId:f.order.id}});
      assert.equal(JSON.parse(result.content[0].text).state,'confirmed');assert.equal(calls,1);
      const wrong=await client.callTool({name:'testnet_pay_order',arguments:{orderId:f.grant.grantId}});
      assert.equal(wrong.isError,true);assert.equal(calls,1);
    }finally{await client.close();await server.close();}
  });
}
test('unknown payment is a protocol error, not a successful tool payment',async()=>{
  const f=fixture(),server=createTestnetPaymentServer({broker:{pay:async()=>({state:'unknown',error:'PAYMENT_UNCONFIRMED',automaticRetryAllowed:false})},orderProvider:{get:async()=>f.order}});
  const client=new Client({name:'unknown-payment-fixture',version:'0'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{await Promise.all([server.connect(a),client.connect(b)]);
    const result=await client.callTool({name:'testnet_pay_order',arguments:{orderId:f.order.id}});
    assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).state,'unknown');
  }finally{await client.close();await server.close();}
});
test('five SDK sessions share one actual broker ledger: two $5 test reservations, no per-agent budget reset',async t=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'shared-mcp-broker-')),store=new PaymentStore(dir,f.grant);
  let signs=0,settles=0;const clients=[],servers=[],orders=new Map();
  t.after(async()=>{for(const c of clients)await c.close();for(const s of servers)await s.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const broker=new TestnetBroker({store,signer:{sign:order=>{signs++;return f.signer.signTypedData(paymentTypedData(order,f.grant));}},
    merchant:{settle:async order=>{settles++;return{transactionHash:'0x'+order.id.replaceAll('-','').padEnd(64,'0')};}},
    verifier:{verify:async(order,hash)=>({orderId:order.id,nonce:orderNonce(order),amountAtomic:order.amountAtomic,network:order.network,transactionHash:hash,paymentIntentId:'pi_'+order.id.replaceAll('-','')})}});
  for(let i=0;i<5;i++){
    const order=anotherOrder(f.order);orders.set(order.id,order);
    const server=createTestnetPaymentServer({broker,orderProvider:{get:async id=>orders.get(id)}}),client=new Client({name:'independent-sdk-session-'+i,version:'0'}),[a,b]=InMemoryTransport.createLinkedPair();
    clients.push(client);servers.push(server);await Promise.all([server.connect(a),client.connect(b)]);
  }
  const ids=[...orders.keys()],results=await Promise.all(clients.map((client,i)=>client.callTool({name:'testnet_pay_order',arguments:{orderId:ids[i]}})));
  assert.equal(results.filter(r=>!r.isError&&JSON.parse(r.content[0].text).state==='confirmed').length,2);
  assert.equal(results.filter(r=>r.isError).length,3);assert.equal(signs,2);assert.equal(settles,2);
  assert.equal(store.summary().allocatedAtomic,'10000000');
});
