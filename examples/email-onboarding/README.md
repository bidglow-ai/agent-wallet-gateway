# Email wallet onboarding example

Standalone Vite + vanilla TypeScript example using official `@coinbase/cdp-core`
**0.0.127**. This is development onboarding source, not an enrolled payment client
or an accepted native wallet integration. No real provider authentication,
delegation, signing or token transfer was run to verify this example.

The SDK's installed Zustand 5.x root export also imports its React entrypoint.
Although Zustand marks React as an optional peer, Vite's development optimizer
requires that real peer to resolve. The example explicitly pins **React 19.3.1**
from the official npm registry, compatible with Zustand's `react >=18.0.0` peer.
There is no React UI, React DOM renderer, SDK replacement, alias or override.
A production build alone previously tree-shook away the missing peer and did not
catch this development startup failure.

Local verification covers TypeScript SDK imports, mocked controller/UI-boundary
tests, installed-peer resolution, a fresh real Vite development prebundle,
dependency-path regression tests and the Vite production build. Dependency tests
use an isolated temporary optimizer cache and do not load operator environment
files, authenticate with Coinbase or call a wallet operation. The dependency audit
still reports five moderate package entries in the pinned SDK's transitive
Solana/web3.js → jayson → stream-json/uuid tree. No compatible upstream fix was
available at the 2026-10-15 review; no forced override or SDK downgrade was applied.
See [dependency security review](SECURITY_DEPENDENCIES.md) for exact advisories,
runtime reachability, upstream blockers and repeatable checks. Build success does
not resolve those advisories or certify production authentication/funded wallets.

## Run locally

```sh
cd examples/email-onboarding
npm ci --ignore-scripts
npm run build
```

To try actual provider onboarding later, use a **separate, empty development CDP
project**. Confirm its configuration, free-tier headroom and required provider
terms before requesting email codes or creating accounts/delegations. Allowlist
only this example's exact loopback origin on that development project. Never add
localhost to an existing production project. Enable Delegated Signing only on
the development project after reviewing its signing policies.

Copy `.env.example` to `.env.local`. Set the public development project UUID and
`VITE_DEVELOPMENT_PROJECT_CONFIRMED=true`, then run `npm run dev` and open exactly
`http://localhost:4376`. Add that exact origin to the development project's domain
allowlist: Coinbase rejects IP-address domains such as `127.0.0.1`. Vite still
listens only on `127.0.0.1` and refuses an occupied port rather than silently
changing the allowlisted origin. The frontend guard also permits the explicit
`http://127.0.0.1:4376` loopback form for isolated fixtures, but it is not an alias
for the configured origin: use only the one exact frontend origin allowlisted by
both Coinbase and your backend. No other hostname, IP, IPv6, HTTPS or portless
frontend is accepted.
The flag is the
operator's assertion, not a verified provider environment boundary. By default,
the project ID is blank and SDK initialization is blocked. There are no account
credentials, wallet addresses or email addresses in the sample configuration.
Never add CDP API keys or Wallet Secrets to Vite variables: they are browser code.

The page is loopback-only and labels itself **Testnet only; funding not accepted**.
Email/OTP pass directly to the official SDK. The application does not log them,
write them to browser storage, put them in URLs, or submit them to an application
backend. The provider SDK has its own session-storage behavior; do not equate
this example with an ephemeral or storage-free provider session.

Sign-in may create an EVM EOA in the development project. It never grants
delegation automatically. After authentication, the user separately selects an
account, checks explicit consent and clicks the delegation button for 1, 4 or
24 hours. The page also reads delegation status and revokes the selected
account's delegation. With no enrollment backend configured, provider-only
revocation remains available and does not claim to stop any existing broker
mandate. With a backend configured, that shortcut is disabled: the combined
stop must go through the backend's durable local stop before provider revocation.
Signing out does not revoke either mandate or delegation. Previously issued payment
signatures may survive revocation until their own expiration.

Account-scoped delegation is **not** a network/token/recipient/budget cap. It
authorizes the development project to sign for that account. Actual testnet-only
signer policies and independently enforced budgets are separate prerequisites;
no payment, transfer, key export or generic signing interface is provided here.
The same email in AWAL or another SDK project may have a different wallet. Always
verify the exact project, end-user account and public address before any later
testnet acceptance. Do not send mainnet funds to this example.

## Separate local backend enrollment contract

