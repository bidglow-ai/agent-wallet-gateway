import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createWalletServer} from '../src/server.mjs';

// These are real MCP initialize/list/call exchanges for named client identities,
// NOT executions or acceptance of those vendors' native applications/models.
for (const name of ['codex-cli-protocol-fixture','claude-code-protocol-fixture','gemini-cli-protocol-fixture','cursor-protocol-fixture','cline-protocol-fixture']) {
  test(`${name}: standard MCP reads the same wallet, payment absent by default`,async()=>{
    const wallet='0x1111111111111111111111111111111111111111';
    const gateway={policy:null,ledger:null,status:async()=>({authenticated:true,paymentsEnabled:false}),
      provider:{address:async()=>wallet,balance:async()=>({asset:'USDC',amountAtomic:'0'})}};
    const server=createWalletServer(gateway), client=new Client({name,version:'0.0.0'});
    const [left,right]=InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(left),client.connect(right)]);
      const tools=await client.listTools();
      assert.deepEqual(tools.tools.map(x=>x.name).sort(),['wallet_address','wallet_balance','wallet_operation','wallet_status']);
      const result=await client.callTool({name:'wallet_address',arguments:{}});
      assert.equal(JSON.parse(result.content[0].text).address,wallet);
      const status=await client.callTool({name:'wallet_status',arguments:{}});
      assert.equal(JSON.parse(status.content[0].text).paymentsEnabled,false);
    } finally {await client.close();await server.close();}
  });
}
test('provider exceptions do not leak arbitrary error text through MCP',async()=>{
  const server=createWalletServer({policy:null,status:async()=>{throw new Error('sensitive-private-value');}});
  const client=new Client({name:'redaction-test',version:'0'});const [a,b]=InMemoryTransport.createLinkedPair();
  try {await Promise.all([server.connect(a),client.connect(b)]);
    const result=await client.callTool({name:'wallet_status',arguments:{}});
    assert.equal(result.isError,true);assert.equal(JSON.stringify(result).includes('sensitive-private-value'),false);
  } finally {await client.close();await server.close();}
});
test('enabling a payment policy cannot mount a live payment tool in this release',()=>{
  assert.throws(()=>createWalletServer({policy:{enabled:true}}),/PAYMENT_RELEASE_NOT_ACCEPTED/);
});
