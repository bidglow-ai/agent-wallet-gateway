# Acceptance evidence

## Current external gates — October 15

| Gate | Evidence/status |
| --- | --- |
| Own-email login and first-use delegation lookup | Observed through the real SDK; lookup reports no active delegation. |
| Protected CDP credentials | Owner security-key verification requested; no completed key/Wallet Secret download is yet confirmed. |
| Provider policy, negative signing tests and bounded account delegation | Not yet accepted for this new signer. |
| Public test facilitator and Base Sepolia RPC | Read-only supported-network, SDK initialization and finalized-block checks passed; no verify/settle call. |
| Authenticated Stripe merchant/deposit preflight | Implemented and fixture-tested; actual account, preview access and address/token match not yet accepted. |
| New provider-signed test-USDC payment and independent Stripe evidence | Not yet run. |
| Native clients | Codex has isolated synthetic tool-use evidence; no native provider-payment or universal-client acceptance. |
| Mainnet/funding | Disabled and not accepted; no deposit instructions. |

## Before-sign merchant binding — October 15, NOT actual payment acceptance

- Found a real missing integration boundary: the previous verifier checked
  Stripe identity only after a chain transfer. An arbitrary configured payee
  could match the chain logs without being a Stripe merchant deposit address.
  Every new broker payment now requires a fresh, mandatory GET-only preflight
  of the expected merchant, sandbox balance, active crypto capability and one
  unscoped sandbox Base deposit address supporting the exact test USDC contract.
- Its strict own-data attestation has four fields and binds the frozen order
  digest. Missing/false/extra/stale attestations cannot reach signing. Provider
  EVM response casing is accepted only after exact 40-hex validation and equality
  of the same 20 address bytes; canonical order data/digest are never changed.
- The pure reads occur before allocation. Failure creates no order/reservation
  and signs/settles nothing; no automatic retry occurs. The original atomic
  reservation rechecks expiry/revocation/quote uniqueness/shared budget after the
  await. Existing unknown outcomes keep their full hold, and reconciliation does
  not require another new-spending preflight or call a signer/facilitator.
