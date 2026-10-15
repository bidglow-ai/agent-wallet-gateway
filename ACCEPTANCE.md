# Acceptance evidence

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
