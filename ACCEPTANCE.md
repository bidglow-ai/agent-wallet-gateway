# Acceptance evidence — October 14, 2026

## Current release: experimental, read-only

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

## Client evidence, without inflated claims

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

## Official runtime repair

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

The repaired CLI reports its service running and unauthenticated. Official
`awal show` reports opening its wallet window, but the native UI automation
surface could not bind that app; the login screen was not visually verified.
No wallet was created, no email OTP or provider agreement submitted, and no funds
were transferred. Do not mistake this operational state for an accepted payer.

## Payment blockers

- Inspected CLI pay parameters do not bind Base USDC/payee at the signing boundary.
- Wallet preflight and signing are not atomic; provider redirects/DNS and EIP-3009
  business-order binding need reviewed enforcement.
- Ledger budgets apply only to gateway-originated calls sharing this state, not
  every program with the same local user's authority or every new state directory.
- No independent mainnet settlement, merchant fulfillment, native paid request,
  revocation, provider-limits or lost-response reconciliation is accepted here.
- BidGlow's own production autonomous-payment/rank/recovery flow is a separate
  unfinished prerequisite. This repository does not change its production state.
