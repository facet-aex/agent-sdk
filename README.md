# `@facet-aex/cli`

Buyer CLI and TypeScript library for Avalanche local wallet custody, default-deny spending policies, local spend history invoices, and MCP client configuration.

All CLI commands emit human-readable output by default. Pass `--json` to any command when structured JSON is needed for scripting.

## Quickstart

```bash
# 1) Create a protected Avalanche wallet (stored in OS credential store, never plaintext)
facet wallet create
facet wallet status

# 2) Discover and inspect Facets
facet search --type ACTOR
facet inspect tai-hung-dev/vn-gold-fx-actor

# 3) Grant policy (uses Option B natural keys + strict SemVer, defaults: latest version, 1000 max-per-run, 10000 daily-cap, +1 UTC month)
facet policy grant --facet tai-hung-dev/vn-gold-fx-actor
# Or with explicit separated fields & pinned SemVer:
facet policy grant --provider tai-hung-dev --facet vn-gold-fx-actor --version 1.0.0

# 4) Inspect or prune policies
facet policy show
facet policy revoke --facet tai-hung-dev/vn-gold-fx-actor
facet policy prune

# 5) Inspect local spend history & Snowtrace invoice links
facet spend history
facet spend history --status SETTLED --json

# 6) Configure local MCP stdio adapter for Codex, Claude Code, or Antigravity
facet mcp install codex|claude|antigravity
```

## Notes

- Output mode: human-readable text by default across all commands; add `--json` anywhere for JSON output.
- Canonical capability types: `API`, `ACTOR`, `AGENT`.
- Identifiers: `provider` (`users.username`, `8–16` lowercase hyphenated kebab-case), `facetName` (`4–32` lowercase hyphenated kebab-case), `facetDisplayName`, and SemVer `version` (`MAJOR.MINOR.PATCH`).
- Runtime support: Node.js `>=22.0.0`.
