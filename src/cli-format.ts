import { formatFusdAtomic, type FujiWalletStatus } from "./fuji-wallet.js";
import type { InstallMcpResult } from "./mcp-install.js";
import { parseNonNegativeAtomic, snowtraceTxUrl } from "./spend-ledger.js";
import type { PublicFacetRecord, SpendPolicyGrant } from "./spend-policy.js";
import type { WalletCreateResult, WalletImportResult } from "./wallet-store.js";

function formatAtomicWithSymbol(atomic: string): string {
  try {
    const parsed = parseNonNegativeAtomic(atomic);
    return `${formatFusdAtomic(parsed)} fUSD (${atomic} atomic)`;
  } catch {
    return `${atomic} atomic`;
  }
}

export function formatWalletCreateText(
  profile: string,
  result: WalletCreateResult,
): string {
  return [
    `FACET Wallet Created (profile: ${profile})`,
    `  Address : ${result.address}`,
    `  Network : Avalanche Fuji (${result.chainId} / ${result.network})`,
    `  Storage : Protected OS credential store (private key never displayed)`,
    `  Next    : Fund with Fuji AVAX + fUSD, then run \`facet wallet status\``,
  ].join("\n");
}

export function formatWalletImportText(
  profile: string,
  result: WalletImportResult,
): string {
  return [
    `FACET Wallet Imported (profile: ${profile})`,
    `  Address : ${result.address}`,
    `  Network : Avalanche Fuji (${result.chainId} / ${result.network})`,
    `  Storage : Protected OS credential store`,
  ].join("\n");
}

export function formatWalletStatusText(
  profile: string,
  status: FujiWalletStatus,
): string {
  return [
    `FACET Wallet Status (profile: ${profile})`,
    `  Address : ${status.address}`,
    `  Network : Avalanche Fuji (${status.chainId} / ${status.network})`,
    `  Balance : ${status.balanceFormatted} ${status.symbol} (${status.balanceAtomic} atomic)`,
    `  Asset   : ${status.assetAddress}`,
    `  Note    : ${status.fundingNote}`,
  ].join("\n");
}

export function formatFacetSearchText(facets: PublicFacetRecord[]): string {
  if (facets.length === 0) {
    return "No Facets found.";
  }

  const lines: string[] = [`FACET Catalog (${facets.length} facet(s))`];
  facets.forEach((facet, index) => {
    lines.push(
      `\n${index + 1}. ${facet.provider}/${facet.facetName}@${facet.version}  [${facet.facetType}]`,
    );
    lines.push(`   Title   : ${facet.facetDisplayName}`);
    if (facet.description) {
      lines.push(`   Summary : ${facet.description}`);
    }
    if (facet.pricing) {
      lines.push(
        `   Pricing : ${formatAtomicWithSymbol(facet.pricing.priceAtomic)} (${facet.pricing.model})`,
      );
      lines.push(`   Pay To  : ${facet.pricing.payTo}`);
    } else {
      lines.push("   Pricing : free / unpriced");
    }
    if (facet.facetType === "ACTOR") {
      lines.push(
        `   Registry: ${facet.actorMeta?.registryVerified ? "verified on Fuji" : "unverified"}`,
      );
    } else if (facet.facetType === "AGENT") {
      lines.push(
        `   Registry: ${facet.agentMeta?.registryVerified ? "verified on Fuji" : "unverified"}${facet.agentMeta?.erc8004TokenId ? ` (ERC-8004 #${facet.agentMeta.erc8004TokenId})` : ""}`,
      );
    }
  });
  return lines.join("\n");
}

function formatSchemaSummaryLines(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [`  Input Schema : ${JSON.stringify(schema)}`];
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return ["  Input Schema : {} (no properties)"];
  }

  const lines = ["  Input Schema :"];
  for (const [key, rawDef] of entries) {
    const def =
      rawDef && typeof rawDef === "object"
        ? (rawDef as Record<string, unknown>)
        : {};
    const typeLabel =
      typeof def.type === "string" ? def.type : "any";
    const reqLabel = required.has(key) ? "required" : "optional";
    const defaultLabel =
      def.default !== undefined ? `, default=${JSON.stringify(def.default)}` : "";
    const descLabel =
      typeof def.description === "string" && def.description.trim()
        ? ` — ${def.description.trim()}`
        : "";
    lines.push(
      `    - ${key} (${typeLabel}, ${reqLabel}${defaultLabel})${descLabel}`,
    );
  }
  return lines;
}

