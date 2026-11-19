import { describe, expect, it, vi } from "vitest";
import { FACET_TYPES, FacetClient } from "../src/index.js";
import { runCli } from "../src/cli.js";

describe("FacetClient SDK & search/inspect CLI output", () => {
  it("exports uppercase FACET_TYPES and queries catalog by type, category, and provider/facetName/version", async () => {
    expect(FACET_TYPES).toEqual(["API", "ACTOR", "AGENT"]);

    const sampleFacet = {
      provider: "tai-hung-dev",
      facetName: "vn-gold-fx-actor",
      facetDisplayName: "VN Gold & FX Normalizer",
      version: "1.0.1",
      facetType: "ACTOR",
      description: "Normalizes Vietnam gold & FX feeds.",
      pricing: {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
        chainId: 43113,
        payTo: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
      },
      actorMeta: {
        runtime: "nodejs22-alpine-v1",
        imageDigest: "sha256:" + "a".repeat(64),
        registryTxHash: "0x" + "1".repeat(64),
        registryVerified: true,
      },
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search keyword" },
        },
      },
    };

    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (
        href.includes(
          "/v1/catalog/facets/tai-hung-dev/vn-gold-fx-actor/versions/1.0.0",
        )
      ) {
        return new Response(
          JSON.stringify({
            facet: { ...sampleFacet, version: "1.0.0" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.endsWith("/v1/catalog/facets/tai-hung-dev/vn-gold-fx-actor")) {
        return new Response(
          JSON.stringify({ facet: sampleFacet }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(href).toContain("type=ACTOR");
      expect(href).toContain("category=vietnamese-data");
      return new Response(
        JSON.stringify({ facets: [sampleFacet] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new FacetClient({
        controlApiUrl: "https://facet.briandev.space",
      });
      const facets = await client.searchFacets({
        query: "gold",
        type: "ACTOR",
        category: "vietnamese-data",
      });
      expect(facets).toHaveLength(1);

      const pinned = (await client.getFacet(
        "tai-hung-dev",
        "vn-gold-fx-actor",
        "1.0.0",
      )) as { version: string };
      expect(pinned.version).toBe("1.0.0");

      const resolved = (await client.resolveFacet(
        "tai-hung-dev/vn-gold-fx-actor",
      )) as { version: string };
      expect(resolved.version).toBe("1.0.1");

      // CLI search prints human-readable catalog text by default
      const searchTextOut: string[] = [];
      const searchCode = await runCli(
        ["search", "gold", "--type", "ACTOR", "--category", "vietnamese-data"],
        { stdout: (line) => searchTextOut.push(line) },
      );
      expect(searchCode).toBe(0);
      expect(searchTextOut[0]).toContain("FACET Catalog (1 facet(s))");
      expect(searchTextOut[0]).toContain(
        "tai-hung-dev/vn-gold-fx-actor@1.0.1  [ACTOR]",
      );
      expect(searchTextOut[0]).toContain(
        "0.001000 fUSD (1000 atomic) (PAY_PER_RUN)",
      );
      expect(() => JSON.parse(searchTextOut[0]!)).toThrow();

      // CLI search --json emits JSON
      const searchJsonOut: string[] = [];
      expect(
        await runCli(
          [
            "search",
            "gold",
            "--type",
            "ACTOR",
            "--category",
            "vietnamese-data",
            "--json",
          ],
          { stdout: (line) => searchJsonOut.push(line) },
        ),
      ).toBe(0);
      expect(
        (JSON.parse(searchJsonOut[0]!) as { facets: unknown[] }).facets,
      ).toHaveLength(1);

      // CLI inspect prints human-readable detail + schema summary by default
      const inspectTextOut: string[] = [];
      expect(
        await runCli(
          ["inspect", "tai-hung-dev/vn-gold-fx-actor", "--version", "1.0.0"],
          { stdout: (line) => inspectTextOut.push(line) },
        ),
      ).toBe(0);
      expect(inspectTextOut[0]).toContain(
        "FACET Detail: tai-hung-dev/vn-gold-fx-actor@1.0.0",
      );
      expect(inspectTextOut[0]).toContain("query (string, required)");
      expect(() => JSON.parse(inspectTextOut[0]!)).toThrow();

      // CLI inspect --json emits JSON
      const inspectJsonOut: string[] = [];
      expect(
        await runCli(
          [
            "inspect",
            "tai-hung-dev/vn-gold-fx-actor",
            "--version",
            "1.0.0",
            "--json",
          ],
          { stdout: (line) => inspectJsonOut.push(line) },
        ),
      ).toBe(0);
      expect(
        (JSON.parse(inspectJsonOut[0]!) as { facet: { version: string } }).facet
          .version,
      ).toBe("1.0.0");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
