# Agent Wallet Gateway

One local Coinbase Agentic Wallet, a standard MCP interface for compatible AI
clients, and an experimental durable shared-budget ledger. No seed phrase or
private key is copied into an agent or this repository.

**v0.1.0 is READ-ONLY. It does not create a wallet, sign, transfer, trade or pay.**
Setting `enabled: true` is rejected. The former callable payment adapter has been
removed; even direct gateway payment calls reject before accessing the provider
or ledger. A successful protocol test is not native-client acceptance,
wallet authentication, mainnet payment or merchant fulfillment.

## Unattended payment development (not released for funding)

New `src/unattended/` components implement a **Base Sepolia testnet-only**
delegated signer, immutable order-bound EIP-3009 nonce, durable payer/merchant
stores, conservative shared budget, crash reconciliation and independent
chain/Stripe sandbox evidence checks. They are NOT mounted by `npm start` and
cannot enable mainnet through a flag. Read [the architecture and acceptance gates](ARCHITECTURE.md).

The [separate email onboarding example](examples/email-onboarding/README.md)
lets self-hosting developers configure their own public development project and
their users' own emails. A separately launched local development backend now
verifies provider sessions and enrolls one immutable bounded testnet mandate.
See [development-only operator setup](DEVELOPMENT_SETUP.md); this is not a hosted
multi-tenant service, accepted provider flow or funded-wallet release.
No actual email/delegation-provider acceptance is claimed by mocked tests or
its successful build. It has separately documented dependency advisories.

These are development modules, **not a completed autonomous payment product**.
Do not fund a wallet to test them. The owner still needs a separate development
CDP project, its normal login/configuration, private broker credentials, a
verified account delegation and actual provider-negative tests. Never paste
API keys, Wallet Secrets, email codes or private keys into a chat or GitHub.
The supported delegated-signing route is distinct from the existing AWAL login;
the same email does not establish the same wallet across projects/products.

## Why this exists

