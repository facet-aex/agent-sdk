# `@facet-aex/cli`

Installable buyer CLI and TypeScript library for FACET on Avalanche Fuji (`chainId: 43113`, `fUSD` `0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f`).

## Supported Runtime

- **Node.js:** `>=22.0.0` (verified on Node `v24.12.0` and `v26.13.1`; `viem@2.57.17` and its transitive dependencies impose no `<25` upper limit).
- **Credential store (first demo):** macOS Keychain via `/usr/bin/security` (`security -i` stdin write so private keys never appear in `argv`, `env`, or plaintext config files).

## Buyer Wallet Commands

Normal usage requires **no environment variables** (defaults to profile `"default"`):

```bash
facet wallet create   # generates a dedicated Fuji EOA and stores its key in macOS Keychain
facet wallet import   # imports a 0x-prefixed private key via hidden interactive prompt
facet wallet status   # checks Fuji chain ID (43113) and prints address + fUSD balance
```

`FacetUSD` (`fUSD`) on Fuji is owner-minted; fund your buyer address via an explicit operator transfer rather than an automated public faucet.

## Spending Policy Commands (UTC Day Boundary)

Only `--facet` is required (`--version` defaults to the latest published version, `--max-per-run` to `1000`, `--daily-cap` to `10000`, and `--expires` to 1 month UTC from grant time):

```bash
facet policy grant --facet <username/facet-name|facetId>
facet policy show
facet policy revoke --facet <username/facet-name|facetId>
```

Policies bind to the local wallet profile (`~/.config/facet/policies.json` + `~/.config/facet/spend-ledger.json` for `"default"`), so all local MCP clients (`codex`, `claude`, `antigravity`) share the same enforced caps and cross-process reservation lock. Pass `--profile <name>` (stored under `~/.config/facet/profiles/<name>/`) when you want isolated wallets/caps per agent.

## MCP Client Integration

```bash
facet mcp install codex         # updates ~/.codex/config.toml (preserving existing servers)
facet mcp install claude        # configures Claude Code user scope (via CLI or ~/.claude.json)
facet mcp install antigravity   # updates ~/.gemini/antigravity/mcp_config.json
facet mcp config codex          # prints a pasteable snippet without writing files
```

Pass `--profile <name>` if you want a client isolated to a specific wallet/policy profile (`FACET_PROFILE`). No private keys or local `dist/` paths are ever written into MCP config.

## Verification

```bash
npm ci
npm run verify
```
