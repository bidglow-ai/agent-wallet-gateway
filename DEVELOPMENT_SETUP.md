# Own-email unattended wallet — development operator guide

**Development source, not a funded-wallet release. Mainnet is hard-disabled.**
The public default `npm start` is unchanged and read-only. Do not send real USDC,
ETH or any other real asset to a development wallet. No provider acceptance or
native-client payment success is established by the fixture tests below.

## What is now implemented

The local example lets the owner sign in with their own email through Coinbase,
select an empty EVM account, and grant a short account delegation. The backend
independently validates the session and account through the official provider.
It then proposes a frozen mandate: one testnet merchant/payee, at most 5 test USDC
per payment, 10 test USDC for the entire mandate, and a bounded expiry. The owner
confirms this mandate **once**, not for every subsequent authorized payment.

One restricted broker capability can be used by compatible local MCP adapters.
All adapters share one persisted payer ledger. A second login, agent, session or
restart cannot renew the expiry, change identity/merchant/caps or clear spending.
The backend has no reset, renew, grant-edit or arbitrary-signing endpoint. A fresh
directory is not an authorized way to renew the mandate. Revoked or expired
mandates require a separately reviewed future renewal design, not file deletion.

This milestone is single-owner self-hosted development: each operator uses their
own isolated CDP development project, wallet, private state and server credentials.
It is not a public hosted multi-tenant wallet where email alone is sufficient.
Email in AWAL, Coinbase Wallet, or another CDP project may resolve to a different
wallet. Never fund an address on the assumption those products share it.

## Before connecting a provider

1. Create a separate **empty development CDP project** through the official portal.
   Review its current terms/free-tier limits. Nothing here guarantees free use.
   Never reuse an account with real funds for delegation experiments.