Leave `VITE_ENROLLMENT_ORIGIN` blank to keep enrollment blocked while retaining
the independent SDK onboarding example. To connect a separately started trusted
development service, set this **public configuration** to its exact
`http://127.0.0.1:4377` origin (or its separately configured explicit port).
No path, query, credential, localhost alias,
redirect or arbitrary remote endpoint is accepted. Review this endpoint before
signing in: it receives your official Coinbase session token. Plain loopback is
a trusted local-machine boundary, not protection from compromised local software.

The backend must allowlist exactly `http://localhost:4376`, validate Host/Origin,
require JSON and validate the official access token with its own protected CDP
project credentials. No wildcard CORS, browser cookies, client-supplied subject
or email identity proof is used. The frontend uses documented `getAccessToken()`
only for each explicit enrollment request. Its token lives in a request-local
variable and the Authorization header, never application storage, logs, URL or
request body. There are no automatic POST retries.

The page implements these calls only:

| Endpoint | Body | Human action / result |
| --- | --- | --- |
| `POST /enrollment/v1/proposal` | `{wallet}` | Load a frozen mandate after provider delegation. Display merchant, payer/payee, Base Sepolia official test USDC, 5 test USDC per call, 10 test USDC total, exact expiry and whether the original mandate already exists. This does not activate it. |
| `POST /enrollment/v1/confirm` | `{wallet,nonce,approved:true}` | A separate checkbox/button approves exactly the displayed grant and one-use, short-lived nonce. Require an identical confirmed grant before exposing a scoped agent connection. This authorizes the limits once, not a fresh prompt for every purchase. |
| `POST /enrollment/v1/revoke` | `{wallet,approved:true}` | A separate explicit stop first revokes the local mandate durably, then provider delegation. Session authentication must still work when delegation has expired. |
| `POST /enrollment/v1/recover` | `{wallet,approved:true}` | Separate recovery consent obtains only an inspect/reconcile capability for the existing account/grant, even after expiry/revocation. The response must explicitly say `recoveryOnly:true`; never renew or mark this as confirmed payment authority. |

Grant/response fields, testnet flags and exact limits are checked in
`src/enrollment.ts`; the server remains responsible for authentication,
policy/order scope, durable enrollment and idempotent budgeting. The browser
cannot submit a grant ID, subject, cap, merchant, arbitrary order or signature.
Re-enrollment must preserve the existing grant and spent/reserved budget, not
mint new spending authority. Root backend modules are separately reviewed and
are not implemented in this browser folder. A public HTTPS enrollment service
is not provided by this local example. This UI accepts only the exact 5-per-call /
10-total test USDC profile; a server configured with lower caps safely fails
closed until its separate UI/profile review, rather than displaying wrong limits.

After confirmation, the restricted `brokerOrigin/clientToken` capability is
displayed/copied **only in memory** as `AGENT_BROKER_ORIGIN/AGENT_BROKER_TOKEN`.
It is not a CDP developer credential and does not permit generic signing. Do not
log, commit or publish it. Account/user changes, sign-out attempts and combined
stop attempts discard the page's references; expiry hides the connection.
Copying is an explicit disclosure to your OS clipboard/history. Closing or
signing out clears the page, **not** the backend mandate: use combined stop first.

The recovery-only action does not require active provider delegation. It validates
the same account, subject, merchant/payee, testnet token and caps but accepts a
historical positive expiry without extending it. The page shows a persistent
recovery-only warning next to the copied connection. The backend must enforce
`allowPayment:false` and refuse signing/settlement; this UI label is not the
security control. Recovery can verify existing outcomes and record matching
Stripe sandbox evidence, but cannot transfer test USDC again.

Lost confirm/revoke responses stay unconfirmed and expose no connection. A local
stop may already have committed even if provider revocation failed; an error
never claims successful provider revocation. A fresh proposal may recover an
existing mandate only through the backend's durable registry. Never retry a
payment or reset its order/budget because an enrollment request was interrupted.

Mocked frontend contract tests and SDK typechecks are not actual email-provider,
native-client, payment, mainnet, merchant ranking or recovery acceptance. This
page has no payment button or automatic transfer call. Keep funding blocked
until the separately documented independent acceptance gates are met. The
dependency advisories above also remain unresolved upstream.

Official references:

- [Core SDK package](https://www.npmjs.com/package/@coinbase/cdp-core)
- [Delegated signing](https://docs.cdp.coinbase.com/wallets/using-wallets/delegated-signing)
- [Wallet authentication](https://docs.cdp.coinbase.com/wallets/authentication/implementation-guide)
- [Local development domains](https://docs.cdp.coinbase.com/wallets/quickstart/user-auth)
- [Policy engine](https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/overview)
