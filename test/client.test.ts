import { describe, expect, it, vi } from "vitest";
import { FacetClient } from "../src/index.js";

describe("FacetClient SDK", () => {
  it("queries catalog with facetType and category filters", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      expect(String(url)).toContain("type=HOSTED_ACTOR");
      expect(String(url)).toContain("category=vietnamese-data");
      return new Response(JSON.stringify({ facets: [{ slug: "vn-gold-fx-actor" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FacetClient({
      controlApiUrl: "http://127.0.0.1:4000",
    });
    const facets = await client.searchFacets({
      query: "gold",
      type: "HOSTED_ACTOR",
      category: "vietnamese-data",
    });

    expect(facets).toEqual([{ slug: "vn-gold-fx-actor" }]);
    vi.unstubAllGlobals();
  });
});