Coinbase's official MCP installer currently advertises a runtime archive that
returns 404 ([upstream issue #35](https://github.com/coinbase/payments-mcp/issues/35)).
The official `awal` CLI is a separate available distribution. This project bridges
its documented commands to local stdio MCP; it is **not a replacement custody
provider or a new cryptographic wallet implementation**.

Every connected client must run under the same approved OS user and point at the
same installed `awal` entry. The underlying official companion owns wallet login.
It is not one newly created wallet per client. Authentication and funding are
performed by the owner, never by this bridge.

## Install and connect (read-only)

Requires Node 24+ with `node:sqlite`. Use a patched supported Node release.

1. Follow the [official Agentic Wallet CLI setup](https://docs.cdp.coinbase.com/agentic-wallet/cli/quickstart).
   Use only official npm/vendor distributions; do not import your main wallet seed.
   Resolve startup problems **before funding**. This bridge does not patch or
   bundle an Electron runtime.
2. Clone this repository and run `npm ci --ignore-scripts` and `npm run check`.
3. Set `AGENT_WALLET_AWAL` to the absolute installed `awal/dist/index.js` file.
   The provider currently accepts only the inspected `awal` version **2.12.2**.
   A cached `npx` path can be used for local tests, but a persistent reviewed install
   is preferable. An arbitrary executable or shell command is not accepted.
   **Runtime warning:** the inspected CLI's original Electron 37 companion had
   dependency advisories. Our local repair upgraded its Electron to 44.7.2 and
   passed startup/status/IPC smoke checks, but that major upgrade is not an
   upstream-supported compatibility certification. Do not authenticate or fund an
   unpatched or unaccepted runtime. Read the full [acceptance record](ACCEPTANCE.md).
4. Connect `node /absolute/path/agent-wallet-gateway/src/server.mjs` to your client
   as a stdio MCP server, with the same `AGENT_WALLET_AWAL` environment variable.
   See [client configuration](examples/clients.md). Preserve existing servers;
   do not enable automatic tool approval or expose this process as a public server.
5. Ask the agent to call `wallet_status`. Before login it should truthfully report
   `authenticated: false`. The owner can open the official wallet using `awal show`
   and complete the email/OTP/terms flow themselves. Never paste an OTP or private
   key into a public issue. **Do not fund this experimental integration yet.**

## Exposed tools

| Tool | Effect |
| --- | --- |
| `wallet_status` | Read running/authenticated state; no email or credentials |
| `wallet_readiness` | Read explicit automated-payment blockers; funding is not accepted |
| `wallet_address` | Read the current public Base EVM address |
| `wallet_balance` | Read Base USDC balance in integer atomic units |
| `wallet_operation` | Inspect a saved local research operation without replay |

There is no mounted payment, signing, login, logout, budget-reset, grant-edit,
funding, transfer or trading tool. Connecting an AI does not grant it those powers.
Automated tests never use a customer's funded wallet or call a live signing or
settlement service. The new intent tests use disposable, unfunded, in-memory keys.

## Compatibility versus acceptance

Standard stdio MCP is the interoperability layer, not the AI model brand. The
configuration guide covers Codex CLI, Claude Code, Gemini CLI, Claude Desktop,
Cursor, and Cline. This does not assert that every product/version or hosted chat
supports local stdio; some hosted clients need a separately authenticated remote
connector, which this release deliberately does not provide.

Five named SDK client fixtures perform actual MCP initialize/list/call exchanges
against the same synthetic wallet identity. They are **not executions of vendor
applications**. `scripts/probe.mjs` additionally checks the actual local server in
a child process over stdio; it makes no payment and explicitly reports native
acceptance false. See [acceptance evidence](ACCEPTANCE.md).

## Shared-budget research, not a wallet-wide security guarantee

The ledger uses integer USDC units (1 USDC = 1,000,000), SQLite WAL/FULL and
`BEGIN IMMEDIATE`. Multiple bridge processes sharing the same state directory
cannot allocate more than the persisted policy. Tests cap a call at 5 USDC and a
grant at 10 USDC. Restarting or changing policy cannot reset that ledger.

In isolated ledger research, an operation is reserved **before** a hypothetical payer. Crashes, uncertain provider
results or timeouts retain the full reservation and never trigger automatic
repayment. Ledger confirmation consumes a trusted amount conservatively;
it does not prove chain settlement or merchant fulfillment. Canonical request
deduplication blocks the same request under a new UUID, not all semantically
equivalent merchant orders. A merchant still needs durable business idempotency.

This is a cooperative local gateway policy. Another program running as the same
OS user can invoke `awal` or modify local files outside this bridge. Separate OS
principals/provider-enforced policies are required for a hostile-agent boundary.
Never multiply a 10-USDC aggregate authority into 10 USDC for each agent, session
or new state directory. Per-session wallet limits are not proven global limits.

## Why payment remains blocked

Independent review found that the inspected CLI payment command cannot pin the
network, token, recipient or business order at its signer boundary. Wallet address
preflight is not atomic with signing; request discovery can change before payment;
redirect/DNS behavior lives in the companion. A maximum amount and correlation ID
do not fix these issues or create payment idempotency.

Before releasing payments, implement and test those boundaries, provider-side
limits and revocation, independent settlement evidence, unknown-outcome
reconciliation, and native-client end-to-end acceptance. BidGlow additionally
needs its own production order/ranking/recovery integration. Installing this bridge
does not make BidGlow unattended payments available.

The provider runner accepts only three exact read commands; it cannot forward
arbitrary CLI arguments. This does not restrict other programs under the same OS
user from invoking the separately installed wallet CLI directly.

For ordinary customer payments, Stripe's wallet-confirmed USDC checkout is a
separate path: the customer uses their existing supported wallet and approves the
payment. It does not require funding this experimental Agent wallet, and it is
not an unattended payment mandate.

## Tests and privacy

`npm run check` performs syntax checks and isolated Node tests: concurrent processes,
cold-start races, replay, policy immutability, unknown outcomes, unsafe state files,
MCP transport, redacted errors and provider arguments. Tests use temporary fixture
state, never customer wallets or real payments. `npm audit --omit=dev` checks this
bridge dependency tree only, not the separately installed wallet/Electron runtime.

The optional GitHub Actions template is `examples/check-workflow.yml`. It is not
active: publication credentials do not include GitHub's workflow scope. An owner
with that permission may review and install it under `.github/workflows/` later.
No hosted CI result is claimed by the local test results.

Keep all state and policy files outside Git in owner-only directories/files. Never
commit wallets, databases, OTPs, private receipts or provider credentials. No public
hosting or payment telemetry is built into this bridge. Official wallet software
has separate privacy controls; its telemetry is not controlled by this server.

This is experimental software, not an assertion of zero vulnerabilities or a
recommendation to entrust it with funds. See [SECURITY.md](SECURITY.md).
