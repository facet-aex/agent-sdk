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
