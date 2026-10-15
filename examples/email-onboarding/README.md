# Email wallet onboarding example

Standalone Vite + vanilla TypeScript example using official `@coinbase/cdp-core`
**0.0.127**. This is development onboarding source, not an enrolled payment client
or an accepted native wallet integration. No real provider authentication,
delegation, signing or token transfer was run to verify this example.

Local verification: TypeScript SDK imports, ten mocked controller/UI-boundary
tests and the Vite build pass. The dependency audit reports five moderate
entries in the pinned SDK's transitive Solana/web3.js → jayson → stream-json/uuid
tree. No forced fix, unsupported override or downgrade was applied. Build success
does not resolve those advisories or certify this dependency tree as safe for
production authentication or funded wallets.

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
`VITE_DEVELOPMENT_PROJECT_CONFIRMED=true`, then run `npm run dev`. The flag is the
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
account's delegation. Signing out does not revoke it. Previously issued payment
signatures may survive revocation until their own expiration.

Account-scoped delegation is **not** a network/token/recipient/budget cap. It
authorizes the development project to sign for that account. Actual testnet-only
signer policies and independently enforced budgets are separate prerequisites;
no payment, transfer, key export or generic signing interface is provided here.
The same email in AWAL or another SDK project may have a different wallet. Always
verify the exact project, end-user account and public address before any later
testnet acceptance. Do not send mainnet funds to this example.

## Required backend enrollment (not implemented)

The displayed browser account is not evidence that a caller may enroll it into
a payment broker. Before adding enrollment:

1. Create an authenticated, CSRF-protected HTTPS enrollment endpoint. Use a
   provider-supported end-user session/access-token verification flow and bind
   its validated subject, issuer, intended project/audience and expiry. Never
   accept a client-supplied email, user UUID or address as identity proof; never
   send an email OTP to the application backend.
2. With the broker's protected server credentials, independently retrieve that
   subject's accounts from the same development CDP project. Require the selected
   EOA to belong to the verified end user. Query its account-scoped delegation
   from CDP and confirm scope/account/expiry (no more than 24 hours). A browser's
   cached state or success toast is insufficient. The frontend create method in
   SDK 0.0.127 returns `expiresAt`, not a delegation ID to use as proof.
3. Independently verify the actual attached project policy and negative signing
   tests. Keep developer API credentials and Wallet Secret in a distinct trusted
   broker; agents receive no CDP credential or policy-management authority.
4. Record a separately explicit bounded user mandate: exact payer, merchant,
   network/token/payee, permitted listing scope, per-payment/day/total caps,
   expiry and revocation. Atomically reserve against the shared durable budget
   before signing. Native delegation alone implements none of these money limits.
5. Bind the EIP-3009 nonce to the canonical immutable merchant order, independently
   verify settlement + Stripe evidence and issue one durable fulfillment receipt.
   Implement unknown-outcome reconciliation and isolated recovery before payments.

This folder implements none of that backend. Do not wire its browser state into
payment signing or mark funding, unattended payments, merchant ranking or
recovery accepted merely because this example compiles or its mocked tests pass.

Official references:

- [Core SDK package](https://www.npmjs.com/package/@coinbase/cdp-core)
- [Delegated signing](https://docs.cdp.coinbase.com/wallets/using-wallets/delegated-signing)
- [Wallet authentication](https://docs.cdp.coinbase.com/wallets/authentication/implementation-guide)
- [Policy engine](https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/overview)
