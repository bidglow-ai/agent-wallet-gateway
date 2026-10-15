# Connect the same read-only wallet to compatible clients

Replace `/ABSOLUTE/GATEWAY` and `/ABSOLUTE/AWAL/dist/index.js` with local reviewed
paths. The latter must resolve to `awal` 2.12.2. Paths are not passwords. Do not put
provider credentials, seeds or OTPs in these configurations. No `--trust`, approval
bypass, public port or copied private key is required.

These are configuration instructions, **not native-client payment acceptance**.
Use the same OS login, official wallet session and provider path in every client.

## Codex CLI

```sh
codex mcp add bidglow-wallet --env AGENT_WALLET_AWAL=/ABSOLUTE/AWAL/dist/index.js -- node /ABSOLUTE/GATEWAY/src/server.mjs
```

Restart the client. Approve only the intended read tools if it requests permission.

## Claude Code

```sh
claude mcp add --scope user --transport stdio bidglow-wallet --env AGENT_WALLET_AWAL=/ABSOLUTE/AWAL/dist/index.js -- node /ABSOLUTE/GATEWAY/src/server.mjs
```

Use `/mcp` to inspect the connection. Do not enable broad auto-approval.

## Gemini CLI

```sh
gemini mcp add --scope user --transport stdio --env AGENT_WALLET_AWAL=/ABSOLUTE/AWAL/dist/index.js bidglow-wallet node /ABSOLUTE/GATEWAY/src/server.mjs
```

Do not use `--trust`. A client login may be required separately; wallet setup
does not provide paid model access or solve account eligibility.

## Claude Desktop, Cursor and Cline

Merge the following **single server entry** into the client's documented MCP
settings. Never overwrite its other entries. Exact settings location and app
availability depend on the installed client/version.

```json
{
  "mcpServers": {
    "bidglow-wallet": {
      "command": "node",
      "args": ["/ABSOLUTE/GATEWAY/src/server.mjs"],
      "env": {"AGENT_WALLET_AWAL": "/ABSOLUTE/AWAL/dist/index.js"}
    }
  }
}
```

Use an absolute Node executable path if a desktop app cannot locate `node`.
Hosted ChatGPT/Grok/Gemini/Claude websites are not interchangeable with local
MCP clients. Do not tunnel this local bridge publicly to try to make them work.

## Read-only acceptance sequence

1. `wallet_status`: see running/authenticated state, payments disabled.
2. Owner completes official wallet login if desired; no funding is needed.
3. `wallet_address` from each actual client: compare the same public Base address.
4. `wallet_balance`: compare the same Base USDC atomic balance.
5. Confirm that `wallet_pay` and arbitrary send/sign/trade tools are absent.

Until every step is recorded for a client, label it configured/protocol-compatible,
not native end-to-end accepted. Remove the named server to disconnect that client;
removing this entry does not revoke permissions granted to other wallet software.
