import {randomUUID,randomBytes} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {NETWORK,TOKEN} from '../../src/unattended/intent.mjs';
export function fixture(){
  const signer=privateKeyToAccount(generatePrivateKey()),now=Date.now();
  const grant={grantId:randomUUID(),userId:randomUUID(),wallet:signer.address.toLowerCase(),network:NETWORK,asset:TOKEN,payTo:'0x1111111111111111111111111111111111111111',merchantOrigin:'https://merchant.example',perCallAtomic:'5000000',totalAtomic:'10000000',expiresAt:now+600000};
  const id=randomUUID();
  const order={version:1,id,grantId:grant.grantId,salt:'0x'+randomBytes(32).toString('hex'),merchantOrigin:grant.merchantOrigin,merchantAccount:'acct_isolatedtest',resourceURL:grant.merchantOrigin+'/orders/'+id,listingId:'isolated_example',board:'all',quoteId:randomUUID(),wallet:grant.wallet,payTo:grant.payTo,network:NETWORK,asset:TOKEN,amountAtomic:'5000000',createdAt:now,expiresAt:now+240000};
  return {signer,now,grant,order};
}
export function anotherOrder(order){const id=randomUUID();return {...order,id,resourceURL:order.merchantOrigin+'/orders/'+id,quoteId:randomUUID(),salt:'0x'+randomBytes(32).toString('hex')};}
