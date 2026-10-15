# Unattended payment development — 2026-10-15

Status: implementation in progress. Mainnet and funding acceptance remain blocked.

## Decision

Keep the published AWAL bridge read-only. Its documented CLI cannot supply a
frozen typed-data signature with the policy controls this project requires.
Do not patch private companion IPC, bypass wallet approvals, or import a seed.

Develop a separate **testnet-only payment broker** using the documented Coinbase
CDP user-wallet account-scoped delegated-signing API. A user signs in with their
own email and grants a short-lived delegation once. The trusted broker, not an AI
client, holds project credentials. Email alone is neither authorization nor a
guarantee of recovering a wallet created by another Coinbase product/project.

Account delegation is broader than an individual purchase: provider policy and
the broker must enforce Base Sepolia, official test USDC, a fixed merchant/payee,
single-payment and shared cumulative budgets, expiry and revocation. Never claim
that a local SQLite counter is a provider-enforced wallet-wide budget. Same-user
arbitrary code or a compromised broker remains outside its isolation guarantee.

## Order and signature contract

Freeze one merchant order: version, random salt, UUID, merchant origin/resource,
listing, board, payer, payee, chain/token, integer amount, creation and expiry.
Derive the EIP-3009 nonce as SHA-256 of a domain-separated canonical order. The
signer reconstructs the exact typed data; callers cannot submit arbitrary typed
data. Both merchant and client verify that nonce before settlement. Unlike an
unsigned x402 resource URL, the signed nonce binds changes to the frozen order.
This is a BidGlow extension and not universal arbitrary-x402 client compatibility.

Reserve shared budget durably before requesting a signature. A crash or unknown
result retains the full reservation. Do not sign or settle again for an existing
order or merchant-account/quote pair, even under a new operation ID. Persist the transaction before recording
Stripe evidence; resume only read/reconciliation of the same payment. A future
production adapter must additionally freeze existing listing-owner and quote
scope and preserve difference bidding and both boards.

## Acceptance gates

1. Pure contract tests: wrong chain/token/payee/payer/amount, order retargeting,
   expired authorization, unknown fields, signature recovery.
2. Durable broker tests: concurrency, restart, changed grants, pending/unknown
   never repaid, revocation and shared budget across clients.
3. Official delegated-signing configuration and email onboarding in an isolated
   development CDP project; verify policies and expiry/revocation via provider.
4. Actual Base Sepolia USDC transfer through the official facilitator, independent
   chain receipt and Stripe sandbox verification; preserve evidence without secrets.
5. Native clients and BidGlow production accounting/recovery integration reviewed
   separately. No payment/ranking predicates weakened; no mainnet route enabled.
6. Only after gates pass: explicitly scoped mainnet test and funding instructions.

## Implementation boundaries and current progress

- `intent.mjs`: strict immutable testnet order contract and EIP-712 recovery.
- `store.mjs`: one immutable grant per private store, quote/order/nonce/transaction/
  PaymentIntent uniqueness, persistent revocation and full-budget holds. A new
  directory is NOT a legitimate way to renew a grant or reset its spending.
- `cdp-signer.mjs`: documented account-scoped SDK calls, fresh user/wallet/delegation
  and project-policy checks, narrow typed-data construction, server-side access
  token verification helper, including session-only authentication for revocation
  after a delegation expires.
- `broker.mjs`: reserve before signing, no repayment, recovery of interrupted
  states only from independent existing chain/Stripe evidence.
- `merchant.mjs`: official x402 resource server/facilitator adapter, using a
  **different** private merchant store from the payer store. No production route.
- `chain-stripe-verifier.mjs`: fixed testnet RPC identity, signed-nonce/transfer
  logs, canonical receipt block and RPC finalized height, then fresh Stripe
  test-account and PaymentIntent evidence. Pending never becomes confirmed.
- `mcp.mjs`: unmounted restricted testnet tool factory. A transport must bind
  each authenticated caller to one authorized broker; no public relay is included.
- `http.mjs` and `client.mjs`: authenticated loopback-only broker transport and
  an actual stdio child-process adapter. Agents receive a scoped broker token,
  not CDP/Stripe credentials. Use a fresh cryptographically random 32-byte token
  per broker instance and bind it explicitly to `127.0.0.1`. This is not public
  HTTPS transport or protection against a compromised local OS/port-hijacking peer.
- `enrollment-store.mjs`: fixed-project/wallet lifetime mandate registry and fixed
  payer ledger. Pending initialization and lost registry/ledger fail closed;
  there is no automated renewal, budget reset or incomplete-state recovery.
- `enrollment.mjs`: fresh provider authentication, short one-use frozen proposal,
  explicit one-time mandate confirmation and session-authenticated stop/revoke.
  Separate exact-origin browser enrollment and reject-Origin agent listeners.
  An owner-session recovery connection works after expiry/revocation/restart,
  never renews the original grant, and has no payment/sign/settle capability.
- `runtime.mjs` / `operator.mjs`: explicit private-config local testnet bootstrap,
  no policy/account/funding mutation at startup; one protected order directory,
  one private shared payer ledger and a separate merchant ledger. Not imported
  by the default server. See [operator setup](DEVELOPMENT_SETUP.md).
- `examples/email-onboarding`: own-project/own-email SDK sign-in and a separate
  account-scoped delegation button; the local backend connection is development
  source, not provider acceptance or a hosted public service.

The CDP SDK project policy is global to that project, not per-user. Its per-call
template follows the configured grant and cannot be used to promise different
per-user caps through a single project policy. Domain chain, order binding and
cumulative budgets remain trusted-broker checks, not provider-wide guarantees.
Use a separate trusted process for a different CDP project. Never give AI clients
the project's developer API key, Wallet Secret or policy-edit access.

Still required: actual provider acceptance of authenticated bounded-mandate
enrollment and any public HTTPS transport, actual empty
development-project setup and negative policy tests, real email/delegation flow,
a new testnet transfer using that provider signer, isolated fulfillment/recovery,
and native-client acceptance. The prior website's successful disposable-key test
does not accept this new email/delegation implementation.

No new payment was initiated during implementation. A read-only public RPC check
confirmed the prior publicly documented Base Sepolia transaction succeeded, has
USDC AuthorizationUsed/Transfer events and is finalized according to that RPC.
This validates the receipt ABI, not any new order, signer, email flow or payment.

Source documentation:

- https://docs.cdp.coinbase.com/wallets/quickstart/user-auth
- https://docs.cdp.coinbase.com/wallets/using-wallets/delegated-signing
- https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/evm-policies
- https://docs.stripe.com/payments/machine/x402

No production website code, database, secrets, ranking, refund or recovery writes
are authorized by successful isolated broker tests. Open-source publication must
not include an owner's email, wallet state, signatures or credentials.