export function formatFacetInspectText(facet: PublicFacetRecord): string {
  const lines: string[] = [
    `FACET Detail: ${facet.provider}/${facet.facetName}@${facet.version}`,
    `  Title      : ${facet.facetDisplayName}`,
    `  Type       : ${facet.facetType}`,
    `  Provider   : ${facet.provider}`,
    `  Facet Name : ${facet.facetName}`,
    `  Version    : ${facet.version}`,
  ];

  if (facet.category) {
    lines.push(`  Category   : ${facet.category}`);
  }
  if (facet.tags && facet.tags.length > 0) {
    lines.push(`  Tags       : ${facet.tags.join(", ")}`);
  }
  if (facet.description) {
    lines.push(`  Description: ${facet.description}`);
  }

  if (facet.pricing) {
    lines.push(
      `  Pricing    : ${formatAtomicWithSymbol(facet.pricing.priceAtomic)} | ${facet.pricing.model}`,
    );
    lines.push(`  Pay To     : ${facet.pricing.payTo}`);
    lines.push(
      `  Asset      : ${facet.pricing.assetAddress} (chainId ${facet.pricing.chainId})`,
    );
  }

  if (facet.actorMeta) {
    lines.push(`  Runtime    : ${facet.actorMeta.runtime}`);
    lines.push(`  Image      : ${facet.actorMeta.imageDigest}`);
    lines.push(
      `  Registry   : ${facet.actorMeta.registryVerified ? "verified" : "unverified"}${facet.actorMeta.registryTxHash ? ` (${snowtraceTxUrl(facet.actorMeta.registryTxHash)})` : ""}`,
    );
  }

  if (facet.agentMeta) {
    lines.push(
      `  ERC-8004   : token #${facet.agentMeta.erc8004TokenId} @ ${facet.agentMeta.erc8004Registry} (chain ${facet.agentMeta.erc8004ChainId})`,
    );
    lines.push(`  Task Kind  : ${facet.agentMeta.taskKind}`);
    lines.push(
      `  Registry   : ${facet.agentMeta.registryVerified ? "verified" : "unverified"}${facet.agentMeta.registryTxHash ? ` (${snowtraceTxUrl(facet.agentMeta.registryTxHash)})` : ""}`,
    );
  }

  if (facet.inputSchema) {
    lines.push(...formatSchemaSummaryLines(facet.inputSchema));
  }

  return lines.join("\n");
}

export function formatPolicyGrantText(
  profile: string,
  policy: SpendPolicyGrant,
): string {
  return [
    `FACET Policy Granted (profile: ${profile})`,
    `  Target     : ${policy.provider}/${policy.facetName}@${policy.version}  [${policy.facetType}] (${policy.facetDisplayName})`,
    `  Pricing    : ${formatAtomicWithSymbol(policy.pinnedPriceAtomic)} (${policy.pricingModel})`,
    `  Max / Run  : ${formatAtomicWithSymbol(policy.maxPerRunAtomic)}`,
    `  Daily Cap  : ${formatAtomicWithSymbol(policy.dailyCapAtomic)} (${policy.dayBoundary})`,
    `  Pay To     : ${policy.providerPayTo}`,
    `  Settlement : ${policy.settlementContract} (chainId ${policy.chainId})`,
    `  Expires At : ${policy.expiresAt}`,
    `  Registry Tx: ${snowtraceTxUrl(policy.registryTxHash)}`,
  ].join("\n");
}

function policyBadge(policy: SpendPolicyGrant, now: Date): string {
  if (policy.revokedAt) return "REVOKED";
  if (now.getTime() >= Date.parse(policy.expiresAt)) return "EXPIRED";
  return "ACTIVE";
}

export function formatPolicyShowText(
  result: { profile: string; dayBoundary: "UTC"; policies: SpendPolicyGrant[] },
  now: Date = new Date(),
): string {
  if (result.policies.length === 0) {
    return [
      `FACET Spending Policies (profile: ${result.profile}, dayBoundary: ${result.dayBoundary})`,
      "No policies granted yet. Run `facet policy grant --provider <provider> --facet <facet-name>` to authorize a Facet.",
    ].join("\n");
  }

  const lines = [
    `FACET Spending Policies (profile: ${result.profile}, ${result.policies.length} policy/policies, dayBoundary: ${result.dayBoundary})`,
  ];
  for (const policy of result.policies) {
    const badge = policyBadge(policy, now);
    lines.push(
      `- [${badge}] ${policy.provider}/${policy.facetName}@${policy.version}  [${policy.facetType}] (${policy.facetDisplayName})`,
    );
    lines.push(
      `  Price: ${formatAtomicWithSymbol(policy.pinnedPriceAtomic)} (${policy.pricingModel}) | Max/Run: ${policy.maxPerRunAtomic} | Daily Cap: ${policy.dailyCapAtomic}`,
    );
    lines.push(`  Pay To: ${policy.providerPayTo}`);
    lines.push(
      policy.revokedAt
        ? `  Revoked At: ${policy.revokedAt} | Expires: ${policy.expiresAt}`
        : `  Expires: ${policy.expiresAt}`,
    );
  }
  return lines.join("\n");
}

