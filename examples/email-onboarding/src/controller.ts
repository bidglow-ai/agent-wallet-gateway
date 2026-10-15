import type * as Coinbase from '@coinbase/cdp-core';
import {EnrollmentError,enrollmentOrigin,enrollmentRequest,validateProposal,validateConfirmation,validateRevocation,validateRecovery} from './enrollment.ts';
import type {Proposal,Mandate,AgentConnection} from './enrollment.ts';

export type OnboardingSdk = Pick<typeof Coinbase,
  'initialize' | 'getCurrentUser' | 'signInWithEmail' | 'verifyEmailOTP' |
  'getDelegationForAccount' | 'createDelegationForAccount' | 'revokeDelegationForAccount' | 'signOut' | 'getAccessToken' | 'onAuthStateChange'>;
export type PublicConfig = { projectId: string; developmentConfirmed: boolean; enrollmentOrigin?: string };
type Address = `0x${string}`;
type Delegation = { status: 'unchecked' | 'none' | 'active' | 'expired' | 'revoked' | 'unknown'; expiresAt?: string };
export class OnboardingError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function validateDevelopmentConfig(config: PublicConfig, url: string) {
  const location = new URL(url);
  // Coinbase development-domain allowlisting requires localhost rather than an
  // IP address. Permit only these two literal loopback frontend hosts; this does
  // not make them interchangeable enrollment-backend origins.
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d+(?:[/?#]|$)/i.test(url) ||
      !['localhost','127.0.0.1'].includes(location.hostname) || location.protocol !== 'http:' || !location.port || location.username || location.password)
    throw new OnboardingError('LOOPBACK_DEVELOPMENT_ONLY');
  if (!['developmentConfirmed,projectId','developmentConfirmed,enrollmentOrigin,projectId'].includes(Object.keys(config).sort().join(',')) || config.developmentConfirmed !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.projectId))
    throw new OnboardingError('DEVELOPMENT_PROJECT_REQUIRED');
  if(config.enrollmentOrigin)enrollmentOrigin(config.enrollmentOrigin);
}
export class OnboardingController {
  #sdk: OnboardingSdk;
  #config: PublicConfig;
  #url: string;
  #ready = false;
  #busy = false;
  #flowId: string | undefined;
  #subject: string | undefined;
  #identityEpoch=0;
  #accounts: Address[] = [];
  #selected: Address | undefined;
  #delegation: Delegation = { status: 'unchecked' };
  #proposal: Proposal | undefined;
  #mandate: Mandate | undefined;
  #connection: AgentConnection | undefined;
  #recoveryOnly=false;
  #enrollment = 'blocked';
  #transport: typeof fetch;
  #changed:()=>void;
  constructor(sdk: OnboardingSdk, config: PublicConfig, url: string, transport:typeof fetch=fetch, changed:()=>void=()=>{}) {
    this.#sdk = sdk; this.#config = { ...config }; this.#url = url;
    this.#transport=transport;this.#changed=changed;this.#enrollment=config.enrollmentOrigin?'idle':'blocked';
  }
  state() {
    return { ready: this.#ready, busy: this.#busy, awaitingCode: !!this.#flowId, authenticated: !!this.#subject,
      accounts: [...this.#accounts], selected: this.#selected, delegation: { ...this.#delegation },
      backendEnrollment:this.#enrollment,enrollmentConfigured:!!this.#config.enrollmentOrigin,
      proposal:this.#proposal?{grant:{...this.#proposal.grant},existing:this.#proposal.existing,challengeExpiresAt:this.#proposal.challengeExpiresAt}:undefined,
      mandate:this.#mandate?{...this.#mandate}:undefined,connectionAvailable:!!this.connection(),connectionRecoveryOnly:this.#recoveryOnly,
      fundingAccepted: false, paymentsEnabled: false };
  }
  connection(){return this.#connection&&this.#mandate&&(this.#recoveryOnly||this.#mandate.expiresAt>Date.now())?{...this.#connection}:undefined;}
  #clearEnrollment(){this.#proposal=undefined;this.#mandate=undefined;this.#connection=undefined;this.#recoveryOnly=false;this.#enrollment=this.#config.enrollmentOrigin?'idle':'blocked';}
  async #exclusive<T>(operation: () => Promise<T>, initializing = false): Promise<T> {
    if (this.#busy) throw new OnboardingError('OPERATION_IN_PROGRESS');
    if (!initializing && !this.#ready) throw new OnboardingError('CONFIGURE_BEFORE_AUTHENTICATION');
    this.#busy = true;
    try { return await operation(); }
    catch (error) { throw error instanceof OnboardingError ? error : new OnboardingError(error instanceof EnrollmentError?error.message:'PROVIDER_OPERATION_UNCONFIRMED'); }
    finally { this.#busy = false; }
  }
  #setUser(user: Coinbase.User | null) {
    const accounts = user?.evmAccountObjects?.map(account => account.address.toLowerCase()).filter((address): address is Address => /^0x[0-9a-f]{40}$/.test(address)) || [];
    if (user?.userId !== this.#subject || !this.#selected || !accounts.includes(this.#selected)) {
      this.#identityEpoch++;
      this.#selected = accounts[0]; this.#delegation = { status: 'unchecked' };
      this.#clearEnrollment();this.#flowId=undefined;
    }
    this.#subject = user?.userId;
    this.#accounts = accounts;
  }
  async #currentAccount() {
    const previousSubject = this.#subject, selected = this.#selected,epoch=this.#identityEpoch;
    const user=await this.#sdk.getCurrentUser();
    if(epoch!==this.#identityEpoch)throw new OnboardingError('AUTHENTICATED_ACCOUNT_CHANGED');
    this.#setUser(user);
    if (!selected || previousSubject !== this.#subject || !this.#accounts.includes(selected))
      throw new OnboardingError('AUTHENTICATED_ACCOUNT_CHANGED');
    return selected;
  }
  async #assertIdentity(address:Address,subject:string|undefined,epoch:number){
    if(epoch!==this.#identityEpoch||subject!==this.#subject||address!==this.#selected)
      throw new OnboardingError('AUTHENTICATED_ACCOUNT_CHANGED');
    const current=await this.#currentAccount();
    if(current!==address||epoch!==this.#identityEpoch||subject!==this.#subject)
      throw new OnboardingError('AUTHENTICATED_ACCOUNT_CHANGED');
  }
  async #boundProviderCall<T>(address:Address,operation:()=>Promise<T>):Promise<T>{
    const subject=this.#subject,epoch=this.#identityEpoch;
    let result:T;
    try{result=await operation();}
    catch(error){await this.#assertIdentity(address,subject,epoch);throw error;}
    await this.#assertIdentity(address,subject,epoch);
    return result;
  }
  async #readDelegation(address: Address) {
    try {
      const result = await this.#boundProviderCall(address,()=>this.#sdk.getDelegationForAccount({ address }));
      const expires = Date.parse(result.expiresAt);
      if (!Number.isFinite(expires)) throw new OnboardingError('DELEGATION_STATUS_UNCONFIRMED');
      this.#delegation = { status: expires > Date.now() ? 'active' : 'expired', expiresAt: result.expiresAt };
    } catch (error) {
      if(error instanceof OnboardingError&&error.code==='AUTHENTICATED_ACCOUNT_CHANGED')throw error;
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
      this.#sdk.onAuthStateChange(user=>{this.#setUser(user);this.#changed();});
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
    address=address.toLowerCase();
    if (!this.#accounts.includes(address as Address)) throw new OnboardingError('AUTHENTICATED_ACCOUNT_REQUIRED');
    this.#selected = address as Address; this.#delegation = { status: 'unchecked' };
    this.#identityEpoch++;
    this.#clearEnrollment();
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
      const result = await this.#boundProviderCall(address,()=>this.#sdk.createDelegationForAccount({ address, expiresAt }));
      const expires = Date.parse(result.expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.parse(expiresAt)) throw new OnboardingError('DELEGATION_RESPONSE_REQUIRES_REVIEW');
      this.#delegation = { status: 'active', expiresAt: result.expiresAt };
    });
  }
  async revokeDelegation() {
    return this.#exclusive(async () => {
      if(this.#config.enrollmentOrigin)throw new OnboardingError('BACKEND_REVOCATION_REQUIRED');
      this.#clearEnrollment();
      const address = await this.#currentAccount();
      this.#delegation = { status: 'unknown' };
      await this.#boundProviderCall(address,()=>this.#sdk.revokeDelegationForAccount({ address }));
      this.#delegation = { status: 'revoked' };
    });
  }
  async signOut() {
    return this.#exclusive(async () => {
      this.#clearEnrollment();this.#flowId=undefined;this.#changed();
      await this.#sdk.signOut(); this.#flowId = undefined; this.#setUser(null);
    });
  }
  async #request(action:'proposal'|'confirm'|'revoke'|'recover',wallet:Address,body:object){
    if(!this.#config.enrollmentOrigin)throw new OnboardingError('TRUSTED_ENROLLMENT_ORIGIN_REQUIRED');
    const subject=this.#subject,epoch=this.#identityEpoch;
    const accessToken=await this.#sdk.getAccessToken();
    await this.#assertIdentity(wallet,subject,epoch);
    const response=await enrollmentRequest(this.#config.enrollmentOrigin,action,accessToken,body,this.#transport);
    await this.#assertIdentity(wallet,subject,epoch);
    return response;
  }
  async proposeMandate(){
    return this.#exclusive(async()=>{
      this.#clearEnrollment();
      const wallet=await this.#currentAccount();
      const response=await this.#request('proposal',wallet,{wallet});
      this.#proposal=validateProposal(response,wallet,this.#subject!);this.#enrollment='proposed';
    });
  }
  async confirmMandate(approved:boolean){
    return this.#exclusive(async()=>{
      if(approved!==true)throw new OnboardingError('EXPLICIT_MANDATE_CONSENT_REQUIRED');
      const proposal=this.#proposal;this.#proposal=undefined;this.#connection=undefined;this.#recoveryOnly=false;
      if(!proposal||proposal.challengeExpiresAt<=Date.now()){this.#enrollment='idle';throw new OnboardingError('MANDATE_PROPOSAL_EXPIRED_OR_USED');}
      const wallet=await this.#currentAccount();this.#enrollment='unknown';
      const response=await this.#request('confirm',wallet,{wallet,nonce:proposal.nonce,approved:true});
      const confirmed=validateConfirmation(response,proposal,wallet,this.#subject!);
      this.#mandate=confirmed.grant;this.#connection=confirmed.connection;this.#enrollment='confirmed';
    });
  }
  async revokeMandate(approved:boolean){
    return this.#exclusive(async()=>{
      if(approved!==true)throw new OnboardingError('EXPLICIT_MANDATE_CONSENT_REQUIRED');
      this.#clearEnrollment();this.#enrollment='unknown';this.#changed();
      const wallet=await this.#currentAccount();
      const response=await this.#request('revoke',wallet,{wallet,approved:true});
      validateRevocation(response);this.#delegation={status:'revoked'};this.#enrollment='revoked';
    });
  }
  async recoverConnection(approved:boolean){
    return this.#exclusive(async()=>{
      if(approved!==true)throw new OnboardingError('EXPLICIT_MANDATE_CONSENT_REQUIRED');
      this.#clearEnrollment();this.#enrollment='unknown';
      const wallet=await this.#currentAccount();
      const response=await this.#request('recover',wallet,{wallet,approved:true});
      const recovered=validateRecovery(response,wallet,this.#subject!);
      this.#mandate=recovered.grant;this.#connection=recovered.connection;this.#recoveryOnly=true;this.#enrollment='recovery_only';
    });
  }
}
