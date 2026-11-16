# agent-sdk

Active Phase 1 TypeScript SDK and CLI for operator-managed agent identities, Fuji wallets, spending policies, Facet discovery and paid invocation.

**Status:** repository initialized; implementation is the next MVP slice under root ADR-0014. No CLI or wallet provisioning is implemented yet.
FACET is not an agent runtime, and this repository must not force migration to one.

This repository remains standalone and consumes versioned FACET APIs/contracts. The initial CLI is for a supervised local Fuji MVP. It must never reveal signing keys to an agent or print them to the terminal.
