import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
  env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AGENT_WALLET_AWAL:process.env.AGENT_WALLET_AWAL},stderr:'pipe'});
const client=new Client({name:'independent-local-stdio-probe',version:'0.1.0'});
try {
  await client.connect(transport);
  const tools=await client.listTools();
  const result=await client.callTool({name:'wallet_status',arguments:{}});
  const readiness=await client.callTool({name:'wallet_readiness',arguments:{}});
  if (result.isError || readiness.isError) throw new Error('READ_ONLY_PROBE_FAILED');
  const status=JSON.parse(result.content[0].text), release=JSON.parse(readiness.content[0].text);
  if (status.paymentsEnabled !== false || release.paymentsEnabled !== false || release.fundingForAutomatedPaymentsAccepted !== false) throw new Error('PAYMENT_BLOCK_UNVERIFIED');
  if (tools.tools.some(x=>/pay|send|sign|trade|auth/.test(x.name))) throw new Error('UNEXPECTED_TOOL');
  console.log(JSON.stringify({transport:'real-stdio-child-process',tools:tools.tools.map(x=>x.name),status,readiness:release,nativeClientAccepted:false,realPaymentAttempted:false},null,2));
} finally {await client.close();}