2. Follow official [email authentication](https://docs.cdp.coinbase.com/wallets/quickstart/user-auth)
   and [delegated-signing setup](https://docs.cdp.coinbase.com/wallets/using-wallets/delegated-signing).
   Allowlist only the local development origin. The example disables optional SDK
   analytics. Sign in in the browser; never send email codes or secrets in chat.
3. Pin the authenticated **development** wallet's public address in operator
   configuration. This is intentionally not a first-request-wins enrollment.
4. Obtain the receiving address from the **same Stripe sandbox merchant** used
   for payment evidence. An arbitrary CDP/server-wallet address is not a Stripe
   deposit address. Follow the official [sandbox x402 setup](https://docs.stripe.com/payments/machine/x402#test-in-a-stripe-sandbox)
   to explicitly create a sandbox Base deposit address; its creation example
   uses `2026-07-29.preview`. This guide/helper does not create one for you.
   Confirm active crypto capability and exact address/token ownership before
   fixing `payTo` and installing its provider policy. Never use a live deposit
   address or send real funds to make this test pass.
5. Install and independently test the proposed project policy returned by
   `providerPolicy(grant)` in `src/unattended/cdp-signer.mjs`, in this project only.
   The service does not create or weaken provider policies at startup. Check wrong
   payee/token/value/type, expiry/revocation and unexpected provider operations.
   Provider policies do **not** establish the broker's lifetime budget or order
   binding, and omitted provider operations can default to allowed. Broad project
   administrator credentials must remain outside agent processes.
6. Obtain the normal CDP project API credentials/Wallet Secret and the matching
   **Stripe sandbox** key in the operator's protected environment. Do not paste
   them into a chat, browser frontend, MCP configuration, repository or issue.
   This development source does not automatically request expanded permissions.

Actual provider setup and negative tests have not been accepted for this new
implementation. Do not skip those gates because an SDK schema test passed.

## Import credentials without putting values in commands

Use the Portal's explicit downloads, not chat, screenshots, clipboard history,
shell arguments or `VITE_` variables. A provider security-key/2FA prompt must be
completed by the owner. Do not repeatedly create keys after an uncertain result.
Keep the runtime key scoped to the isolated project, without Coinbase App trade,
transfer, receive or view access, wallet key Export, or policy Manage privileges.
Restrict its IP allowlist to the trusted backend's actual public egress, not the
frontend's localhost origin. Those settings still require actual API acceptance;
the algorithm or successful import alone does not prove permission boundaries.
Install a policy separately through the Portal rather than giving policy-edit
credentials to the runtime or agent.

Save the API-key JSON and separate Wallet Secret text file into an existing
owner-only directory outside this checkout. Each input file must be regular,
owned by the current user, mode 0600 and have one link; the direct parent must be
0700 and not a symlink. Never commit these downloads. The offline helper accepts
only explicit file paths:

```sh
node scripts/development-setup.mjs import-cdp --api-key-file /absolute/private/api-key.json --wallet-secret-file /absolute/private/wallet-secret.txt --output-file /absolute/private/cdp.json
```

It accepts exact `name/privateKey`, `id/privateKey`, or normalized
`apiKeyId/apiKeySecret` JSON shapes. API-key values are not trimmed or rewritten;
only the surrounding whitespace of the separate Wallet Secret text is removed.
Unknown export shapes fail closed. Ed25519 or P-256 API-key material and the
distinct P-256 Wallet Secret are checked locally, not authenticated with CDP.

After the public operator configuration contains the actual policy ID, selected
wallet, fixed test merchant/payee and Stripe sandbox account, combine it with the
protected CDP file and a separate protected **test** Stripe key:

```sh
node scripts/development-setup.mjs build-operator --config-file /absolute/private/config.json --cdp-file /absolute/private/cdp.json --stripe-key-file /absolute/private/stripe-test.txt --output-file /absolute/private/operator.json
```

Start from the `config` object in `examples/unattended-operator.example.json`,
not the whole example bundle. Do not substitute made-up account or policy IDs to
make setup pass. Output is created exclusively as 0600 and never overwritten.
Missing/unsafe parents, symlinks, hardlinks, non-regular files, oversized input,
unknown fields and live Stripe keys are rejected. Both the open and actual read
are bounded against special files/concurrent growth. The helper does not create
state directories, start a service, initialize an SDK, authenticate, sign or pay.
It prints only fixed status booleans or a fixed error code, never paths or values.
Direct-parent/realpath checks are not ancestor-path, ACL or full TOCTOU isolation.

An offline success still reports `providerConfigurationVerified:false`,
`paymentInitiated:false` and `fundingAccepted:false`. Keep the raw protected
downloads until independent provider configuration is accepted; no automatic
deletion or credential rotation is performed.

## Local operator process

Copy `examples/unattended-operator.example.json` to an absolute path **outside Git**
in a private directory. Replace its public placeholders and private values there,
never in the tracked example. The directory must be owner-only (0700), and the
file owner-only (0600), regular, with one link. Both state and order directories
must be distinct, absolute and owner-only. `developmentProjectConfirmed` is an
explicit operator assertion, not an API proof that a project is safe.

```
AGENT_TESTNET_DEVELOPMENT=I_UNDERSTAND_NO_REAL_FUNDS AGENT_OPERATOR_CONFIG=/absolute/private/operator.json node src/unattended/operator.mjs
```

### Backend IP allowlist and dual-stack hosts

An IPv4-only API-key allowlist must match the backend's actual CDP connection,
not just an IP-check website. On the inspected dual-stack host, that website
reported the allowlisted IPv4 while the SDK connected to CDP over IPv6 and
received HTTP 401. With the same key and unchanged permissions, fresh processes
using both flags below successfully read project policies and end users on
Node 24.13.0 and 26.7.0:

```sh
AGENT_TESTNET_DEVELOPMENT=I_UNDERSTAND_NO_REAL_FUNDS AGENT_OPERATOR_CONFIG=/absolute/private/operator.json node --dns-result-order=ipv4first --no-network-family-autoselection src/unattended/operator.mjs
```

Use this opt-in mode only after establishing an egress/allowlist mismatch; a 401
alone does not establish its cause. The flags affect this entire Node process,
including its Stripe/RPC connections, not the browser or other processes. They
do not provide IPv6 fallback when IPv4 is unavailable, guarantee proxy/custom
lookup behavior, or keep a changing public IPv4 allowlisted. Maintain the exact
trusted backend IP restriction separately. Do not remove the allowlist, expand
consumer/wallet permissions, patch the SDK/Axios, or set global `NODE_OPTIONS`
to work around an unexplained authentication failure. See Node's official
[DNS order](https://nodejs.org/api/cli.html#--dns-result-orderorder) and
[network-family option](https://nodejs.org/api/cli.html#--no-network-family-autoselection).

Successful process startup alone does not authenticate with CDP. Independently
verify safe, read-only provider calls without printing raw credentials or
diagnostics. Read success does not prove delegation, signing, policy enforcement,
merchant eligibility or payment acceptance.

Startup prints only the local enrollment URL and `fundingAccepted:false`. It does
not send an OTP, grant delegation, apply a policy, request funds, sign or pay.
The server binds only `127.0.0.1`. Keep it local: no reverse proxy, tunnel,
container public bind, public domain or production deployment is supported.
Plain loopback does not protect against a compromised local OS or port hijacking.

In `examples/email-onboarding`, set only its documented public project ID,
development assertion and enrollment origin. Never prefix provider credentials
with `VITE_`; they would become public browser code. Run its frontend explicitly
on the exact configured `http://localhost:4376` origin. Coinbase's development
allowlist accepts this domain but rejects IP-address entries. Vite still binds
only `127.0.0.1`; the enrollment endpoint remains `http://127.0.0.1:4377`.
Set `onboardingOrigin` to that same exact localhost browser origin. The two host
spellings are not interchangeable CORS aliases: only the single configured
Origin is accepted, including its scheme and port. No wildcard domain is added.

After provider login/delegation, request the bounded proposal, review its fixed
scope, and confirm. The restricted agent connection is returned only to that
authenticated owner, kept in UI memory and cleared on account change/sign-out.
It is a spending capability within the mandate, not a harmless public ID. Do not
send it to a website or publish it. Sign-out does not revoke a delegation; use
the backend stop/revoke operation first. Local revocation remains durable even
if Coinbase's revocation request fails; already issued signatures may still be
usable until their short order expiry.

## Expired sign-only provider-policy probe

After the actual project policy and owner account delegation are configured, a
trusted operator can explicitly run the finite probe below. Do not give its
developer credential file to an agent/MCP client. The setup-evidence file contains
only `projectId`, `userId`, `wallet`, `payTo`, `merchantAccount`, `testnetOnly:true`
and `fundingAccepted:false`; the installed-policy file contains exactly `id`,
`scope` and `rules` from independently verified provider readback. Both use the
same protected-file requirements as the credentials. These are operator records,
not browser-supplied permission or proof of project identity by themselves.

```sh
node --dns-result-order=ipv4first --no-network-family-autoselection scripts/provider-policy-probe.mjs --run-expired-testnet-policy-probe --cdp-file /absolute/private/cdp.json --setup-evidence-file /absolute/private/setup-evidence.json --installed-policy-file /absolute/private/installed-policy.json
```

The fixed suite rechecks the exact unique project policy, owned account and
bounded active delegation before every signing request. It locally recovers one
positive control, then tests a wrong payee, excess value, wrong verifying contract
and different primary type. Every request fixes Base Sepolia and
`validAfter:0` / `validBefore:1`: it never creates a currently usable USDC
authorization. Signatures are discarded in memory; no broadcast, settlement,
facilitator, Stripe, faucet or payment-ledger action is included.

An authentication failure, missing delegation, invalid request or refusal to
sign the expired positive control is **INCONCLUSIVE**, not policy-enforcement
success. Do not change the probe to a live authorization to make it pass.
**PASSED** establishes only those finite expired typed-data controls. It does
not test every provider operation, establish universal deny-all, lifetime-budget
enforcement, transaction expiry/revocation behavior, settlement or safe funding.

## Orders and agent adapters

For this development milestone, frozen acceptance orders must be prepared by a
trusted isolated merchant/operator, not by an AI supplying an arbitrary payee,
amount, signature or business quote. `PrivateOrderProvider` reads one 0600 JSON
file per UUID from the configured private order directory. Its complete shape is
the validated `ORDER_KEYS` contract in `src/unattended/intent.mjs`; the merchant
account, immutable grant, network, payee, nonce salt and short expiry must match.
No production listing/owner/quote endpoint is included. A private filename is not
a substitute for a future production merchant's authenticated order creation.

Only pass the returned restricted `AGENT_BROKER_ORIGIN` and `AGENT_BROKER_TOKEN`
to a standard local stdio client running `node src/unattended/client.mjs`.
The adapter refuses inherited CDP/Stripe developer credential environment names.
It exposes only pay-by-trusted-order-ID, inspect and reconcile plus truthful
readiness. It cannot enroll a wallet, raise a limit, reset a budget, change the
recipient or submit arbitrary typed data. Never configure automatic approval for
unrelated client tools or claim all hosted AI chat applications support stdio.

The per-instance capability and payment listener port change on service restart.
An authenticated owner must obtain the new local connection; existing grant and
budget remain unchanged. No provider secrets are returned. A fresh capability
does not prove a native model actually used the payment tools.

After expiry or revocation, use the separate explicitly approved
`POST /enrollment/v1/recover` owner-session route (`{wallet,approved:true}`). It
returns the **original** grant and a distinct `recoveryOnly:true` connection for
inspection/reconciliation. It does not require an active provider delegation,
renew the mandate or permit pay. The recovery listener rejects payment before
reading an order and its broker has no usable signing/settlement adapters. It
never initializes a facilitator. Reconciliation may record matching existing
testnet settlement in Stripe sandbox, but never sends funds again.

## Failure behavior and remaining gates

- Every new payment requires a fresh, mandatory read-only merchant preflight.
  It checks the expected Stripe account, sandbox balance, active crypto
  capability and one non-customer-scoped Base sandbox deposit address supporting
  the exact test USDC contract. Provider EVM addresses are compared as the same
  20 bytes, not rewritten into a different destination. The new authenticated
  deposit-list GET uses explicit `2026-10-14.preview`; existing PaymentIntent
  recording retains `2026-05-27.preview`. If the account lacks this preview/API
  capability or returns ambiguous data, stop; do not weaken checks or switch
  versions automatically. Those real account/API gates are not yet accepted.
- A failed preflight happens before reservation, signature or settlement, so it
  does not burn unused budget. No automatic retry is made. After the read,
  atomic reservation revalidates the unchanged order/quote, active mandate,
  expiry and shared budget. A duplicate/concurrent request cannot pay twice.
- Duplicate orders/business quotes are never repaid. Unknown outcomes retain the
  entire reserved amount. Inspect/reconcile does not sign or settle again.
- Reconciliation checks canonical/finalized testnet chain evidence and fresh
  Stripe sandbox identity/PaymentIntent evidence; pending is not success.
- Registry initialization is intentionally two-phase. A crash can leave
  `ENROLLMENT_INCOMPLETE`, which stops enrollment. An active registry with a missing
  payer ledger also stops; a leftover payer without a registry stops. Never
  delete files or reconstruct a fresh empty budget as an automated repair. Safe
  operator-assisted recovery of these states remains a future acceptance gate.
- The local OS user/operator/provider/RPC are trusted. This is not wallet-wide,
  cryptographically enforced cumulative spending or protection from a hostile
  same-user process, developer-key compromise, database rollback or deletion.
- The email example still has documented moderate transitive dependency
  advisories. Its Vite development security patch and bundle-boundary checks do
  not remove them or certify provider onboarding/funded-wallet use.

Before any funding instructions: complete actual own-email/delegation flow,
negative provider-policy tests, a **new** bounded test-USDC payment through the
new signer, independent settlement/Stripe proof, crash/revocation acceptance,
native compatible clients, and a separate production security/accounting review.
A future mainnet test needs explicit bounded owner authority after those gates.
No amount of mocked tests establishes these external results.