export function formatPolicyRevokeText(
  profile: string,
  result: { revoked: boolean; count: number },
): string {
  return `Revoked ${result.count} policy/policies in profile '${profile}'.`;
}

export function formatPolicyPruneText(
  profile: string,
  result: { pruned: number },
): string {
  return `Pruned ${result.pruned} policy/policies from profile '${profile}'.`;
}

export function formatMcpInstallText(result: InstallMcpResult): string {
  const lines = [
    `FACET MCP Installed (${result.client})`,
    `  Method  : ${result.method}`,
    ...(result.configPath ? [`  Config  : ${result.configPath}`] : []),
    ...(result.backupPath ? [`  Backup  : ${result.backupPath}`] : []),
    `  Command : ${result.spec.command} ${result.spec.args.join(" ")}`,
    `  Origin  : ${result.spec.env.FACET_CONTROL_API_URL}`,
  ];
  if (result.spec.env.FACET_PROFILE) {
    lines.push(`  Profile : ${result.spec.env.FACET_PROFILE}`);
  }
  return lines.join("\n");
}

export function formatPublishActorText(facet: unknown): string {
  if (!facet || typeof facet !== "object" || Array.isArray(facet)) {
    return `Actor submission response: ${String(facet)}`;
  }
  const rec = facet as Record<string, unknown>;
  const provider = typeof rec.provider === "string" ? rec.provider : "?";
  const facetName = typeof rec.facetName === "string" ? rec.facetName : "?";
  const version = typeof rec.version === "string" ? rec.version : "?";
  const lines = [`FACET Actor Submitted: ${provider}/${facetName}@${version}`];
  if (typeof rec.facetDisplayName === "string") {
    lines.push(`  Title  : ${rec.facetDisplayName}`);
  }
  if (typeof rec.facetType === "string") {
    lines.push(`  Type   : ${rec.facetType}`);
  }
  if (typeof rec.status === "string") {
    lines.push(`  Status : ${rec.status}`);
  }
  if (typeof rec.visibility === "string") {
    lines.push(`  Access : ${rec.visibility}`);
  }
  if (typeof rec.imageDigest === "string") {
    lines.push(`  Image  : ${rec.imageDigest}`);
  }
  return lines.join("\n");
}

export function formatCliHelpText(): string {
  return [
    "FACET CLI (@facet-aex/cli)",
    "",
    "Usage:",
    "  facet <command> [options] [--json]",
    "",
    "Commands:",
    "  wallet create [--profile <name>]",
    "  wallet import [--profile <name>]",
    "  wallet status [--profile <name>]",
    "  search [query] [--type API|ACTOR|AGENT] [--category <slug>] [--origin <url>]",
    "  inspect (<provider/facet-name> | --provider <provider> --facet <facet-name>) [--version <semver>]",
    "  policy grant (--facet <provider/facet-name> | --provider <provider> --facet <facet-name>) [--version <semver>] [--max-per-run <atomic>] [--daily-cap <atomic>] [--expires <ISO8601>] [--profile <name>]",
    "  policy show [--provider <provider>] [--facet <provider/facet-name|facet-name>] [--version <semver>] [--profile <name>]",
    "  policy revoke (([--provider <provider>] --facet <provider/facet-name|facet-name>) [--version <semver>] | --all) [--profile <name>]",
    "  policy prune [--provider <provider>] [--facet <provider/facet-name|facet-name>] [--version <semver>] [--all] [--profile <name>]",
    "  spend history [--profile <name>] [--status PENDING|SETTLED|RELEASED|FAILED] [--day YYYY-MM-DD] [--provider <provider>] [--facet <facet-name>] [--version <semver>]",
    "  mcp config <codex|claude|antigravity> [--profile <name>] [--origin <url>] [--mcp-version <semver>]",
    "  mcp install <codex|claude|antigravity> [--profile <name>] [--origin <url>] [--mcp-version <semver>]",
    "  publish-actor --file <actor-manifest.json> [--origin <url>]",
    "",
    "Global Options:",
    "  --json       Emit structured JSON instead of human-readable text",
    "  -h, --help   Show this help message",
  ].join("\n");
}
