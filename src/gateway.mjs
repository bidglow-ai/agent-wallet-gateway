import {WalletError} from './provider.mjs';

export class WalletGateway {
  constructor(provider, ledger = null, policy = null) {
    this.provider = provider; this.ledger = ledger; this.policy = policy;
  }
  async status() {
    return {...await this.provider.status(), paymentsEnabled: this.policy?.enabled === true,
      budget: this.ledger?.summary() ?? null,
      policyScope: 'gateway_calls_only_not_all_processes_on_this_computer',
      fulfillmentVerified: false};
  }
  async pay(input) {
    if (!this.ledger || this.policy?.enabled !== true) throw new WalletError('PAYMENTS_DISABLED');
    if (!/^0x[0-9a-fA-F]{40}$/.test(this.policy.expectedWallet ?? '')) throw new WalletError('WALLET_PIN_REQUIRED');
    const status = await this.provider.status();
    if (!status.authenticated) throw new WalletError('WALLET_LOGIN_REQUIRED');
    const address = await this.provider.address();
    if (address !== this.policy.expectedWallet.toLowerCase()) throw new WalletError('WALLET_CHANGED');
    // Caller saves this operation UUID before invoking. Inspect existing operations
    // instead of blindly repeating them. New UUIDs cannot bypass payload dedup.
    const request = {...input};
    this.ledger.reserve(request);
    try {
      const result = await this.provider.pay(request);
      const reported = result.amountPaid;
      // Provider claims are not independent chain or merchant fulfillment evidence.
      // Commit the FULL reserved ceiling, never release budget on provider reports.
      if (result.paymentMade !== true || !Number.isSafeInteger(reported) || reported < 1 || BigInt(reported) > BigInt(request.amountAtomic)) throw new WalletError('PAYMENT_RECONCILIATION_REQUIRED');
      this.ledger.confirm(request.id, request.amountAtomic);
      return {id: request.id, outcome: 'provider_reported_paid', reportedAmountAtomic: String(reported),
        budgetConsumedAtomic: request.amountAtomic, chainSettlementIndependentlyVerified: false,
        merchantFulfillmentVerified: false, automaticRetryAllowed: false};
    } catch {
      this.ledger.markUnknown(request.id);
      return {id: request.id, outcome: 'unknown', budgetReservedAtomic: request.amountAtomic,
        automaticRetryAllowed: false, operatorReconciliationRequired: true};
    }
  }
}
