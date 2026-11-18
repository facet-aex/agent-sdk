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
  FACET_RECEIPT_LOG_ADDRESS,
  FUJI_CHAIN_ID,
  FUJI_NETWORK,
  FUJI_RPC_URL,
  FUSD_ASSET_ADDRESS,
  FUSD_DECIMALS,
  FUSD_SYMBOL,
  FujiWalletError,
  createViemFujiClient,
  formatFusdAtomic,
  readFujiWalletStatus,
  type FujiRpcClient,
  type FujiWalletErrorCode,
  type FujiWalletStatus,
} from "./fuji-wallet.js";
export {
  SpendLedger,
  SpendLedgerError,
  defaultSpendLedgerPath,
  parsePositiveAtomic,
  utcDayKey,
  type ConfirmOptions,
  type ReserveOptions,
  type SpendEntryStatus,
  type SpendLedgerEntry,
  type SpendLedgerErrorCode,
} from "./spend-ledger.js";
export {
  DEFAULT_POLICY_DAILY_CAP_ATOMIC,
  DEFAULT_POLICY_MAX_PER_RUN_ATOMIC,
  PolicyStore,
  SpendPolicyError,
  addOneMonthUtc,
  authorizePaymentChallenge,
  defaultPolicyStorePath,
  validateGrantAgainstChallenge,
  type AuthorizeChallengeInput,
  type GrantPolicyInput,
  type PublicFacetRecord,
  type SpendPolicyErrorCode,
  type SpendPolicyGrant,
} from "./spend-policy.js";

export type FacetType =
  | "EXTERNAL_HTTP_API"
  | "HOSTED_ACTOR"
  | "AUTONOMOUS_AGENT";

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
    const body = (await response.json()) as { facets?: unknown[]; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facets ?? [];
  }

  async getFacet(facetId: string) {
    const url = new URL(`/v1/catalog/facets/${facetId}`, this.config.controlApiUrl);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = (await response.json()) as { facet?: unknown; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facet;
  }

  async resolveFacet(facetRef: string) {
    const trimmed = facetRef.trim();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        trimmed,
      )
    ) {
      return this.getFacet(trimmed);
    }

    const parts = trimmed.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const [username, facetSlug] = parts;
      const directUrl = new URL(
        `/v1/catalog/facets/${encodeURIComponent(username)}/${encodeURIComponent(facetSlug)}`,
        this.config.controlApiUrl,
      );
      const directRes = await fetch(directUrl, {
        headers: { accept: "application/json" },
      });
      if (directRes.ok) {
        const body = (await directRes.json()) as { facet?: unknown };
        if (body.facet) return body.facet;
      }

      const candidates = (await this.searchFacets({
        query: facetSlug,
        limit: 50,
      })) as Array<{
        slug?: string;
        fullName?: string;
        provider?: { slug?: string };
      }>;
      return candidates.find(
        (candidate) =>
          candidate.fullName === trimmed ||
          (candidate.provider?.slug === username &&
            candidate.slug === facetSlug),
      );
    }

    const candidates = (await this.searchFacets({
      query: trimmed,
      limit: 50,
    })) as Array<{ slug?: string }>;
    const matches = candidates.filter((candidate) => candidate.slug === trimmed);
    if (matches.length > 1) {
      throw new Error(
        `AMBIGUOUS_FACET_NAME: Multiple facets match '${trimmed}'. Specify <username>/<facet-name>.`,
      );
    }
    return matches[0];
  }

  async publishActor(input: {
    providerId: string;
    name: string;
    slug: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
    code: string;
    pricingModel?: "PAY_PER_RUN" | "PAY_PER_RESULT";
    priceAtomic?: string;
    payTo?: string;
    tags?: string[];
  }) {
    const url = new URL("/v1/actors", this.config.controlApiUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as { facet?: unknown; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facet;
  }

  async registerAgentFacet(input: {
    providerId: string;
    name: string;
    slug: string;
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
    const body = (await response.json()) as { facet?: unknown; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    return body.facet;
  }
}
