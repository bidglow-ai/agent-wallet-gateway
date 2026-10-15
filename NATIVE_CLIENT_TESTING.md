# Native-client testing without assets

Native model tool use, a protocol fixture, and a real provider-signed payment
are **three different acceptance claims**. This opt-in probe can establish only
the first, against a deliberately synthetic payment service. It cannot accept
funding, a real email wallet, CDP policy enforcement, a blockchain transfer,
Stripe evidence or a production ranking update.

## Isolated Codex probe

Requires a POSIX host, the inspected official native **Codex CLI 0.159.2**, and
an existing ChatGPT login. Use only the trusted installed executable; a version
string is not verification of an arbitrary replacement executable.
It does not install a client, change authentication, request a password/API key,
create a paid API billing route or change global MCP settings. If the expected
version or ChatGPT authentication cannot be confirmed, it stops. It may consume
the existing account's normal Codex usage allowance; it does not buy/reset quota.

```
AGENT_SYNTHETIC_ONLY=true node scripts/native-codex-probe.mjs --readiness-only
AGENT_SYNTHETIC_ONLY=true node scripts/native-codex-probe.mjs
```

The first command exposes only readiness, with no payment/reconciliation tool
approval. It must leave the independent ledger unreserved, allocation zero,
and every payment/sign/settlement counter zero. It establishes only discovery
and native read-tool use, never native payment-tool use.

The runner creates one temporary local fixture with a disposable unfunded
in-memory signer, a private payer ledger, and mock settlement/evidence adapters.
No CDP, AWAL, RPC, facilitator, Stripe or merchant network request is implemented
in that fixture. Its only frozen order is 5 **synthetic** test USDC under a shared
10-test-USDC allowance. `confirmed` there means fixture state, not real money.

Codex is launched with an ephemeral session, ignored user configuration,
read-only sandbox, forced ChatGPT authentication, disabled search and unrelated
execution/browser/plugin/app capabilities. A temporary command-line MCP entry
points at the **actual** `src/unattended/client.mjs` stdio adapter. The adapter
receives only a one-instance local fixture capability, not developer credentials.
Only the fixture payment/reconciliation tools receive invocation-local approval;
no approval policy is installed for real wallets or other MCP servers.

The inspected model uses the bundled Code Mode bridge. Earlier native probes
with that bridge disabled failed without any MCP calls; those attempts were
not accepted. The runner now explicitly enables it without in-process fallback
and excludes the core `functions` namespace from nested tool use. This is not a
global claim that the CLI registers only four tools. Unknown executed item types
still fail validation; the ordinary MCP events remain required.

The prompt asks the native model to call readiness, pay once, inspect and
reconcile. Passing requires the corresponding completed MCP events in that
order, matching frozen order IDs, successful non-error synthetic responses,
and independent service/ledger counters proving one sign and one settlement.
An assistant saying “success,” a saved server configuration, or an SDK client
named after Codex does not pass. Any unexpected tool execution rejects the run.

Output contains only restricted synthetic evidence, never raw native account
diagnostics, signatures, private keys or developer credentials. No capability is
written into the fixture trace. Startup preflights and native output have byte
and time limits; stderr authentication matching returns only a boolean and
diagnostics use fixed enumerations, not raw error messages.

Temporary fixture data is removed after the probe. Process control targets only
the exact POSIX process group it starts, not arbitrary escaped descendants. The
inspected CLI starts Code Mode/MCP helpers in separate groups: normal client
shutdown and protocol EOF handle their termination, while forced termination
cannot prove full-tree cleanup. The native run requests orderly Ctrl-C first;
this wrapper is **not** an OS containment boundary or support for hostile
replacement executables. A timeout is failure, not accepted native execution.
Normal `npm run check` never launches a native model;
its deterministic tests exercise only fixtures, process controls and evidence
validation.

A successful probe reports both `nativeModelToolUseObserved:true` and
`providerPaymentAccepted:false`, `mainnetPaymentAccepted:false`,
`fundingAccepted:false`. Do not remove those qualifications or use this result
to tell an owner to deposit assets. A failed or unconfirmed run is not native
acceptance and must not be replaced with a weaker SDK-only result.

## Other clients and the actual payment gate

Use each client's own ordinary MCP/trust interface for later acceptance. Do not
copy a Codex result into Claude, Gemini, Cursor, Cline or hosted-chat rows. Local
stdio support depends on the product/version and configuration; no universal
client acceptance is implied by using the MCP standard. Real wallet-address and
bounded-payment comparisons still require the same accepted owner mandate,
actual provider configuration and independent receipts.

The [email-wallet development guide](DEVELOPMENT_SETUP.md) and
[acceptance record](ACCEPTANCE.md) retain those separate gates. Never disable a
client trust control, substitute a real provider in this synthetic harness,
point it at a funded wallet, or reset a ledger to make an acceptance run pass.

Official client references:

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [MCP configuration and tool approval](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
