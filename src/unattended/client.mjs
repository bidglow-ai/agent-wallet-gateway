#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {BrokerHttpClient} from './http.mjs';
import {createTestnetPaymentServer} from './mcp.mjs';

// Agent-facing child process: receives only a scoped local broker token, never
// developer credentials, a Wallet Secret or an email session. Operator must
// start/authenticate the separate trusted broker before configuring this client.
async function main(){
  if(['CDP_API_KEY_ID','CDP_API_KEY_NAME','CDP_API_KEY_SECRET','CDP_WALLET_SECRET','STRIPE_SECRET_KEY'].some(name=>process.env[name]))throw new Error('DEVELOPER_CREDENTIALS_NOT_ALLOWED_IN_AGENT_CLIENT');
  const broker=new BrokerHttpClient({origin:process.env.AGENT_BROKER_ORIGIN,clientToken:process.env.AGENT_BROKER_TOKEN});
  const server=createTestnetPaymentServer({broker,orderProvider:{get:async id=>({id})}});
  await server.connect(new StdioServerTransport());
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await server.close();};
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}
main().catch(()=>{process.stderr.write('Testnet broker client startup rejected. No credentials are logged.\n');process.exitCode=1;});
