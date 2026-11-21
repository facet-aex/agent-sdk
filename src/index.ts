export {
  DEFAULT_WALLET_ACCOUNT,
  DEFAULT_WALLET_SERVICE,
  FUJI_WALLET_CHAIN_ID,
  FUJI_WALLET_NETWORK,
  MacOsKeychainBackend,
  WalletStore,
  WalletStoreError,
  redactSecrets,
  resolveProfileName,
  type CommandResult,
  type CredentialBackend,
  type SecurityCommandRunner,
  type WalletCreateResult,
  type WalletImportResult,
  type WalletStoreErrorCode,
} from "./wallet-store.js";
export {
  DEFAULT_FACET_ORIGIN,
  FACET_ACTOR_REGISTRY_ADDRESS,
  FACET_FEE_SPLIT_ADDRESS,
  FACET_LEGACY_FEE_SPLIT_V1_ADDRESS,
  FACET_RECEIPT_LOG_ADDRESS,
  FUJI_CHAIN_ID,
  FUJI_NETWORK,
  FUJI_RPC_URL,
  FUSD_ASSET_ADDRESS,
  FUSD_DECIMALS,
  FUSD_SYMBOL,
  FujiWalletError,
  createViemEscrowClient,
  createViemFujiClient,
  formatFusdAtomic,
  readEscrowState,
  readFujiWalletStatus,
  reclaimExpiredEscrow,
  resolveFeeSplitContractAddress,
  type EscrowReclaimResult,
  type EscrowRpcClient,
  type EscrowStateSnapshot,
  type FujiRpcClient,
  type FujiWalletErrorCode,
  type FujiWalletStatus,
  type OnChainEscrowStateName,
} from "./fuji-wallet.js";
export {
  FACET_NAME_MAX,
  FACET_NAME_MIN,
  FACET_NAME_REGEX,
  FACET_TYPES,
  SEMVER_REGEX,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_REGEX,
  compareSemver,
  isValidFacetName,
  isValidFacetType,
  isValidSemver,
  isValidUsername,
  parseFacetRef,
  parseSemver,
  type FacetType,
} from "./identifiers.js";
export {
  SNOWTRACE_TX_BASE,
  SpendLedger,
  SpendLedgerError,
  defaultSpendLedgerPath,
  formatSpendHistory,
  formatSpendHistoryText,
  parseNonNegativeAtomic,
  parsePositiveAtomic,
  snowtraceTxUrl,
  utcDayKey,
  type ConfirmOptions,
  type ReserveOptions,
  type SpendEntryStatus,
  type SpendHistoryInvoice,
  type SpendHistoryReport,
  type SpendLedgerEntry,
  type SpendLedgerErrorCode,
} from "./spend-ledger.js";
export {
  formatCliHelpText,
  formatEscrowReclaimText,
  formatEscrowStatusText,
  formatFacetInspectText,
  formatFacetSearchText,
  formatMcpInstallText,
  formatPolicyGrantText,
  formatPolicyPruneText,
  formatPolicyRevokeText,
  formatPolicyShowText,
  formatPublishActorText,
  formatWalletCreateText,
  formatWalletImportText,
  formatWalletStatusText,
} from "./cli-format.js";
export {
  DEFAULT_PAY_PER_RESULT_MAX_ITEMS_CAP,
  DEFAULT_POLICY_DAILY_CAP_ATOMIC,
  DEFAULT_POLICY_MAX_PER_RUN_ATOMIC,
  HTTP_METHODS,
  MAX_PAY_PER_RESULT_ITEMS_CAP,
  PRICING_MODELS,
  PolicyStore,
  SpendPolicyError,
  addOneMonthUtc,
  authorizePaymentChallenge,
  defaultPolicyStorePath,
  getGrantPricingOptions,
  getPolicyGrantWarnings,
  isValidPricingModel,
  validateGrantAgainstChallenge,
  type ApiMeta,
  type AuthorizeChallengeInput,
  type FacetPricingOption,
  type GrantPolicyInput,
  type HttpMethod,
  type PinnedPricingOption,
  type PricingModel,
  type PublicFacetRecord,
  type SpendPolicyErrorCode,
  type SpendPolicyGrant,
} from "./spend-policy.js";

export {
  MCP_CLIENT_NAMES,
  PINNED_MCP_PACKAGE_NAME,
  PINNED_MCP_PACKAGE_VERSION,
  buildFacetMcpSpec,
  isMcpClientName,
  renderCodexTomlSection,
  renderMcpConfigSnippet,
  type BuildMcpSpecOptions,
  type FacetMcpServerSpec,
  type McpClientName,
} from "./mcp-config.js";
export {
  McpInstallError,
  installMcpClient,
  type InstallMcpOptions,
  type InstallMcpResult,
  type McpInstallErrorCode,
} from "./mcp-install.js";

