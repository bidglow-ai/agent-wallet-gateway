# Dependency security review — 2026-10-15

Status: **not remediated upstream; five moderate audit package entries remain**.
Scope: this standalone browser example only. No provider login, account mutation,
delegation, signing or payment was performed for this review. No UI/controller
flow or SDK version was changed. Dependency changes are the compatible Vite
security patch and explicit React peer installation below, both reflected in
this example's lockfile.

## Fixed missing development peer

Actual browser startup failed even though the production build passed:
`Could not resolve "react" imported by "zustand"`. The installed CDP core
0.0.127 imports `zustand`; installed Zustand 5.0.15's `esm/index.mjs` re-exports
`zustand/react`, whose module directly imports `react`. Zustand declares
`react >=18.0.0` as an **optional** peer, so npm had not installed it. Production
tree-shaking removed the unused React entrypoint; development prebundling still
needed to resolve it. This is a real dependency failure, not provider-login
rejection, a reason to replace Zustand, or proof that a successful build means
the actual browser has initialized.

The example now pins official stable **React 19.3.1**, which satisfies that peer,
using `npm install --ignore-scripts`. Only one package was added. No React DOM,
React Server Components package, SDK upgrade/downgrade, alias or override was
introduced. Official metadata was checked before installation:
[CDP core 0.0.127](https://registry.npmjs.org/@coinbase%2fcdp-core/0.0.127),
[Zustand 5.0.15](https://registry.npmjs.org/zustand/5.0.15),
[React 19.3.1](https://registry.npmjs.org/react/19.3.1).
The current full and production audit report **no React finding** and retain the
original five moderate package entries below. This is an observed audit result,
not a guarantee against undiscovered vulnerabilities.

New regression tests compare the manifest, lockfile and React version resolved
from the real installed Zustand package, import Zustand's actual root module,
and run Vite's real development dependency optimizer for CDP core and Zustand
with a fresh temporary cache and `envDir:false`. No browser, email code,
authentication, delegation, payment or running operator server is involved.
Operator browser initialization and actual provider acceptance remain separate.

## Fixed development-tool finding

The full audit (including dev dependencies) also exposed **one high Vite package
entry** with two advisories. Vite was updated from 8.0.13 to the smallest patched
8.0 release, **8.0.16**, with unchanged supported Node engine range. No major
override was used. [Official release](https://github.com/vitejs/vite/releases/tag/v8.0.16).

- [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff), high:
  alternate Windows paths bypass development-server file deny rules and can
  expose denied files to a requester. This is a development-server issue, not
  bundled production browser code.
- [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3), moderate:
  Windows editor middleware can open an attacker UNC path and expose NTLMv2
  authentication material. Requires Windows/NTLM and a reachable editor endpoint.

Both are patched for Vite 8.0.x in 8.0.16. The current review ran on macOS and did
not attempt Windows credential exfiltration. Keep `dev` explicitly bound to
127.0.0.1; loopback binding alone is not a substitute for updating the middleware.

## Inventory and decision

The installed chain is:

```text
@coinbase/cdp-core 0.0.127
└─ @solana/web3.js 1.99.0
   └─ jayson 4.3.0
      ├─ stream-json 1.9.1
      └─ uuid 8.3.2
```

`npm audit` reports five moderate **packages**: the three parents above inherit
the leaf risks; `stream-json` has three advisory IDs and `uuid` has one. This is
not five independent exploitable flaws in the email flow. Full and production-
only audits must still report the unresolved inventory without an allowlist.

Registry checks found the latest official CDP core at 0.0.127 and Solana web3.js
at 1.99.0. They still request `@solana/web3.js ^1.98.4` and `jayson ^4.3.0`.
The latest Jayson 4.x is 4.3.0; it requests `stream-json ^1.9.1` and `uuid ^8.3.2`.
No patched releases exist in those two allowed leaf major ranges at review time.

Jayson 5.0.0 removes those two dependencies, but is outside Solana's declared
range. `stream-json 3.6.0` and `uuid 11.1.1` are also outside Jayson's ranges.
Do not force those majors underneath an unmodified upstream consumer. Audit's
suggested CDP downgrade to 0.0.36 does not preserve this delegated-signing API.
Wait for a supported upstream chain, or separately review a supported SDK
migration; passing the current build would not prove cross-major compatibility.
Official package metadata can be rechecked through the public npm registry:
[CDP core](https://registry.npmjs.org/@coinbase%2fcdp-core/latest),
[Solana web3.js](https://registry.npmjs.org/@solana%2fweb3.js/latest),
[Jayson 4.3.0](https://registry.npmjs.org/jayson/4.3.0),
[Jayson 5.0.0](https://registry.npmjs.org/jayson/5.0.0).

## Findings and actual trigger conditions

All four entries below retain the registry's moderate severity. Their installed
locations are the `node_modules/stream-json` and `node_modules/uuid` entries in
this example's lockfile, reached through the chain above.

| ID | Advisory / trigger | Current example path and mitigation |
| --- | --- | --- |
| DEP-01 | [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x): deeply nested input passed through string/RegExp path filters can consume quadratic CPU; upstream fix 3.5.0. | No `stream-json` module is in the checked production browser graph. Do not introduce streaming JSON filters for untrusted input. |
| DEP-02 | [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x): chunked long comments through JSONC parser/verifier cause repeated scanning; upstream fix 3.6.0. | The installed 1.9.1 tree has no JSONC entrypoint; none is bundled. Audit's broad package range still flags it. Do not add JSONC parsing of untrusted input. |
| DEP-03 | [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc): streaming Assembler assignment of `__proto__` can replace a parsed object's prototype; upstream fix 3.6.0. | Jayson Node `lib/utils.js` uses streaming values, but that Node path and `stream-json` are absent from the production browser graph. Never reuse this inventory as a server-side untrusted streaming parser. |
| DEP-04 | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq): UUID v3/v5/v6 API calls with caller-provided undersized buffers/out-of-range offsets can silently partially write; patched uuid 11.1.1 and other maintained branches. | UUID **is present**, including v3/v5 implementations, in the current browser bundle. Installed Jayson browser/generateRequest call only v4 with no arguments/output buffer; that path does not match this advisory's trigger. This is a call-path assessment, not removal or a patched package. |

Evidence: `@solana/web3.js/lib/index.browser.esm.js` imports
`jayson/lib/client/browser`; that client uses native `JSON.parse` for responses.
Both `jayson/lib/client/browser/index.js` and `jayson/lib/generateRequest.js`
select `require('uuid').v4` and call it without arguments. The SDK includes Solana
support even though this example exposes only email/EVM-account/delegation
operations. Lack of a Solana button alone is **not** evidence of tree-shaking.

The new `test/dependency-boundaries.test.mjs` inspects a real Vite production
graph in memory, fails if the streaming parser/Node parser enters that graph,
checks the installed Jayson call sites, and exercises browser response parsing
and ID generation without a network call. UUID presence is asserted explicitly.
It does not statically prove every possible SDK call path or repair the remaining
advisory dependencies. A separate fresh dev-optimizer regression now verifies
the previously failing CDP/Zustand/React resolution. Review again on import,
bundler, SDK, deployment-surface or enrollment changes. No audit waiver or
production/funded-wallet acceptance is granted by these tests.

## Repeatable checks and upstream exit gate

```sh
npm ci --ignore-scripts
npm run build
npm audit --omit=dev
npm audit
npm ls @coinbase/cdp-core @solana/web3.js jayson stream-json uuid
npm ls @coinbase/cdp-core zustand react react-dom
npm view zustand@5.0.15 peerDependencies peerDependenciesMeta --json
npm view react@19.3.1 version dist.integrity --json
npm view @coinbase/cdp-core version dependencies --json
npm view @solana/web3.js version dependencies --json
npm view jayson@4 version --json
```

Expected review baseline: tests/typecheck/build pass; both audits exit nonzero
with five moderate package entries and no high/critical findings. Do not turn
audit failures into success with `|| true` in a release gate. Node versions and
audit databases can change; capture fresh output before any release decision.

Upgrade only after upstream declares compatible fixed dependencies, then rerun
the lockfile audit, actual bundle-path tests, SDK import/typecheck/controller
tests and independent provider acceptance. Until then keep this as development
source; do not describe the unresolved tree as production-authentication safe.
