import { describe, expect, it, vi } from "vitest";
import { FACET_TYPES, FacetClient } from "../src/index.js";

describe("FacetClient SDK", () => {
  it("exports uppercase FACET_TYPES and queries catalog by type, category, and provider/facetName/version", async () => {
    expect(FACET_TYPES).toEqual(["API", "ACTOR", "AGENT"]);

    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/v1/catalog/facets/tai-hung-dev/vn-gold-fx-actor/versions/1.0.0")) {
        return new Response(
          JSON.stringify({
            facet: {
              provider: "tai-hung-dev",
              facetName: "vn-gold-fx-actor",
              facetDisplayName: "VN Gold & FX Normalizer",
              version: "1.0.0",
              facetType: "ACTOR",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.endsWith("/v1/catalog/facets/tai-hung-dev/vn-gold-fx-actor")) {
        return new Response(
          JSON.stringify({
            facet: {
              provider: "tai-hung-dev",
              facetName: "vn-gold-fx-actor",
              facetDisplayName: "VN Gold & FX Normalizer",
              version: "1.0.1",
              facetType: "ACTOR",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(href).toContain("type=ACTOR");
      expect(href).toContain("category=vietnamese-data");
      return new Response(
        JSON.stringify({
          facets: [
            {
              provider: "tai-hung-dev",
              facetName: "vn-gold-fx-actor",
              facetDisplayName: "VN Gold & FX Normalizer",
              version: "1.0.1",
              facetType: "ACTOR",
            },
          ],
        }),
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
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
