import test from 'node:test';
import assert from 'node:assert/strict';
import {DELEGATION_DURATION_HOURS,DEFAULT_DURATION_MS,MAX_DELEGATION_MS,isAllowedDurationMs,isBoundedDelegationExpiry} from '../src/unattended/duration-policy.mjs';

test('local development duration policy defaults to30days, permits90days and retains exact short choices',()=>{
  assert.deepEqual(DELEGATION_DURATION_HOURS,[1,4,24,720,2160]);assert.ok(Object.isFrozen(DELEGATION_DURATION_HOURS));
  assert.equal(DEFAULT_DURATION_MS,30*24*3600000);assert.equal(MAX_DELEGATION_MS,90*24*3600000);
  for(const hours of DELEGATION_DURATION_HOURS)assert.equal(isAllowedDurationMs(hours*3600000),true);
  for(const value of [0,-1,1,172800000,MAX_DELEGATION_MS+1,Infinity,-Infinity,NaN,'2592000000',null,undefined,{},DEFAULT_DURATION_MS+0.5])assert.equal(isAllowedDurationMs(value),false);
  assert.throws(()=>DELEGATION_DURATION_HOURS.push(9999));
});
test('bounded provider expiry accepts exact30/90day boundaries, not indefinite, expired or >90day values',()=>{
  const now=1800000000000;
  for(const value of [now+1,now+DEFAULT_DURATION_MS,now+MAX_DELEGATION_MS])assert.equal(isBoundedDelegationExpiry(value,now),true);
  for(const value of [now,now-1,now+MAX_DELEGATION_MS+1,Infinity,-Infinity,NaN,String(now+DEFAULT_DURATION_MS),null,undefined,{}])assert.equal(isBoundedDelegationExpiry(value,now),false);
  for(const clock of [0,-1,Infinity,NaN,'1800000000000'])assert.equal(isBoundedDelegationExpiry(now+1,clock),false);
});
test('frontend and backend duration policy constants and exact supported milliseconds stay aligned',async()=>{
  const frontend=await import('../examples/email-onboarding/src/duration-policy.ts');
  assert.deepEqual(frontend.DELEGATION_DURATION_HOURS,DELEGATION_DURATION_HOURS);
  assert.equal(frontend.DEFAULT_DURATION_MS,DEFAULT_DURATION_MS);assert.equal(frontend.MAX_DELEGATION_MS,MAX_DELEGATION_MS);
  assert.ok(Object.isFrozen(frontend.DELEGATION_DURATION_HOURS));
  for(const value of [...DELEGATION_DURATION_HOURS.map(hours=>hours*3600000),0,MAX_DELEGATION_MS+1,Infinity,NaN,'2592000000',null])
    assert.equal(frontend.isAllowedDurationMs(value),isAllowedDurationMs(value));
});
