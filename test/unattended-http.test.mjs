import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createBrokerHttpServer,BrokerHttpClient} from '../src/unattended/http.mjs';
import {fixture} from './helpers/unattended.mjs';
async function setup(t){
  const f=fixture(),clientToken=randomBytes(32).toString('base64url'),calls={pay:0,inspect:0,reconcile:0};
  const server=createBrokerHttpServer({clientToken,orderProvider:{get:async id=>id===f.order.id?f.order:null},broker:{
    pay:async order=>{calls.pay++;assert.equal(order.id,f.order.id);return{state:'confirmed',testnetOnly:true};},
    inspect:async()=>{calls.inspect++;return{state:'settled'};},reconcile:async()=>{calls.reconcile++;return{state:'confirmed'};}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin='http://127.0.0.1:'+server.address().port,client=new BrokerHttpClient({origin,clientToken});
  return {...f,server,origin,clientToken,client,calls};
}
test('actual local HTTP authenticates one scoped client and fetches only trusted frozen order',async t=>{
  const f=await setup(t);assert.equal((await f.client.pay({id:f.order.id,payTo:'ignored'})).state,'confirmed');
  await f.client.inspect(f.order.id);await f.client.reconcile(f.order.id);
  assert.deepEqual(f.calls,{pay:1,inspect:1,reconcile:1});
});
test('missing/wrong token, browser Origin, caller-supplied fields and query strings never pay',async t=>{
  const f=await setup(t),url=f.origin+'/v1/orders/'+f.order.id+'/pay';
  for(const headers of [{},{Authorization:'Bearer '+randomBytes(32).toString('base64url')},{Authorization:'Bearer '+f.clientToken,Origin:'https://evil.example'}]){
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'});assert.ok([401,403].includes(r.status));
  }
  for(const [path,body] of [[url,'{"amountAtomic":"1"}'],[url,'null'],[url+'?target=other','{}']]){
    const r=await fetch(path,{method:'POST',headers:{Authorization:'Bearer '+f.clientToken,'Content-Type':'application/json'},body});assert.ok(r.status>=400);
  }
  assert.equal(f.calls.pay,0);
});
test('unknown order and unconfirmed transport outcome cannot auto-retry',async t=>{
  const f=await setup(t);await assert.rejects(()=>f.client.pay({id:f.grant.grantId}),/BROKER_OUTCOME_UNCONFIRMED_USE_STATUS/);assert.equal(f.calls.pay,0);
  let calls=0;const client=new BrokerHttpClient({origin:f.origin,clientToken:f.clientToken,transport:async()=>{calls++;throw new Error('sensitive-example');}});
  await assert.rejects(()=>client.pay(f.order),e=>e.code==='BROKER_OUTCOME_UNCONFIRMED_USE_STATUS'&&!e.message.includes('sensitive-example'));assert.equal(calls,1);
});
test('public origins, credentials in URL and broad/insecure tokens cannot configure adapter',()=>{
  for(const origin of ['https://bidglow.ai','http://localhost:4321','http://127.0.0.1:4321/path','http://user:pass@127.0.0.1:4321'])assert.throws(()=>new BrokerHttpClient({origin,clientToken:'a'.repeat(43)}));
  assert.throws(()=>new BrokerHttpClient({origin:'http://127.0.0.1:4321',clientToken:'short'}));
});