- New deposit-list GET explicitly uses `2026-10-14.preview`; existing Stripe
  account/balance/PaymentIntent calls retain `2026-05-27.preview`. An unsupported
  preview returns failure without automatic version fallback. Its public
  contract was checked against the pinned [Stripe preview SDK](https://github.com/stripe/stripe-node/blob/1a30a44ba612bd83dbfd331f5500389e59898f71/src/resources/Crypto/DepositAddresses.ts)
  and [preview OpenAPI](https://github.com/stripe/openapi/blob/dfa6772d635abce5154c310ab35c9c820aa32eb0/openapi/spec3.private_preview.sdk.json).
  This is contract evidence, not actual private-preview/account eligibility.
- Separately, actual public `GET /supported` returned HTTP 200 with exact v2
  Base Sepolia support, the official x402 resource server initialized against
  that public facilitator, and a public Base Sepolia RPC returned the expected
  chain ID and a finalized block. No payment verify, signature, settlement,
  faucet, private Stripe request or production write was made by these checks.
- Root full checks pass **162/162** on Node 26.7.0 and Node 24.13.0. Independent
  API/wire review reran the 38 focused tests on Node 24. These fixture results
  do not establish current merchant ownership, provider policy acceptance or a
  new transfer. Those external gates remain above. **Do not fund a wallet.**
- A separate frontier-model code reviewer found no concrete blocking bypass,
  budget race or diagnostic leak in the frozen patch; 35 focused tests passed
  independently on both Node versions, plus synthetic suspended-preflight budget
  exhaustion and signer-failure/full-hold probes. Email-page typecheck, 44 tests
  and production build also pass. This is scoped review, not certification.
- Reran the actual Codex CLI 0.159.2 against the updated disposable fixture.
  Readiness-only used one read tool, allocated zero and made no pay/sign/settle
  call. The separate complete native run used readiness, pay, status and
  reconcile exactly once, with one synthetic signature/settlement, one evidence
  verification and 5,000,000 synthetic units allocated. The new merchant
  preflight was synthetic too; provider calls were zero and provider/mainnet/
  funding acceptance remained false. No other native client result is inferred.

## Actual first-use delegation lookup and safe credential import — October 15

- The real SDK's GET returned the documented account-scoped absence sentence
  **without its final period**. A static-candidate comparison established that
  exact difference without exposing raw provider diagnostics. The controller now
  accepts only the two verified fixed literals under `404 / not_found` in its
  GET-specific branch, retaining fresh identity/account checks. Generic 404,
  whitespace/case variants and create/revoke failures still remain unconfirmed.
- After this patch, the same real signed-in development browser successfully
  displayed **Selected account delegation: none.** No consent was checked, no
  delegation was created and no backend capability was returned. This resolves
  the first-use lookup problem recorded below, not delegated-payment acceptance.
- Added a separate offline path-only import/build CLI. It validates protected
  repository-external inputs, exact key/config shapes, owner/mode/link/type and
  bounded reads; creates output exclusively; never initializes the provider or
  prints credentials. Independent review found and reproduced a FIFO-open hang;
  nonblocking opens plus regression tests now reject it. The existing runtime
  private-JSON reader also bounds actual reads if an inode grows after `fstat`.
- Root syntax/full checks pass **153/153** on Node 26.7.0 and Node 24.13.0.
  Frontend typecheck, **44/44 tests** and Vite production build pass. Independent
  review reran the 16 controller tests and 19 setup/private-file tests on Node 24,
  finding no remaining blocking issue in this scoped patch. SDK-transitive
  moderate dependency advisories remain, not waived by these checks.
- Prepared one runtime-key request for the isolated development project with
  consumer Coinbase App permissions, wallet Export and policy Manage disabled,
  Ed25519 selected and a single backend-egress IP restriction. Submission
  prompted owner security-key verification. The browser was handed to the owner;
  no key download or Wallet Secret import is yet confirmed. Do not retry key
  creation blindly. Provider permission boundaries still need real acceptance.

No signing, transfer, faucet request, Stripe write, production change or funding
instruction occurred. Remaining: protected credential completion, exact provider
policy and negative tests, bounded delegation/mandate, new provider-signed
test-USDC payment plus independent evidence, native clients and production review.
Default startup remains read-only. **Do not fund a wallet.**

## Delegation GET contract coverage — October 15, NOT actual delegation acceptance

- Rechecked the isolated project: its delegated-signing feature is enabled, but
  no project policy or Wallet Secret has been configured; no enrollment backend
  is running or returning a payment capability.
- Official account-scoped delegation GET documentation uses `404 / not_found`
  with a fixed no-active-delegation message. The earlier local guard accepted
  only `delegation_not_found`, missing that documented first-use response.
  The controller now accepts the exact documented status/type/message triple
  only in its GET-specific, identity/account-revalidated branch. It retains the
  existing legacy code; generic/HTML 404, other messages, identity changes and
  create/revoke errors cannot become absence or successful authorization.
- Four new fixture groups cover the documented response, negative variants,
  changed identities and non-retried create/revoke failures. Frontend typecheck,
  **44/44 tests** and production build pass on Node 26.7.0; the 16 focused
  controller tests also pass on Node 24.13.0. Independent review found no
  permission expansion or new blocking regression.
- A safe boolean-only comparison against the actual provider error confirmed
  `404 / not_found`, but its message **did not match** the documented fixed
  example. The actual lookup therefore remains `unknown`; this patch covers
  the public contract, not a demonstrated resolution of that live response.
  No raw provider diagnostic, session, account identity or secret is recorded.

No delegation, mandate, signing or payment was performed. Existing provider
products already support agent wallets/delegated signing; this work is an
integration and acceptance effort, not proof that no existing wallet exists.
Default startup remains read-only. **Do not fund a wallet.**

## Actual owner email login — October 15, NOT delegated payment acceptance

- The owner entered the fresh OTP in the local browser, and the official SDK
  completed real email verification (HTTP 200) and returned one EVM account.
  The UI showed signed-in, cleared temporary email/OTP fields and exposed no
  broker connection. No account identifier or credential is published here.
- A read-only delegation lookup returned **404 with generic `not_found`**,
  not `delegation_not_found`. The UI correctly retained `unknown`; it did not
  interpret an ambiguous error as permission to create another delegation.
  Independent installed-SDK review confirmed the conservative error mapping.
- The isolated project's delegated-signing prerequisite was disabled and no
  project policy or Wallet Secret was configured. Attempting to enable only
  that project feature prompted a fresh owner two-step/passkey verification.
  That prompt was handed to the owner; feature enablement is not yet confirmed.
- Real sign-in does not grant an account delegation, local spending mandate or
  payment capability. No provider key/Wallet Secret generation, policy mutation,
  signing, transfer, faucet request, Stripe write or production change occurred.

Remaining: confirmed isolated project configuration, protected credentials,
actual provider policy and negative tests, bounded owner delegation/mandate,
new provider-signed test-USDC payment with independent evidence, other native
clients and production review. The SDK advisories remain. **Do not fund a wallet.**

## Email visibility and sign-in feedback fix — October 15

- Fixed a real UI bug: submitting the email and completing any action both
  cleared the email field. The pending email now stays in the DOM/private UI
  memory while requesting, awaiting or retrying a code. It is not added to the
  controller's public state, application storage, logs or backend requests.
- Awaiting-code input is read-only and resends stay bound to that same email.
  Changing email explicitly cancels the local flow; an unconfirmed resend
  cannot continue using the old flow. No automatic resend or payment occurs.
  OTP attempts clear the code, not the email; successful authentication,
  sign-out attempts and identity changes clear temporary sign-in fields.
- Feedback now appears next to the sign-in forms. Pasted OTP edge whitespace
  is trimmed; internal content is not rewritten. Invalid-code feedback uses
  one allowlisted provider error type, never its raw diagnostic message.
- Ten new tests execute the actual main UI module/event bindings with the real
  controller and synthetic SDK/DOM. They cover pending/error/retry/double-click,
  resend/change, missing verified identity, normal early SDK auth notifications,
  stale identity callbacks and sign-out cleanup without granting delegation or
  calling an enrollment backend. Frontend **40/40 tests** pass on Node 24.13.0
  and Node 26.7.0; typecheck and Vite production build pass. Root syntax/checks
  and **140/140 tests** were rerun on Node 26.7.0. Independent review found no
  blocking regression.
- Actual browser verification requested one fresh code through the official
  SDK and confirmed that the email stayed populated/read-only and OTP controls
  became usable. The page was handed to the owner for code entry; this is not
  completed real email authentication, delegation or payment acceptance.
- An earlier real verification attempt returned HTTP 401. Its exact cause was
  not established by the email-visibility bug or synthetic tests, and no claim
  is made that real authentication has passed. Browser-SDK dependency inventory
  still has five moderate entries, zero high/critical; the audit remains failing.

No provider signing, transfer, production change or funding instruction was
performed. Remaining external gates below are unchanged. **Do not fund a wallet.**

## Real development-browser startup — October 15, NOT a funding release

- Root syntax checks and **140/140 isolated tests** pass on Node 26.7.0 and
  Node 24.13.0. The email example passes typecheck, **30/30 tests**, a fresh real
  Vite development prebundle and its Vite 8.0.16 production build.
- Actual CDP portal configuration rejected an IP-address allowlist entry.
  A separate empty development project now allows only the exact
  `http://localhost:4376` browser origin. Enrollment CORS accepts one configured
  origin, not both hostname aliases; all backend listeners and broker
  capabilities remain literal `127.0.0.1`. Wrong aliases, ports and spoofed
  hosts are rejected in permanent regression tests.
- The actual browser then exposed a missing React peer reached through the
  SDK's Zustand root import. The prior production-only build had hidden it.
  An exact compatible React dependency and a real fresh dev-optimizer test fix
  this; no SDK replacement, React DOM, dependency alias or payment-permission
  change was used. After restarting the owned local Vite process with forced
  dependency reoptimization, the actual browser initialized the official SDK.
- The official SDK confirmed a request for an owner email verification code.
  Owner verification, wallet identity, delegation, provider policies and payments
  are **not** inferred from that request. No provider API key or Wallet Secret
  was generated in this step, and no payment or production change occurred.
- Private operator/order JSON now additionally requires a canonical lexical
  path and an owner-only, non-symlink direct parent directory (0700), preserving
  opened-file 0600, owner, single-link and `O_NOFOLLOW` checks. This is not
  ancestor-path, ACL or filesystem-race isolation. Independent scoped review
  found no blocking regression; its 20 focused synthetic tests passed.
- Root production dependency audit reports zero. Full and production-only
  email-example audits still fail with **five moderate** SDK-transitive package
  entries and no high/critical findings. These are not waived by build success.

The existing native Codex acceptance below remains **synthetic**, with zero
provider calls; no new native-provider payment acceptance is claimed. Remaining:
actual owner email/account/delegation, protected provider setup and negative
policy tests, a new provider-signed test-USDC payment with independent
chain/Stripe evidence, other native clients and separately reviewed production
security/accounting. Default startup remains read-only. **Do not fund a wallet.**

## Native Codex synthetic milestone — October 15, NOT a funding release

- Root syntax checks and **132/132 isolated tests** pass on Node 26.7.0 and
  Node 24.13.0. Normal checks launch no native model or real payment provider.
- Email-example typecheck, **27/27 tests** and Vite 8.0.16 production build
  were rerun successfully. Root production dependency audit reports zero;
  email-example production dependency audit still reports **five moderate**
  SDK-transitive package entries. No forced breaking downgrade or advisory
  suppression was used. Those dependency gates remain unresolved.
- An actual **Codex CLI 0.159.2 model session**, using the existing ChatGPT
  authentication route and temporary MCP configuration, completed a
  readiness-only run. The only accepted completed tool was readiness; the
  independent fixture ledger remained unreserved with zero allocation and
  zero pay/sign/settle calls.
- A separate actual native model session then completed, in order, readiness,
  one pay, status and reconcile through `src/unattended/client.mjs`. Completed
  native MCP events matched one frozen synthetic order. Independent local
  service counters observed exactly one pay/inspect/reconcile/sign/settle,
  one evidence verification and 5,000,000 atomic units allocated from a
  10,000,000 synthetic allowance. No repeated owner prompt was needed inside
  this narrowly pre-authorized synthetic run.
- **The signer was a disposable unfunded in-memory key, settlement and receipt
  adapters were synthetic, and provider calls were zero.** Both actual native
  runs explicitly returned provider/mainnet/funding acceptance false. No CDP
  login, delegation, provider policy, blockchain transfer, Stripe write,
  BidGlow deployment or production ranking was performed by these runs.
- Earlier native attempts produced client errors and no MCP calls. They did
  not pass and are not counted as executed payments. The native tool bridge
  configuration was corrected without changing models or weakening the MCP
  event/order/result validator; unknown tool execution still rejects a run.
- Independent scoped review reproduced and led to fixes for unbounded
  synchronous startup preflights and diagnostic metadata leakage. Regression
  tests cover bounded process-group termination, split-stream authentication
  classification and fixed-enumeration diagnostics. This is not whole-process
  containment: official Code Mode/MCP helpers use separate process groups,
  relying on normal shutdown/protocol EOF. Forced termination cannot prove
  complete helper cleanup; hostile replacement binaries are unsupported.
- This is **native Codex synthetic tool-use acceptance only**, not real
  payment acceptance and not Claude/Gemini/Cursor/Cline native acceptance.
  See [reproducible native probe and limitations](NATIVE_CLIENT_TESTING.md).

Remaining: actual owner-authorized development CDP configuration, verified
email/delegation and provider-negative tests, a new provider-signed test-USDC
transfer with independent chain/Stripe evidence, other native clients,
unresolved browser-SDK advisories and separately reviewed production
integration. Default `npm start` stays read-only. **Do not fund a wallet.**

## Own-email enrollment milestone — October 15, NOT a funding release

- Root syntax checks and **116/116 isolated tests** pass on Node 26.7.0 and
  Node 24.13.0. Email example typecheck, **27/27 tests** and Vite 8.0.16 build pass.
  These are local fixtures, not new provider authentication, testnet transfers,
  vendor-native model payments or mainnet acceptance.
- Implemented fixed project/wallet enrollment registry, fresh official-session
  verification, one-use frozen proposal and separate one-time owner approval.
  Browser/API callers cannot supply identity, grant ID, budget, merchant or path.
  Re-login/restart preserves original mandate, expiry, reservations and revocation.
  Pending initialization and a lost registry/payer ledger fail closed rather
  than silently creating an empty spending allowance.
- An actual local HTTP integration test enrolls through a **fixture** provider,
  pays a frozen **fixture** order, restarts, and refuses duplicate payment. A
  second **fixture** settlement loses its response; after local revocation,
  restart and simulated expiry, a separately authenticated recovery-only
  connection inspects/reconciles it without any new sign or settle call.
- Recovery-only HTTP rejects pay before order lookup; the recovery broker is
  constructed with forbidden sign/settle adapters and never initializes a
  facilitator. It reuses the original ledger, not a new grant or renewed expiry.
- Independent cross-review found and led to fixes for capability issuance racing
  revocation and missing post-restart expired/revoked recovery access. Related
  focused tests pass on both Node versions. Frontend review additionally fixed
  late delegation responses being applied after account changes/sign-out.
  This is scoped implementation review, not a whole-wallet security certification.
- Root dependency audit: zero advisories. Email-example full/production-only
  audits: **five moderate package entries remain** in official SDK transitives,
  no high/critical. A compatible Vite patch removed its high development-tool
  entry. No unsupported major override, SDK downgrade or audit suppression used.
  See the example's dependency report; dependency gates are not all green.
- Default `npm start` remains read-only. New operator bootstrap requires explicit
  testnet acknowledgment and owner-only operator config outside the repository.
  Agent adapters receive a scoped capability, never project/Stripe credentials.
  No actual login, delegation, policy write, faucet request, new chain transfer,
  production change, mainnet funding instruction or payment was performed.

Remaining external gates: owner development-platform login/configuration, actual
email/account delegation and provider-negative tests, a **new** provider-signed
test-USDC transfer with independent chain/Stripe evidence, native clients,
unresolved SDK advisories, safe incomplete-enrollment recovery/renewal and
separately reviewed production accounting/security. Do not fund this milestone.

## Unattended development milestone — October 15, NOT a funding release

- 92 root tests and syntax checks pass on Node 26.7.0 and Node 24.13.0. This
  includes real EIP-712 signature recovery with disposable unfunded fixture keys,
  independent mocked chain/Stripe evidence, restart/replay/revocation, immutable
  known transactions, business-quote uniqueness and concurrent durable budgets.
- Five SDK protocol sessions share one actual broker ledger: two 5-test-USDC
  reservations reach the 10-test-USDC grant limit; three more are rejected before
  signing. Three real stdio child processes connect through the authenticated
  local HTTP adapter without developer credentials. These are not vendor-native
  model/client payment acceptances or blockchain transfers.
- Separate email-onboarding example: actual SDK TypeScript imports, ten mocked
  tests and Vite build pass. Its audit reports five moderate transitive dependency
  entries; these remain unresolved. The root dependency audit reports zero.
- Cross-review reproduced and led to fixes for interrupted-state recovery,
  per-call provider-policy mismatch, canonical/finalized receipt checks, known
  transaction replacement and duplicate business-quote purchases.
- Native macOS unlink racing was reproduced with synthetic regular owner-only
  files: lstat may report zero links for a deleted optional SQLite sidecar. The
  corrected guard still rejects unsafe type/owner/mode, hardlinks, symlinks and
  a mandatory database with zero links. Child-isolated regression and repeated
  eight-process cold-start tests pass.
- A public historical Base Sepolia receipt was read and its official USDC event
  ABI/finalized height checked. No new transaction, CDP signing, email sign-in,
  delegation, production record, refund, ranking or deployment was performed.
- Official CDP token validation/account-delegation calls and policy schema were
  inspected against pinned SDK 1.58.0. Actual provider policy installation and
  negative signing tests remain unverified. A compile or mocked SDK test does
  not prove provider behavior, free-tier availability or account authorization.

Remaining: authenticated bounded-mandate enrollment, completed owner development
project setup, actual email/delegated-signer testnet acceptance, isolated merchant
fulfillment/recovery, native clients and separately reviewed production integration.
The default AWAL server stays read-only. Do not fund a wallet for this milestone.

## October 15 hardening

- Removed the provider payment adapter and blocked direct gateway payment calls
  before all provider/ledger access, including when a caller passes `enabled:true`.
- Provider command forwarding is limited to three exact read-only commands.
- Added `wallet_readiness` to report automated-payment release blockers. It never
  treats a successful login, wallet address or balance as funding acceptance.
- Owner-authorized official authentication and three separate real stdio MCP
  address reads were observed locally. Account details, wallet address and balance
  are deliberately omitted here. These were SDK processes, not native vendor model
  payment acceptance. No payment, signing or transfer was performed.
- Native-client restrictions and the locally modified runtime caveat below remain.
- All 32 isolated tests pass on Node 26.7.0 and 24.13.0 after hardening; bridge
  dependency audit reports zero advisories. A fresh real-stdio probe reports an
  authenticated wallet, five read-only tools and funding/payment acceptance false.
  No live transaction was attempted. These checks are not a security certification.
- Independent scoped application-security review accepted the read-only hardening
  after the caller-iterator bypass was fixed and regression-tested. Ten repeated
  eight-process cold-start ledger tests passed after a bounded SQLITE_BUSY retry
  was added only around journal-mode setup; no payment operation is retried.

## October 14 baseline (historical, before owner authentication)

### Historical release: experimental, read-only

- 31 isolated tests pass on local Node 26.7.0 and Node 24.13.0. No real wallet,
  token, private key, merchant purchase or customer record is used in tests.
- The actual local stdio child-process probe initialized MCP, discovered four
  read tools and called `wallet_status` against installed official `awal` 2.12.2.
  Result: server running, wallet **not authenticated**, payments disabled.
- Dependency audit of this bridge: zero reported advisories at the check time.
  This is not a security guarantee or an audit of the external wallet runtime.
- Hosted GitHub Actions were not run. Existing OAuth scope does not permit
  creating workflows; an inactive reviewed template is included under `examples/`.
  No broader account permission was requested to work around that restriction.
- Independent payment/ledger implementation review and independent application
  security review were performed. They required blocking the live payment tool;
  the release implements that block. No whole-system bug-free claim is made.

### Historical client evidence, without inflated claims

| Client | Local configuration | Actual observed evidence | Not accepted |
| --- | --- | --- | --- |
| Codex CLI | Read-only server registered | Named server configuration retrieved; independent real-stdio probe passes | Native model tool use, authenticated address/balance, payment |
| Claude Code | Read-only server registered | Native `mcp get` health check reports Connected | Native model tool use, authenticated address/balance, payment |
| Gemini CLI | Read-only server registered | Native `mcp list` sees server but disables it in this untrusted folder | Connection/model/authenticated wallet/payment; no trust bypass used |
| Claude Desktop | Instructions provided | Standard protocol fixture only | Native application acceptance |
| Cursor | Instructions provided | Standard protocol fixture only | Native application acceptance |
| Cline | Instructions provided | Standard protocol fixture only | Native application acceptance |

Named SDK protocol fixtures are not vendor client executions. A genuine shared
wallet-address comparison from the native clients still requires owner login and
each client's ordinary trust/tool permissions. A configured server is not proof
that an AI model has discovered it or successfully used it.

### Historical official runtime repair

The official MCP installer's runtime archive returns HTTP 404; no unofficial or
guessed replacement archive was used. The separate official `awal` npm package
provides a companion distribution. Its Electron postinstall left incomplete
extraction despite a valid cached upstream ZIP. The cached archive's SHA-256
matched the checksum in the installed official Electron package; archive integrity
verification passed. System unzip restored the official files and the normal
Electron executable path marker was repaired. No Electron code-signing,
certificate, wallet-signature or IPC identity check was disabled. This is a local
repair, not a claim to have fixed Coinbase's upstream download service.

The original companion audit reported six entries (two high, four moderate),
including Electron 37.10.3 and its extraction dependencies. The owner-created
unauthenticated service was cleanly stopped using official `awal quit`, and its
package/lockfile retained locally for rollback. The local companion dependency
was upgraded through official npm to Electron 44.7.2; its official install binary
completed, dependency audit reported zero advisories, and actual CLI status and
real-stdio IPC checks passed with the service still unauthenticated. This is a
**locally modified major-version runtime**: login, signing, payment and full UI
compatibility are not accepted. No forced audit fix or security downgrade was used.

At the October 14 check, the repaired CLI reported its service running and unauthenticated. Official
`awal show` reports opening its wallet window, but the native UI automation
surface could not bind that app; the login screen was not visually verified.
No wallet was created, no email OTP or provider agreement submitted, and no funds
were transferred. Do not mistake this operational state for an accepted payer.

## Payment blockers (still current)

- Inspected CLI pay parameters do not bind Base USDC/payee at the signing boundary.
- Wallet preflight and signing are not atomic; provider redirects/DNS and EIP-3009
  business-order binding need reviewed enforcement.
- Ledger budgets apply only to gateway-originated calls sharing this state, not
  every program with the same local user's authority or every new state directory.
- No independent mainnet settlement, merchant fulfillment, native paid request,
  revocation, provider-limits or lost-response reconciliation is accepted here.
- BidGlow's own production autonomous-payment/rank/recovery flow is a separate
  unfinished prerequisite. This repository does not change its production state.
