# Security and release scope

This project is experimental and its public MCP release is read-only. Wallet
funding and mainnet payment are not accepted. Do not interpret a passing test,
clean dependency audit or a reviewer report as a security certification.

The new `src/unattended/` development modules are NOT part of the mounted AWAL
MCP server. Their separate threat boundary trusts the operator broker, its
isolated CDP project credentials, RPC/provider transports and local database.
AI clients must never receive developer credentials or raw signing access.
One CDP project per trusted process; the pinned SDK has shared client state.
Use distinct payer and merchant state directories. Never share/multiply one
budget across new directories as a normal operational workaround.

The separate development enrollment service authenticates the provider session
and fixed operator-selected wallet; it never accepts a caller's user ID, grant,
budget or state directory as authority. One-use proposals require explicit owner
confirmation, then all clients share a fixed lifetime mandate and payer ledger.
Revocation racing asynchronous activation blocks capability issuance. Pending
initialization or lost registry/ledger stops enrollment; automatic reconstruction
and safe renewal are intentionally unimplemented. These protections have fixture
tests, not real email/provider or funded-wallet acceptance.

The optional testnet HTTP factory rejects browser Origin headers, validates the
exact loopback Host/peer and uses a per-instance scoped bearer token. Bind it to
127.0.0.1; do not publish it through a proxy, tunnel or public interface. Plain
loopback HTTP authenticates clients, not a potentially hostile local peer that
can replace a stopped server's port. A public deployment requires a separate
authenticated HTTPS design and review. Agent adapters reject inherited developer
credentials and must receive only the restricted broker capability token.

The proposed project policy restricts EVM typed-data token/payee/per-call value,
but it does not establish provider-enforced cumulative spending, domain-chain
matching or frozen-order binding. Those are enforced in the trusted broker.
Operations omitted from provider policies can default to allowed: do not call
the template a universal deny-all policy. Limit delegation to one empty EVM
account and test actual provider rejections before signing. A compromised broker
or another same-user process is not contained by its SQLite budget.

New spending additionally requires a fresh read-only Stripe merchant preflight:
the expected merchant, sandbox mode, active crypto capability, unique unscoped
deposit address and exact test USDC must match the frozen order. Its attestation
is bound to that order's digest; missing or ambiguous evidence cannot authorize a
signature. This GET-only step occurs before allocation, followed by the original
atomic active/expiry/uniqueness/budget checks. It never frees an existing hold,
creates a deposit address/PaymentIntent, changes a policy or replaces independent
settlement evidence. Reconciliation of an existing payment does not require new
spending eligibility. Real preview/account acceptance is still a release gate.

Delegation revocation stops future provider signatures, not authorizations that
already exist. Those may remain spendable until the short order expiry.
Independent evidence checks require exact USDC AuthorizationUsed/Transfer logs,
a canonical receipt block and RPC finalized height, then a fresh matching Stripe
test PaymentIntent. Provider/RPC trust is not eliminated by these checks.

## Threat boundaries

- Trusted: the local OS user, installed Node/official wallet runtime, operator
  configuration and SQLite storage. Same-user hostile code is outside the ledger
  security boundary and can bypass a cooperative local wrapper.
- Untrusted: MCP arguments, merchant pages/responses, request bodies, diagnostic
  strings, process failures and concurrent requests. Errors are allowlisted codes;
  raw provider output, email, tokens and merchant response content are not emitted.
- No network listener: stdio only. No auth, signer, transfer or payment tool is
  mounted. Do not add a public relay or reverse proxy without a new threat model.
- Ledger tests isolate multiple processes on a local filesystem. They do not
  establish distributed/NFS locking, rollback-proof accounting against a local
  administrator, signer-enforced global budgets or remote provider guarantees.
- The provider payment adapter has been removed. The gateway rejects even direct
  payment calls before any provider/ledger access, and the provider runner accepts
  only exact status, Base address and Base USDC balance commands. These safeguards
  are not signer-side restrictions on other same-user programs or the vendor CLI.

Keep runtime state owner-only and outside the repository. Never put private keys,
wallet seeds, OTPs or receipts in issues. To report a suspected vulnerability,
contact admin@bidglow.ai with a minimal non-secret description; do not attach
credentials, payment signatures or customer data. No response SLA is promised.

## Required before enabling payment

1. Exact network/token/payee and frozen business order at the signer boundary.
2. Atomic budget enforcement and revocation across the intended trust boundary.
3. Durable merchant idempotency, transaction deduplication and independent receipts.
4. Timeout/crash/restart/unknown-settlement reconciliation without blind repay.
5. Native-client and provider acceptance in an isolated environment.
6. Owner-authorized limited mainnet acceptance, separate from testnet/fixtures.
