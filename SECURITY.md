# Security and release scope

This project is experimental and its public MCP release is read-only. Wallet
funding and mainnet payment are not accepted. Do not interpret a passing test,
clean dependency audit or a reviewer report as a security certification.

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
