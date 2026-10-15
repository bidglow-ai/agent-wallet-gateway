import type * as Coinbase from '@coinbase/cdp-core';

export type OnboardingSdk = Pick<typeof Coinbase,
  'initialize' | 'getCurrentUser' | 'signInWithEmail' | 'verifyEmailOTP' |
  'getDelegationForAccount' | 'createDelegationForAccount' | 'revokeDelegationForAccount' | 'signOut'>;
export type PublicConfig = { projectId: string; developmentConfirmed: boolean };
type Address = `0x${string}`;
type Delegation = { status: 'unchecked' | 'none' | 'active' | 'expired' | 'revoked' | 'unknown'; expiresAt?: string };
export class OnboardingError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function validateDevelopmentConfig(config: PublicConfig, url: string) {
  const location = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.protocol !== 'http:')
    throw new OnboardingError('LOOPBACK_DEVELOPMENT_ONLY');
  if (Object.keys(config).sort().join(',') !== 'developmentConfirmed,projectId' || config.developmentConfirmed !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.projectId))
    throw new OnboardingError('DEVELOPMENT_PROJECT_REQUIRED');
}
export class OnboardingController {
  #sdk: OnboardingSdk;
  #config: PublicConfig;
  #url: string;
  #ready = false;
  #busy = false;
  #flowId: string | undefined;
  #subject: string | undefined;
  #accounts: Address[] = [];
  #selected: Address | undefined;
  #delegation: Delegation = { status: 'unchecked' };
  constructor(sdk: OnboardingSdk, config: PublicConfig, url: string) {
    this.#sdk = sdk; this.#config = { ...config }; this.#url = url;
  }
  state() {
    return { ready: this.#ready, busy: this.#busy, awaitingCode: !!this.#flowId, authenticated: !!this.#subject,
      accounts: [...this.#accounts], selected: this.#selected, delegation: { ...this.#delegation },
      backendEnrollment: 'not_implemented', fundingAccepted: false, paymentsEnabled: false };
  }
  async #exclusive<T>(operation: () => Promise<T>, initializing = false): Promise<T> {
    if (this.#busy) throw new OnboardingError('OPERATION_IN_PROGRESS');
    if (!initializing && !this.#ready) throw new OnboardingError('CONFIGURE_BEFORE_AUTHENTICATION');
    this.#busy = true;
    try { return await operation(); }
    catch (error) { throw error instanceof OnboardingError ? error : new OnboardingError('PROVIDER_OPERATION_UNCONFIRMED'); }
    finally { this.#busy = false; }
  }
  #setUser(user: Coinbase.User | null) {
    const accounts = user?.evmAccountObjects?.map(account => account.address).filter((address): address is Address => /^0x[0-9a-f]{40}$/i.test(address)) || [];
    if (user?.userId !== this.#subject || !this.#selected || !accounts.includes(this.#selected)) {
      this.#selected = accounts[0]; this.#delegation = { status: 'unchecked' };
    }
    this.#subject = user?.userId;
    this.#accounts = accounts;
  }
  async #currentAccount() {
    const previousSubject = this.#subject, selected = this.#selected;
    this.#setUser(await this.#sdk.getCurrentUser());
    if (!selected || previousSubject !== this.#subject || !this.#accounts.includes(selected))
      throw new OnboardingError('AUTHENTICATED_ACCOUNT_CHANGED');
    return selected;
  }
  async #readDelegation(address: Address) {
    try {
      const result = await this.#sdk.getDelegationForAccount({ address });
      const expires = Date.parse(result.expiresAt);
      if (!Number.isFinite(expires)) throw new OnboardingError('DELEGATION_STATUS_UNCONFIRMED');
      this.#delegation = { status: expires > Date.now() ? 'active' : 'expired', expiresAt: result.expiresAt };
    } catch (error) {
      const providerError = error as { statusCode?: unknown; errorType?: unknown };
      if (providerError?.statusCode === 404 && providerError.errorType === 'delegation_not_found') this.#delegation = { status: 'none' };
      else { this.#delegation = { status: 'unknown' }; throw new OnboardingError('DELEGATION_STATUS_UNCONFIRMED'); }
    }
  }
  async initialize() {
    return this.#exclusive(async () => {
      validateDevelopmentConfig(this.#config, this.#url);
      await this.#sdk.initialize({ projectId: this.#config.projectId, disableAnalytics: true, debugging: false,
        ethereum: { createOnLogin: 'eoa' } });
      this.#setUser(await this.#sdk.getCurrentUser()); this.#ready = true;
    }, true);
  }
  async sendCode(email: string) {
    return this.#exclusive(async () => {
      if (this.#subject) throw new OnboardingError('SIGN_OUT_BEFORE_SWITCHING_USER');
      // Email and OTP are passed directly to the official SDK and never retained
      // in controller state, logs, browser storage, URLs or application requests.
      const result = await this.#sdk.signInWithEmail({ email: email.trim() });
      this.#flowId = result.flowId;
    });
  }
  async verifyCode(otp: string) {
    return this.#exclusive(async () => {
      if (!this.#flowId) throw new OnboardingError('REQUEST_CODE_FIRST');
      const result = await this.#sdk.verifyEmailOTP({ flowId: this.#flowId, otp });
      this.#flowId = undefined; this.#setUser(result.user);
    });
  }
  selectAccount(address: string) {
    if (this.#busy) throw new OnboardingError('OPERATION_IN_PROGRESS');
    if (!this.#accounts.includes(address as Address)) throw new OnboardingError('AUTHENTICATED_ACCOUNT_REQUIRED');
    this.#selected = address as Address; this.#delegation = { status: 'unchecked' };
  }
  async refreshDelegation() {
    return this.#exclusive(async () => { await this.#readDelegation(await this.#currentAccount()); });
  }
  async grantDelegation(hours: number, explicitConsent: boolean) {
    return this.#exclusive(async () => {
      if (explicitConsent !== true || ![1, 4, 24].includes(hours)) throw new OnboardingError('EXPLICIT_BOUNDED_DELEGATION_REQUIRED');
      const address = await this.#currentAccount();
      await this.#readDelegation(address);
      if (!['none', 'expired', 'revoked'].includes(this.#delegation.status)) throw new OnboardingError('REVIEW_EXISTING_DELEGATION');
      const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
      this.#delegation = { status: 'unknown' };
      const result = await this.#sdk.createDelegationForAccount({ address, expiresAt });
      const expires = Date.parse(result.expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.parse(expiresAt)) throw new OnboardingError('DELEGATION_RESPONSE_REQUIRES_REVIEW');
      this.#delegation = { status: 'active', expiresAt: result.expiresAt };
    });
  }
  async revokeDelegation() {
    return this.#exclusive(async () => {
      const address = await this.#currentAccount();
      this.#delegation = { status: 'unknown' };
      await this.#sdk.revokeDelegationForAccount({ address });
      this.#delegation = { status: 'revoked' };
    });
  }
  async signOut() {
    return this.#exclusive(async () => {
      await this.#sdk.signOut(); this.#flowId = undefined; this.#setUser(null);
    });
  }
}
