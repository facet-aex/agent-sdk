# FACET CLI & SDK (`@facet-aex/cli`)

[![FACET](https://img.shields.io/badge/FACET-facet.briandev.space-050505?style=flat-square&labelColor=DFFF4F)](https://facet.briandev.space)
[![Layer](https://img.shields.io/badge/CLI%20%26%20SDK-BUYER%20TOOLKIT-0D0D0D?style=flat-square&labelColor=343434)](https://github.com/facet-aex)

> Public buyer CLI (`facet`) and TypeScript SDK for local Avalanche wallet custody, default-deny spend policies, spend history, and MCP installation.

## Overview

`agent-sdk` (published to npm as `@facet-aex/cli`) is the client toolkit for **FACET** consumers and AI agent operators. It provisions a local payer wallet, enforces human-approved spending boundaries, tracks local settlement invoices, and configures MCP integrations without exposing private keys to AI models.

## Role in FACET

- **Local Wallet Custody:** Generates and inspects local Avalanche buyer wallets stored in the operating system credential store rather than plaintext environment variables.
- **Default-Deny Spend Policies:** Grants, inspects, revokes, and prunes per-run and daily `fUSD` spending limits pinned to exact `provider`, `facetName`, SemVer `version`, and verified `providerPayTo` targets.
- **Spend Ledger & Discovery:** Searches and inspects published `API`, `ACTOR`, and `AGENT` Facets and queries local settlement history with Snowtrace transaction references.
- **MCP Client Setup:** Installs and configures `@facet-aex/mcp-server` for Codex, Claude Code, Antigravity, and standard MCP hosts.

## Tech Stack

| Layer | Technology |
|---|---|
| Language & Runtime | TypeScript, Node.js (`>=22.0.0`, ESM) |
| Web3 & Custody | `viem`, OS credential store |
| Distribution | Public npm (`@facet-aex/cli`, OIDC Trusted Publishing) |
| Testing | Vitest |

---

Part of **[FACET](https://facet.briandev.space)** (`facet-aex`) — Federated Agent Capability Exchange & Trust on Avalanche · [Documentation](https://facet.briandev.space/docs)
