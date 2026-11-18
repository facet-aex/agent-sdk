import { DEFAULT_FACET_ORIGIN } from "./fuji-wallet.js";
import { resolveProfileName } from "./wallet-store.js";

export type McpClientName = "codex" | "claude" | "antigravity";

export const MCP_CLIENT_NAMES: readonly McpClientName[] = [
  "codex",
  "claude",
  "antigravity",
];

export const PINNED_MCP_PACKAGE_NAME = "@facet-aex/mcp-server" as const;
export const PINNED_MCP_PACKAGE_VERSION = "0.2.0" as const;

export interface FacetMcpServerSpec {
  name: "facet";
  command: "npx";
  args: ["-y", string];
  env: {
    FACET_CONTROL_API_URL: string;
    FACET_GATEWAY_URL: string;
    FACET_PROFILE?: string;
  };
}

export interface BuildMcpSpecOptions {
  origin?: string;
  profile?: string;
  mcpVersion?: string;
}

export function isMcpClientName(value: string): value is McpClientName {
  return (MCP_CLIENT_NAMES as readonly string[]).includes(value);
}

export function buildFacetMcpSpec(
  options: BuildMcpSpecOptions = {},
): FacetMcpServerSpec {
  const origin = new URL(options.origin ?? DEFAULT_FACET_ORIGIN).origin;
  const profile = resolveProfileName(options.profile);
  const version = (options.mcpVersion ?? PINNED_MCP_PACKAGE_VERSION).trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) {
    throw new Error(`Invalid pinned MCP version: ${version}`);
  }

  return {
    name: "facet",
    command: "npx",
    args: ["-y", `${PINNED_MCP_PACKAGE_NAME}@${version}`],
    env: {
      FACET_CONTROL_API_URL: origin,
      FACET_GATEWAY_URL: origin,
      ...(profile !== "default" ? { FACET_PROFILE: profile } : {}),
    },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderCodexTomlSection(spec: FacetMcpServerSpec): string {
  const lines = [
    "[mcp_servers.facet]",
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
    "",
    "[mcp_servers.facet.env]",
    `FACET_CONTROL_API_URL = ${tomlString(spec.env.FACET_CONTROL_API_URL)}`,
    `FACET_GATEWAY_URL = ${tomlString(spec.env.FACET_GATEWAY_URL)}`,
  ];
  if (spec.env.FACET_PROFILE) {
    lines.push(`FACET_PROFILE = ${tomlString(spec.env.FACET_PROFILE)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMcpConfigSnippet(
  client: McpClientName,
  options: BuildMcpSpecOptions = {},
): string {
  const spec = buildFacetMcpSpec(options);
  const envPairs = Object.entries(spec.env);

  if (client === "codex") {
    const cliArgs = [
      "codex mcp add facet",
      ...envPairs.map(([k, v]) => `--env ${k}=${v}`),
      `-- ${spec.command} ${spec.args.join(" ")}`,
    ].join(" ");
    return [
      "# Run with Codex CLI:",
      cliArgs,
      "",
      "# Or add to ~/.codex/config.toml:",
      renderCodexTomlSection(spec).trimEnd(),
    ].join("\n");
  }

  if (client === "claude") {
    const cliArgs = [
      "claude mcp add --scope user facet",
      ...envPairs.map(([k, v]) => `-e ${k}=${v}`),
      `-- ${spec.command} ${spec.args.join(" ")}`,
    ].join(" ");
    const jsonSnippet = JSON.stringify(
      {
        mcpServers: {
          facet: {
            command: spec.command,
            args: spec.args,
            env: spec.env,
          },
        },
      },
      null,
      2,
    );
    return [
      "# Run with Claude Code CLI:",
      cliArgs,
      "",
      "# Or merge into ~/.claude.json:",
      jsonSnippet,
    ].join("\n");
  }

  return [
    "# Merge into ~/.gemini/antigravity/mcp_config.json:",
    JSON.stringify(
      {
        mcpServers: {
          facet: {
            command: spec.command,
            args: spec.args,
            env: spec.env,
          },
        },
      },
      null,
      2,
    ),
  ].join("\n");
}
