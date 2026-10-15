import test from 'node:test';
import assert from 'node:assert/strict';
import {WalletGateway} from '../src/gateway.mjs';

for (const policy of [null, {enabled:false}, {enabled:true}]) {
  test(`direct pay rejects before provider or ledger access: ${JSON.stringify(policy)}`,async()=>{
    const forbidden=new Proxy({}, {get(){assert.fail('must not access provider or ledger');}});
    const gateway=new WalletGateway(forbidden,forbidden,policy);
    await assert.rejects(()=>gateway.pay({amountAtomic:'5000000'}),/PAYMENT_RELEASE_NOT_ACCEPTED/);
  });
}
test('readiness reports blockers without external calls or funding acceptance',()=>{
  const forbidden=new Proxy({}, {get(){assert.fail('readiness must be static');}});
  const result=new WalletGateway(forbidden,forbidden,{enabled:true}).readiness();
  assert.equal(result.paymentsEnabled,false);
  assert.equal(result.fundingForAutomatedPaymentsAccepted,false);
  assert.equal(result.liveSignerConfigured,false);
  assert.equal(result.sharedGatewayBudgetIsWalletWide,false);
  assert.equal(result.blockers.length,5);
});
test('status never advertises payment enabled, even for a direct enabled policy',async()=>{
  const gateway=new WalletGateway({status:async()=>({authenticated:true,paymentsEnabled:true})},null,{enabled:true});
  assert.equal((await gateway.status()).paymentsEnabled,false);
});