import {
  compareSemver,
  isValidFacetName,
  isValidSemver,
  isValidUsername,
  parseFacetRef,
  type FacetType,
} from "./identifiers.js";
import type { PricingModel, PublicFacetRecord } from "./spend-policy.js";

export interface FacetClientConfig {
  controlApiUrl: string;
  gatewayUrl?: string;
  devUser?: string;
  bearerToken?: string;
}

export interface SearchFacetsOptions {
  query?: string;
  type?: FacetType;
  category?: string;
  limit?: number;
}

export class FacetClient {
  constructor(private readonly config: FacetClientConfig) {}

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.config.bearerToken) {
      headers.authorization = `Bearer ${this.config.bearerToken}`;
    } else if (this.config.devUser) {
      headers["x-facet-dev-user"] = this.config.devUser;
    }
    return headers;
  }

  async searchFacets(options: SearchFacetsOptions = {}) {
    const url = new URL("/v1/catalog/facets", this.config.controlApiUrl);
    if (options.query) url.searchParams.set("q", options.query);
    if (options.type) url.searchParams.set("type", options.type);
    if (options.category) url.searchParams.set("category", options.category);
    if (options.limit) url.searchParams.set("limit", String(options.limit));
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = (await response.json()) as {
      facets?: PublicFacetRecord[];
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facets ?? [];
  }

  async getFacet(provider: string, facetName: string, version?: string) {
    if (!isValidUsername(provider)) {
      throw new Error(
        `Invalid provider '${provider}'. Must be 8-16 lowercase hyphenated kebab-case characters.`,
      );
    }
    if (!isValidFacetName(facetName)) {
      throw new Error(
        `Invalid facetName '${facetName}'. Must be 4-32 lowercase hyphenated kebab-case characters.`,
      );
    }
    if (version !== undefined && !isValidSemver(version)) {
      throw new Error(
        `Invalid version '${version}'. Expected SemVer MAJOR.MINOR.PATCH.`,
      );
    }

    const base = `/v1/catalog/facets/${encodeURIComponent(provider)}/${encodeURIComponent(facetName)}`;
    const path = version ? `${base}/versions/${encodeURIComponent(version)}` : base;
    const url = new URL(path, this.config.controlApiUrl);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = (await response.json()) as {
      facet?: PublicFacetRecord;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facet;
  }

  async resolveFacet(
    facetRef: string,
    options?: { provider?: string; version?: string },
  ): Promise<PublicFacetRecord | undefined> {
    const { provider, facetName } = parseFacetRef(facetRef, options?.provider);
    if (options?.version !== undefined && !isValidSemver(options.version)) {
      throw new Error(
        `Invalid version '${options.version}'. Expected SemVer MAJOR.MINOR.PATCH.`,
      );
    }

    try {
      const direct = await this.getFacet(provider, facetName, options?.version);
      if (direct) return direct;
    } catch {
      // Fall back to catalog search when looking up without an exact direct match.
    }

    const candidates = await this.searchFacets({ query: facetName, limit: 50 });
    const matching = candidates.filter(
      (candidate) =>
        candidate.provider === provider &&
        candidate.facetName === facetName &&
        (!options?.version || candidate.version === options.version),
    );
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => compareSemver(b.version, a.version));
    return matching[0];
  }

  async publishActor(input: {
    facetName: string;
    facetDisplayName: string;
    version?: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
    code: string;
    pricingModel?: PricingModel;
    priceAtomic?: string;
    maxItemsCap?: number;
    pricingOptions?: Array<{
      model: PricingModel;
      priceAtomic: string;
      maxItemsCap?: number;
      isPrimary?: boolean;
    }>;
    payTo?: string;
    tags?: string[];
  }) {
    const url = new URL("/v1/actors", this.config.controlApiUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as {
      facet?: unknown;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facet;
  }

  async registerAgentFacet(input: {
    facetName: string;
    facetDisplayName: string;
    version?: string;
    description: string;
    category: string;
    erc8004TokenId: string;
    taskKind: string;
    inputSchema: Record<string, unknown>;
    pricingModel?: "PAY_PER_RUN" | "PAY_PER_RESULT";
    priceAtomic?: string;
    payTo?: string;
    tags?: string[];
  }) {
    const url = new URL("/v1/agent-facets", this.config.controlApiUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as {
      facet?: unknown;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facet;
  }
}
