import { initialize, getCurrentUser, signInWithEmail, verifyEmailOTP, getDelegationForAccount,
  createDelegationForAccount, revokeDelegationForAccount, signOut } from '@coinbase/cdp-core';
import { OnboardingController, OnboardingError } from './controller.ts';
import './style.css';

const controller = new OnboardingController({ initialize, getCurrentUser, signInWithEmail, verifyEmailOTP,
  getDelegationForAccount, createDelegationForAccount, revokeDelegationForAccount, signOut }, {
  projectId: import.meta.env.VITE_CDP_PROJECT_ID || '',
  developmentConfirmed: import.meta.env.VITE_DEVELOPMENT_PROJECT_CONFIRMED === 'true',
}, window.location.href);
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing UI element');
  return value as T;
}
const email = element<HTMLInputElement>('email'), otp = element<HTMLInputElement>('otp'), account = element<HTMLSelectElement>('account');
const consent = element<HTMLInputElement>('consent'), hours = element<HTMLSelectElement>('hours');
const status = element<HTMLElement>('status');
let uiBusy = false;
const messages: Record<string, string> = {
  DEVELOPMENT_PROJECT_REQUIRED: 'Set the public development project ID and confirm the separate development project before continuing.',
  LOOPBACK_DEVELOPMENT_ONLY: 'This example runs only on a loopback HTTP development origin.',
  PROVIDER_OPERATION_UNCONFIRMED: 'The provider did not confirm the operation. Do not assume authentication, delegation or revocation succeeded. Refresh its status.',
  DELEGATION_STATUS_UNCONFIRMED: 'Delegation status is unavailable. No new delegation was requested.',
  REVIEW_EXISTING_DELEGATION: 'This account already has an active delegation. Review or revoke it before creating another.',
  AUTHENTICATED_ACCOUNT_CHANGED: 'The signed-in account changed. Select and review the account again.',
  EXPLICIT_BOUNDED_DELEGATION_REQUIRED: 'Select a duration up to 24 hours and explicitly authorize the selected development account.',
  DELEGATION_RESPONSE_REQUIRES_REVIEW: 'The returned delegation expiry did not match the requested bound. Review or revoke this account’s delegation.',
};
function render() {
  const state = controller.state(), busy = uiBusy || state.busy;
  element<HTMLButtonElement>('send-code').disabled = busy || !state.ready || state.authenticated;
  email.disabled = busy || !state.ready || state.authenticated;
  element<HTMLButtonElement>('verify-code').disabled = busy || !state.awaitingCode;
  otp.disabled = busy || !state.awaitingCode;
  account.replaceChildren(...(state.accounts.length ? state.accounts.map(address => {
    const option = document.createElement('option'); option.value = address; option.textContent = address; option.selected = address === state.selected; return option;
  }) : [new Option(state.authenticated ? 'No EVM account returned; no delegation is possible' : 'Sign in first', '')]));
  account.disabled = busy || !state.selected;
  element<HTMLButtonElement>('refresh').disabled = busy || !state.selected;
  element<HTMLButtonElement>('grant').disabled = busy || !state.selected || !consent.checked || state.delegation.status === 'active';
  element<HTMLButtonElement>('revoke').disabled = busy || !state.selected;
  element<HTMLButtonElement>('sign-out').disabled = busy || !state.ready;
  hours.disabled = busy; consent.disabled = busy || !state.selected;
  element<HTMLElement>('delegation').textContent = `Selected account delegation: ${state.delegation.status}${state.delegation.expiresAt ? '; expires ' + new Date(state.delegation.expiresAt).toLocaleString() : ''}.`;
}
async function act(operation: () => Promise<void>, success: string) {
  if (uiBusy) return;
  uiBusy = true; render();
  try { await operation(); status.textContent = success; }
  catch (error) { status.textContent = error instanceof OnboardingError ? messages[error.code] || 'Operation not confirmed. Review the selected account before retrying.' : 'Operation not confirmed.'; }
  finally { uiBusy = false; otp.value = ''; email.value = ''; consent.checked = false; render(); }
}
element<HTMLFormElement>('email-form').addEventListener('submit', event => {
  event.preventDefault(); const value = email.value; email.value = '';
  void act(() => controller.sendCode(value), 'Verification code requested through the official SDK. Enter it below.');
});
element<HTMLFormElement>('otp-form').addEventListener('submit', event => {
  event.preventDefault(); const value = otp.value; otp.value = '';
  void act(() => controller.verifyCode(value), 'Signed in locally through Coinbase. No delegation or backend enrollment was created.');
});
account.addEventListener('change', () => { controller.selectAccount(account.value); consent.checked = false; render(); });
consent.addEventListener('change', render);
element('refresh').addEventListener('click', () => { void act(() => controller.refreshDelegation(), 'Delegation status refreshed through Coinbase. Backend enrollment remains unimplemented.'); });
element('grant').addEventListener('click', () => {
  const duration = Number(hours.value), approved = consent.checked;
  void act(() => controller.grantDelegation(duration, approved), 'Account-scoped provider delegation confirmed for the displayed duration. Backend enrollment and payments are still unavailable.');
});
element('revoke').addEventListener('click', () => { void act(() => controller.revokeDelegation(), 'Coinbase confirmed revocation for the selected account. Previously issued signatures can remain usable until their own expiry.'); });
element('sign-out').addEventListener('click', () => { void act(() => controller.signOut(), 'Signed out of this example. Signing out does not revoke a delegation.'); });
void act(async () => {
  await controller.initialize();
  element('configuration').textContent = 'Explicit public development project configured; this is an operator assertion, not provider verification of project purpose.';
}, 'Development SDK initialized. No OTP, delegation, signing, transfer or backend enrollment has been requested by this example.');
