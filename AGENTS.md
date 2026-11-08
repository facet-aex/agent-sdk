# agent-sdk instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Use npm only and commit this repository's own `package-lock.json` when application code begins.
- Do not add application code until Phase 3 is explicitly started.
- Never expose raw wallet private keys.
- Preserve adapter boundaries for identity, signer and policy enforcement.
- Re-verify Fuji/ERC-8004 facts before implementation.
