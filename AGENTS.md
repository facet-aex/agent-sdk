# `agent-sdk` instructions (`@facet-aex/cli`)

**Owner in Goal B:** Antigravity  
**Active architectural authority:** `../docs/architecture/decisions/ADR-0017-provider-owned-actor-and-local-agent-purchase.md`

## Role

Installable buyer CLI (`facet`) and TypeScript wallet/policy/SDK package (`@facet-aex/cli`) for:
- Local Fuji buyer wallet custody (`facet wallet create|import|status`, macOS Keychain via `security -i`, never leaking keys in `argv`, `env`, stdout, stderr, or MCP config);
- Bounded operator spend policies and cross-process spend reservations;
- Client MCP configuration (`codex`, `claude`, `antigravity`);
- Programmatic interaction with `https://facet.briandev.space` catalog and publishing endpoints.
