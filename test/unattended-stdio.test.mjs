import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {createBrokerHttpServer} from '../src/unattended/http.mjs';
import {fixture} from './helpers/unattended.mjs';

test('three real agent-facing stdio child processes use one authenticated local broker without developer keys',async t=>{
  const f=fixture(),clientToken=randomBytes(32).toString('base64url');let payments=0;
  const server=createBrokerHttpServer({clientToken,orderProvider:{get:async id=>id===f.order.id?f.order:null},broker:{pay:async()=>{payments++;return {state:'confirmed',testnetOnly:true};},inspect:()=>({state:'confirmed'}),reconcile:()=>({state:'confirmed'})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const clients=[];
  t.after(async()=>{for(const c of clients)await c.close();});
  for(let i=0;i<3;i++){
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/unattended/client.mjs',import.meta.url))],
      env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AGENT_BROKER_ORIGIN:'http://127.0.0.1:'+server.address().port,AGENT_BROKER_TOKEN:clientToken},stderr:'pipe'});
    const client=new Client({name:'real-stdio-sdk-probe-'+i,version:'0'});clients.push(client);
    await client.connect(transport);
    const ready=await client.callTool({name:'testnet_payment_readiness',arguments:{}});assert.equal(JSON.parse(ready.content[0].text).fundingAccepted,false);
    const result=await client.callTool({name:i===0?'testnet_pay_order':'testnet_payment_status',arguments:{orderId:f.order.id}});
    assert.equal(JSON.parse(result.content[0].text).state,'confirmed');
  }
  assert.equal(payments,1); // Fixture transport only; not a chain payment or model execution.
});
