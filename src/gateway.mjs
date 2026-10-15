import {WalletError} from './provider.mjs';

export class WalletGateway {
  constructor(provider, ledger = null, policy = null) {
    this.provider = provider; this.ledger = ledger; this.policy = policy;
  }
  async status() {
    return {...await this.provider.status(), paymentsEnabled: false,
      budget: this.ledger?.summary() ?? null,
      policyScope: 'gateway_calls_only_not_all_processes_on_this_computer',
      fulfillmentVerified: false};
  }
  readiness() {
    return {paymentsEnabled: false, fundingForAutomatedPaymentsAccepted: false,
      liveSignerConfigured: false, sharedGatewayBudgetIsWalletWide: false,
      blockers: ['SIGNER_CHAIN_TOKEN_PAYEE_BINDING', 'MERCHANT_FROZEN_ORDER_AND_IDEMPOTENCY',
        'INDEPENDENT_SETTLEMENT_AND_RECONCILIATION', 'MERCHANT_ACCOUNTING_AND_RECOVERY',
        'NATIVE_CLIENT_PAYMENT_ACCEPTANCE'],
      instruction: 'Do not fund for automated payments; authentication or balance does not establish payment readiness.'};
  }
  async pay() {
    // Also reject direct library calls, before any provider or ledger access.
    throw new WalletError('PAYMENT_RELEASE_NOT_ACCEPTED');
  }
}
