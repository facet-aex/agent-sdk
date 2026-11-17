# `@facet-aex/cli`

Installable buyer CLI and TypeScript library for FACET on Avalanche Fuji (`chainId: 43113`, `fUSD` `0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f`).

## Supported Runtime

- **Node.js:** `>=22.0.0` (verified on Node `v24.12.0` and `v26.13.1`; `viem@2.57.17` and its transitive dependencies impose no `<25` upper limit).
- **Credential store (first demo):** macOS Keychain via `/usr/bin/security` (`security -i` stdin write so private keys never appear in `argv`, `env`, or plaintext config files).

## Buyer Wallet Commands

```bash
facet wallet create   # generates a dedicated Fuji EOA and stores its key in macOS Keychain
facet wallet import   # imports a 0x-prefixed private key via hidden interactive prompt
facet wallet status   # checks Fuji chain ID (43113) and prints address + fUSD balance
```

`FacetUSD` (`fUSD`) on Fuji is owner-minted; fund your buyer address via an explicit operator transfer rather than an automated public faucet.

## Verification

```bash
npm ci
npm run verify
```
