import { initialize, getCurrentUser, signInWithEmail, verifyEmailOTP, getDelegationForAccount,
  createDelegationForAccount, revokeDelegationForAccount, signOut, getAccessToken, onAuthStateChange } from '@coinbase/cdp-core';
import { OnboardingController, OnboardingError } from './controller.ts';
import './style.css';

const controller = new OnboardingController({ initialize, getCurrentUser, signInWithEmail, verifyEmailOTP,
  getDelegationForAccount, createDelegationForAccount, revokeDelegationForAccount, signOut, getAccessToken, onAuthStateChange }, {
  projectId: import.meta.env.VITE_CDP_PROJECT_ID || '',
  developmentConfirmed: import.meta.env.VITE_DEVELOPMENT_PROJECT_CONFIRMED === 'true',
  enrollmentOrigin: import.meta.env.VITE_ENROLLMENT_ORIGIN || '',
}, window.location.href, fetch, ()=>render());
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing UI element');
  return value as T;
}
const email = element<HTMLInputElement>('email'), otp = element<HTMLInputElement>('otp'), account = element<HTMLSelectElement>('account');
const consent = element<HTMLInputElement>('consent'), hours = element<HTMLSelectElement>('hours');
const status = element<HTMLElement>('status');
const mandateConsent=element<HTMLInputElement>('mandate-consent'),revokeConsent=element<HTMLInputElement>('revoke-consent'),recoveryConsent=element<HTMLInputElement>('recovery-consent');
let uiBusy = false;
// The pending email is private UI memory, never part of controller.state().
let pendingEmail = '', wasAuthenticated = false;
function clearSignInFields() { pendingEmail=''; email.value=''; otp.value=''; }
const messages: Record<string, string> = {
  DEVELOPMENT_PROJECT_REQUIRED: 'Set the public development project ID and confirm the separate development project before continuing.',
  LOOPBACK_DEVELOPMENT_ONLY: 'This example runs only on a loopback HTTP development origin.',
  PROVIDER_OPERATION_UNCONFIRMED: 'The provider did not confirm the operation. Do not assume authentication, delegation or revocation succeeded. Refresh its status.',
  OTP_CODE_NOT_ACCEPTED: 'Sign-in was not confirmed. Enter the latest verification code for the displayed email, or request a new code.',
  DELEGATION_STATUS_UNCONFIRMED: 'Delegation status is unavailable. No new delegation was requested.',
  REVIEW_EXISTING_DELEGATION: 'This account already has an active delegation. Review or revoke it before creating another.',
  AUTHENTICATED_ACCOUNT_CHANGED: 'The signed-in account changed. Select and review the account again.',
  EXPLICIT_BOUNDED_DELEGATION_REQUIRED: 'Select 1, 4 or 24 hours, or 30 or 90 days, and explicitly authorize the selected development account.',
  DELEGATION_RESPONSE_REQUIRES_REVIEW: 'The returned delegation expiry did not match the requested bound. Review or revoke this account’s delegation.',
  TRUSTED_ENROLLMENT_ORIGIN_REQUIRED: 'Enrollment is blocked. Configure the exact trusted http://127.0.0.1:port backend origin separately.',
  AUTHENTICATED_ENROLLMENT_REQUIRED: 'An authenticated Coinbase session is required. No mandate was confirmed by this page.',
  ENROLLMENT_RESPONSE_REQUIRES_REVIEW: 'Backend response did not match the frozen testnet contract. No connection is exposed; independently review backend state.',
  ENROLLMENT_OUTCOME_UNCONFIRMED: 'Backend outcome is unknown. No automatic retry was made. A mandate or local stop may already exist; review it through the trusted operator before retrying.',
  EXPLICIT_MANDATE_CONSENT_REQUIRED: 'Read the exact frozen limits or stop instruction and give its separate explicit consent.',
  MANDATE_PROPOSAL_EXPIRED_OR_USED: 'This proposal is absent, expired or already used. Request and review a fresh proposal; existing backend budget must not reset.',
  BACKEND_REVOCATION_REQUIRED: 'Use the combined backend stop so the durable local mandate is revoked before the provider delegation.',
};
function render() {
  const state = controller.state(), busy = uiBusy || state.busy;
  if(state.authenticated||wasAuthenticated!==state.authenticated)clearSignInFields();
  wasAuthenticated=state.authenticated;
  if(state.awaitingCode&&pendingEmail)email.value=pendingEmail;
  element<HTMLButtonElement>('send-code').disabled = busy || !state.ready || state.authenticated;
  email.disabled = busy || !state.ready || state.authenticated;
  email.readOnly = state.awaitingCode;
  element<HTMLButtonElement>('send-code').textContent=state.awaitingCode?'Send a new code to this email':'Send a verification code';
  element<HTMLButtonElement>('change-email').disabled=busy||!state.awaitingCode;
  element<HTMLButtonElement>('verify-code').disabled = busy || !state.awaitingCode;
  otp.disabled = busy || !state.awaitingCode;
  account.replaceChildren(...(state.accounts.length ? state.accounts.map(address => {
    const option = document.createElement('option'); option.value = address; option.textContent = address; option.selected = address === state.selected; return option;
  }) : [new Option(state.authenticated ? 'No EVM account returned; no delegation is possible' : 'Sign in first', '')]));
  account.disabled = busy || !state.selected;
  element<HTMLButtonElement>('refresh').disabled = busy || !state.selected;
  element<HTMLButtonElement>('grant').disabled = busy || !state.selected || !consent.checked || state.delegation.status === 'active';
  element<HTMLButtonElement>('revoke').disabled = busy || !state.selected || state.enrollmentConfigured;
  element<HTMLButtonElement>('sign-out').disabled = busy || !state.ready;
  hours.disabled = busy; consent.disabled = busy || !state.selected;
  element<HTMLElement>('delegation').textContent = `Selected account delegation: ${state.delegation.status}${state.delegation.expiresAt ? '; expires ' + new Date(state.delegation.expiresAt).toLocaleString() : ''}.`;
  const proposal=state.proposal, grant=proposal?.grant||state.mandate;
  element('enrollment-status').textContent=state.enrollmentConfigured?`Backend mandate: ${state.backendEnrollment}. Testnet only; provider acceptance not established.`:'Enrollment blocked: no trusted backend configured.';
  element<HTMLButtonElement>('proposal').disabled=busy||!state.selected||!state.enrollmentConfigured;
  const canConfirm=!!proposal&&proposal.challengeExpiresAt>Date.now();
  mandateConsent.disabled=busy||!canConfirm;
  element<HTMLButtonElement>('confirm-mandate').disabled=busy||!canConfirm||!mandateConsent.checked;
  revokeConsent.disabled=busy||!state.selected||!state.enrollmentConfigured;
  recoveryConsent.disabled=busy||!state.selected||!state.enrollmentConfigured;
  element<HTMLButtonElement>('recover-connection').disabled=busy||!state.selected||!state.enrollmentConfigured||!recoveryConsent.checked;
  element<HTMLButtonElement>('stop-mandate').disabled=busy||!state.selected||!state.enrollmentConfigured||!revokeConsent.checked;
  element('mandate-details').textContent=grant?[
    `Merchant: ${grant.merchantOrigin}`,`Payee: ${grant.payTo}`,`Payer: ${grant.wallet}`,
    'Network: Base Sepolia (eip155:84532); TEST USDC only',`Token: ${grant.asset}`,
    'Per payment: 5 test USDC; shared total: 10 test USDC (not a daily reset)',
    `Grant: ${grant.grantId}`,`Exact expiry: ${new Date(grant.expiresAt).toISOString()}`,
    proposal?`Proposal expires: ${new Date(proposal.challengeExpiresAt).toISOString()}; existing mandate: ${proposal.existing?'yes — original expiry and cumulative budget retained':'no'}`:state.connectionRecoveryOnly?'Historical mandate — recovery only. No renewal, no new payment, no budget reset.':'Confirmed development mandate; no payment acceptance inferred.',
  ].join('\n'):'No proposal has been requested.';
  const connection=controller.connection();
  element('connection-mode').textContent=connection?(state.connectionRecoveryOnly?'RECOVERY ONLY: inspect/reconcile existing outcomes. Paying, signing and settlement are disabled by the backend. This does not renew an expired/revoked mandate.':'Bounded testnet mandate connection. No real provider/payment acceptance inferred.'):'No connection available.';
  const connectionField=element<HTMLTextAreaElement>('agent-connection');
  const connectionValue=connection?JSON.stringify({AGENT_BROKER_ORIGIN:connection.brokerOrigin,AGENT_BROKER_TOKEN:connection.clientToken},null,2):'';
  if(connectionField.value!==connectionValue)connectionField.value=connectionValue;
  element<HTMLButtonElement>('copy-connection').disabled=busy||!connection;
}
async function act(operation: () => Promise<void>, success: string, failure?: string) {
  if (uiBusy) return;
  uiBusy = true; render();
  try { await operation(); status.textContent = success; }
  catch (error) { status.textContent = error instanceof OnboardingError ? (failure&&error.code==='PROVIDER_OPERATION_UNCONFIRMED'?failure:messages[error.code]) || 'Operation not confirmed. Review the selected account before retrying.' : failure||'Operation not confirmed.'; }
  finally { uiBusy = false; otp.value = ''; consent.checked = false; mandateConsent.checked=false;revokeConsent.checked=false;recoveryConsent.checked=false;render(); }
}
element<HTMLFormElement>('email-form').addEventListener('submit', event => {
  event.preventDefault(); if(uiBusy||controller.state().busy)return;
  const value=controller.state().awaitingCode?pendingEmail:email.value.trim();
  pendingEmail=value;email.value=value;
  void act(() => controller.sendCode(value), 'Verification code requested for the displayed email. Use only the latest code; an earlier request may no longer work.');
});
element<HTMLFormElement>('otp-form').addEventListener('submit', event => {
  event.preventDefault(); if(uiBusy||controller.state().busy)return;
  const value = otp.value.trim(); otp.value = '';
  void act(() => controller.verifyCode(value), 'Signed in locally through Coinbase. No delegation or backend enrollment was created.',
    'Sign-in was not confirmed. Retry the latest verification code for the displayed email, or manually request a new code.');
});
element('change-email').addEventListener('click',()=>{
  if(uiBusy||controller.state().busy)return;
  controller.cancelPendingSignIn();pendingEmail='';otp.value='';
  status.textContent='Previous code cancelled locally. Edit your email and request a new code.';
  render();email.focus();
});
account.addEventListener('change', () => { controller.selectAccount(account.value); consent.checked = false;mandateConsent.checked=false;revokeConsent.checked=false;recoveryConsent.checked=false; render(); });
consent.addEventListener('change', render);
hours.addEventListener('change', () => { consent.checked = false; render(); });
mandateConsent.addEventListener('change',render);revokeConsent.addEventListener('change',render);recoveryConsent.addEventListener('change',render);
element('refresh').addEventListener('click', () => { void act(() => controller.refreshDelegation(), 'Delegation status refreshed through Coinbase. This did not authorize a payment mandate.'); });
element('grant').addEventListener('click', () => {
  const duration = Number(hours.value), approved = consent.checked;
  void act(() => controller.grantDelegation(duration, approved), 'Provider account delegation confirmed for the displayed duration. Review and separately approve a backend mandate next; no payment was sent.');
});
element('revoke').addEventListener('click', () => { void act(() => controller.revokeDelegation(), 'Coinbase confirmed revocation for the selected account. Previously issued signatures can remain usable until their own expiry.'); });
element('sign-out').addEventListener('click', () => { if(uiBusy)return;clearSignInFields();void act(() => controller.signOut(), 'Signed out of this example. Signing out does not revoke a delegation.'); });
element('proposal').addEventListener('click',()=>{void act(()=>controller.proposeMandate(),'Frozen mandate received. Review every displayed limit before giving separate consent.');});
element('confirm-mandate').addEventListener('click',()=>{const approved=mandateConsent.checked;void act(()=>controller.confirmMandate(approved),'Backend confirmed this one-time bounded testnet mandate. Restricted connection is in memory only. No provider payment acceptance is established.');});
element('stop-mandate').addEventListener('click',()=>{const approved=revokeConsent.checked;void act(()=>controller.revokeMandate(approved),'Backend confirmed local stop and provider revocation. Previously issued signatures may remain valid until their own expiry.');});
element('recover-connection').addEventListener('click',()=>{const approved=recoveryConsent.checked;void act(()=>controller.recoverConnection(approved),'Inspect/reconcile-only connection received. No new payment, signing, settlement, budget or expiry authority was granted.');});
element('copy-connection').addEventListener('click',()=>{void act(async()=>{const connection=controller.connection();if(!connection)throw new Error();await navigator.clipboard.writeText(JSON.stringify({AGENT_BROKER_ORIGIN:connection.brokerOrigin,AGENT_BROKER_TOKEN:connection.clientToken},null,2));},'Restricted connection copied at your request. It is not a CDP secret. Your operating system may retain clipboard history.');});
// Expiry removes the displayed capability even without another user action.
setInterval(()=>{
  const proposal=controller.state().proposal;
  if((proposal&&proposal.challengeExpiresAt<=Date.now()&&!element<HTMLButtonElement>('confirm-mandate').disabled)||
    (element<HTMLTextAreaElement>('agent-connection').value&&!controller.connection()))render();
},1000);
void act(async () => {
  await controller.initialize();
  element('configuration').textContent = 'Explicit public development project configured; this is an operator assertion, not provider verification of project purpose.';
}, 'Development SDK initialized. No OTP, delegation, signing, transfer or backend enrollment has been requested by this example.');
