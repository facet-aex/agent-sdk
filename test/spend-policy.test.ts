import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FACET_FEE_SPLIT_ADDRESS,
  FACET_LEGACY_FEE_SPLIT_V1_ADDRESS,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
} from "../src/fuji-wallet.js";
import {
  PolicyStore,
  SpendPolicyError,
  addOneMonthUtc,
  authorizePaymentChallenge,
  defaultPolicyStorePath,
  getGrantPricingOptions,
  getPolicyGrantWarnings,
  validateGrantAgainstChallenge,
  type PublicFacetRecord,
  type SpendPolicyGrant,
} from "../src/spend-policy.js";
import { defaultSpendLedgerPath } from "../src/spend-ledger.js";
import { runCli } from "../src/cli.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facet-policy-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function sampleVerifiedFacet(
  overrides?: Partial<PublicFacetRecord>,
): PublicFacetRecord & { pricing: NonNullable<PublicFacetRecord["pricing"]> } {
  const basePricing: NonNullable<PublicFacetRecord["pricing"]> = {
    model: "PAY_PER_RUN",
    priceAtomic: "1000",
    assetAddress: FUSD_ASSET_ADDRESS,
    chainId: FUJI_CHAIN_ID,
    payTo: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
  };
  return {
    provider: "tai-hung-dev",
    facetName: "echo-actor",
    facetDisplayName: "Echo Actor",
    version: "1.0.0",
    facetType: "ACTOR",
    actorMeta: {
      runtime: "nodejs22-alpine-v1",
      imageDigest: "sha256:" + "a".repeat(64),
      registryTxHash: "0x" + "1".repeat(64),
      registryVerified: true,
    },
    ...overrides,
    pricing: overrides?.pricing ?? basePricing,
  };
}

describe("SpendPolicy Option B store & authorization", () => {
  it("denies by default when no policy grant exists", async () => {
    const dir = await makeTempDir();
    const store = new PolicyStore({ filePath: join(dir, "policies.json") });
    const facet = sampleVerifiedFacet();

    await expect(
      authorizePaymentChallenge(store, {
        provider: facet.provider,
        facetName: facet.facetName,
        version: facet.version,
        chainId: FUJI_CHAIN_ID,
        assetAddress: FUSD_ASSET_ADDRESS,
        settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
        providerPayTo: facet.pricing.payTo,
        amountAtomic: "1000",
      }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_GRANTED" });
  });

  it("pins natural keys, SemVer version, Fuji/fUSD, provider recipient, and fee-split contract, omitting redundant/UUID fields", async () => {
    const dir = await makeTempDir();
    const policyPath = join(dir, "policies.json");
    const store = new PolicyStore({ filePath: policyPath });

    const unverified = sampleVerifiedFacet({
      actorMeta: {
        runtime: "nodejs22-alpine-v1",
        imageDigest: "sha256:" + "a".repeat(64),
        registryVerified: false,
      },
    });
    await expect(
      store.grant({
        facet: unverified,
        maxPerRunAtomic: "1000",
        dailyCapAtomic: "10000",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "UNVERIFIED_FACET_REGISTRY" });

    const verified = sampleVerifiedFacet();
    await expect(
      store.grant({
        facet: verified,
        version: "1.0.1",
        maxPerRunAtomic: "1000",
        dailyCapAtomic: "10000",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_MISMATCH" });

    await expect(
      store.grant({
        facet: sampleVerifiedFacet({ provider: "short" }),
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });

    await expect(
      store.grant({
        facet: sampleVerifiedFacet({ version: "v1" }),
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });

    const grant = await store.grant({
      facet: verified,
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "10000",
      expiresAt: "2030-01-01T00:00:00Z",
    });

    expect(grant.provider).toBe("tai-hung-dev");
    expect(grant.facetName).toBe("echo-actor");
    expect(grant.facetDisplayName).toBe("Echo Actor");
    expect(grant.version).toBe("1.0.0");
    expect(grant.facetType).toBe("ACTOR");
    expect(grant.settlementContract.toLowerCase()).toBe(
      FACET_FEE_SPLIT_ADDRESS.toLowerCase(),
    );

    const serializedGrant = JSON.stringify(grant);
    expect(serializedGrant).not.toMatch(
      /profile|facetId|versionId|facetSlug|facetFullName|displayVersion|\bslug\b|\bfullName\b|\bcreator\b|creatorPayTo/u,
    );

    // Different SemVer version denied
    await expect(
      authorizePaymentChallenge(store, {
        provider: verified.provider,
        facetName: verified.facetName,
        version: "1.0.1",
        chainId: FUJI_CHAIN_ID,
        assetAddress: FUSD_ASSET_ADDRESS,
        settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
        providerPayTo: verified.pricing.payTo,
        amountAtomic: "1000",
      }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_GRANTED" });

    // Raw file does not contain profile inside entries
    const fileText = await readFile(policyPath, "utf8");
    expect(fileText).not.toContain('"profile"');
  });

  it("denies expired grants, amount mismatches, wrong provider/settlement recipient, and revoked/pruned grants", async () => {
    const dir = await makeTempDir();
    const store = new PolicyStore({ filePath: join(dir, "policies.json") });
    const facet = sampleVerifiedFacet();

    await store.grant({
      facet,
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "5000",
      expiresAt: "2026-11-18T12:00:00Z",
      now: new Date("2026-11-18T00:00:00Z"),
    });

    const validBase = {
      provider: facet.provider,
      facetName: facet.facetName,
      version: facet.version,
      chainId: FUJI_CHAIN_ID,
      assetAddress: FUSD_ASSET_ADDRESS,
      settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
      providerPayTo: facet.pricing.payTo,
      amountAtomic: "1000",
      now: new Date("2026-11-18T01:00:00Z"),
    };

    const authorized = await authorizePaymentChallenge(store, validBase);
    expect(authorized.version).toBe("1.0.0");

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        now: new Date("2026-11-18T12:00:01Z"),
      }),
    ).rejects.toMatchObject({ code: "POLICY_EXPIRED" });

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        amountAtomic: "1001",
      }),
    ).rejects.toMatchObject({ code: "POLICY_MAX_PER_RUN_EXCEEDED" });

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        providerPayTo: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toMatchObject({ code: "POLICY_RECIPIENT_MISMATCH" });

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        settlementPayTo: "0x2222222222222222222222222222222222222222",
      }),
    ).rejects.toMatchObject({ code: "POLICY_RECIPIENT_MISMATCH" });

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        chainId: 43114,
      }),
    ).rejects.toMatchObject({ code: "POLICY_CHAIN_MISMATCH" });

    const revoked = await store.revoke({
      provider: facet.provider,
      facetName: facet.facetName,
      version: facet.version,
      now: new Date("2026-11-18T02:00:00Z"),
    });
    expect(revoked.revoked).toBe(true);

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        now: new Date("2026-11-18T03:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "POLICY_REVOKED" });

    const pruned = await store.prune({ all: true });
    expect(pruned.pruned).toBe(1);
    expect((await store.show()).policies).toHaveLength(0);
  });

  it("supports CLI policy grant (--facet provider/facet or --provider + --facet), show, revoke, prune, and defaults", async () => {
    const dir = await makeTempDir();
    const facet = sampleVerifiedFacet();

    expect(addOneMonthUtc(new Date("2026-01-31T10:00:00Z")).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(defaultPolicyStorePath({ FACET_CONFIG_DIR: dir })).toBe(
      join(dir, "policies.json"),
    );
    expect(
      defaultPolicyStorePath({ FACET_CONFIG_DIR: dir, FACET_PROFILE: "research" }),
    ).toBe(join(dir, "profiles", "research", "policies.json"));
    expect(
      defaultSpendLedgerPath({ FACET_CONFIG_DIR: dir, FACET_PROFILE: "research" }),
    ).toBe(join(dir, "profiles", "research", "spend-ledger.json"));

    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      expect(href).toContain("/v1/catalog/facets/tai-hung-dev/echo-actor");
      return new Response(JSON.stringify({ facet }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const grantTextOut: string[] = [];
      const grantTextCode = await runCli(
        [
          "policy",
          "grant",
          "--facet",
          "tai-hung-dev/echo-actor",
          "--profile",
          "research",
        ],
        {
          env: {
            ...process.env,
            FACET_CONFIG_DIR: dir,
            FACET_CONTROL_API_URL: "https://facet.briandev.space",
          },
          stdout: (line) => grantTextOut.push(line),
          stderr: (line) => {
            throw new SpendPolicyError("POLICY_INVALID", line);
          },
        },
      );
      expect(grantTextCode).toBe(0);
      expect(grantTextOut[0]).toContain("FACET Policy Granted (profile: research)");
      expect(grantTextOut[0]).toContain("tai-hung-dev/echo-actor@1.0.0");
      expect(() => JSON.parse(grantTextOut[0]!)).toThrow();

      const grantOut: string[] = [];
      const grantCode = await runCli(
        [
          "policy",
          "grant",
          "--facet",
          "tai-hung-dev/echo-actor",
          "--profile",
          "research",
          "--json",
        ],
        {
          env: {
            ...process.env,
            FACET_CONFIG_DIR: dir,
            FACET_CONTROL_API_URL: "https://facet.briandev.space",
          },
          stdout: (line) => grantOut.push(line),
          stderr: (line) => {
            throw new SpendPolicyError("POLICY_INVALID", line);
          },
        },
      );
      expect(grantCode).toBe(0);
      const granted = JSON.parse(grantOut[0]!) as {
        profile: string;
        policy: Record<string, unknown>;
      };
      expect(granted.profile).toBe("research");
      expect(granted.policy.provider).toBe("tai-hung-dev");
      expect(granted.policy.facetName).toBe("echo-actor");
      expect(granted.policy.facetDisplayName).toBe("Echo Actor");
      expect(granted.policy.version).toBe("1.0.0");
      expect(granted.policy.facetType).toBe("ACTOR");
      expect(granted.policy.profile).toBeUndefined();
      expect(granted.policy.facetId).toBeUndefined();
      expect(granted.policy.versionId).toBeUndefined();
      expect(granted.policy.facetSlug).toBeUndefined();
      expect(granted.policy.facetFullName).toBeUndefined();
      expect(granted.policy.displayVersion).toBeUndefined();

      const showTextOut: string[] = [];
      const showTextCode = await runCli(
        [
          "policy",
          "show",
          "--provider",
          "tai-hung-dev",
          "--facet",
          "echo-actor",
          "--profile",
          "research",
        ],
        {
          env: { ...process.env, FACET_CONFIG_DIR: dir },
          stdout: (line) => showTextOut.push(line),
        },
      );
      expect(showTextCode).toBe(0);
      expect(showTextOut[0]).toContain("[ACTIVE] tai-hung-dev/echo-actor@1.0.0");
      expect(() => JSON.parse(showTextOut[0]!)).toThrow();

      const showOut: string[] = [];
      const showCode = await runCli(
        [
          "policy",
          "show",
          "--provider",
          "tai-hung-dev",
          "--facet",
          "echo-actor",
          "--profile",
          "research",
          "--json",
        ],
        {
          env: { ...process.env, FACET_CONFIG_DIR: dir },
          stdout: (line) => showOut.push(line),
        },
      );
      expect(showCode).toBe(0);
      const shown = JSON.parse(showOut[0]!) as {
        profile: string;
        policies: Array<{ provider: string; facetName: string }>;
      };
      expect(shown.profile).toBe("research");
      expect(shown.policies).toHaveLength(1);
      expect(shown.policies[0]?.provider).toBe("tai-hung-dev");

      const revokeOut: string[] = [];
      const revokeCode = await runCli(
        [
          "policy",
          "revoke",
          "--provider",
          "tai-hung-dev",
          "--facet",
          "echo-actor",
          "--profile",
          "research",
        ],
        {
          env: { ...process.env, FACET_CONFIG_DIR: dir },
          stdout: (line) => revokeOut.push(line),
        },
      );
      expect(revokeCode).toBe(0);
      expect(revokeOut[0]).toBe("Revoked 1 policy/policies in profile 'research'.");

      const pruneOut: string[] = [];
      const pruneCode = await runCli(
        ["policy", "prune", "--profile", "research", "--json"],
        {
          env: { ...process.env, FACET_CONFIG_DIR: dir },
          stdout: (line) => pruneOut.push(line),
        },
      );
      expect(pruneCode).toBe(0);
      expect(JSON.parse(pruneOut[0]!)).toMatchObject({ pruned: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("supports multi-pricing grants, --pricing-model selection, grant warnings, verified API facets, and strict PAY_PER_RESULT validation", async () => {
    const dir = await makeTempDir();
    const store = new PolicyStore({ filePath: join(dir, "policies.json") });
    const payTo = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
    const dualPricingFacet: PublicFacetRecord = {
      ...sampleVerifiedFacet(),
      facetName: "vn-tech-news-actor",
      facetDisplayName: "VN Tech & Macro News Extractor",
      pricing: {
        model: "PAY_PER_RUN",
        priceAtomic: "10000",
        maxAmountAtomic: "10000",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo,
        isPrimary: true,
      },
      pricingOptions: [
        {
          model: "PAY_PER_RUN",
          priceAtomic: "10000",
          maxAmountAtomic: "10000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo,
          isPrimary: true,
        },
        {
          model: "PAY_PER_RESULT",
          priceAtomic: "500",
          maxItemsCap: 20,
          maxAmountAtomic: "10000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo,
          isPrimary: false,
        },
      ],
    };

    // 1. Grant without pricingModel pins both options; default maxPerRunAtomic=1000 produces warnings
    const dualGrant = await store.grant({
      facet: dualPricingFacet,
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(getGrantPricingOptions(dualGrant)).toEqual([
      {
        model: "PAY_PER_RUN",
        priceAtomic: "10000",
        maxAmountAtomic: "10000",
      },
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 20,
        maxAmountAtomic: "10000",
      },
    ]);
    expect(dualGrant.pricingModel).toBe("PAY_PER_RUN");
    expect(dualGrant.pinnedPriceAtomic).toBe("10000");

    const warnings = getPolicyGrantWarnings(dualGrant);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("PAY_PER_RUN");
    expect(warnings[1]).toContain("PAY_PER_RESULT");
    expect(warnings.join("\n")).not.toMatch(/\bfuji\b/iu);

    // Grant with sufficient maxPerRunAtomic emits no warnings and validates same-amount disambiguation
    const sufficientDualGrant = await store.grant({
      facet: dualPricingFacet,
      maxPerRunAtomic: "10000",
      dailyCapAtomic: "50000",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(getPolicyGrantWarnings(sufficientDualGrant)).toEqual([]);

    const baseChallenge = {
      provider: dualPricingFacet.provider,
      facetName: dualPricingFacet.facetName,
      version: dualPricingFacet.version,
      chainId: FUJI_CHAIN_ID,
      assetAddress: FUSD_ASSET_ADDRESS,
      settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
      providerPayTo: payTo,
    };

    expect(
      validateGrantAgainstChallenge(sufficientDualGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "10000",
        amountAtomic: "10000",
      }).provider,
    ).toBe(dualPricingFacet.provider);

    expect(
      validateGrantAgainstChallenge(sufficientDualGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 20,
        amountAtomic: "10000",
      }).provider,
    ).toBe(dualPricingFacet.provider);

    // Rejects tampered unitPriceAtomic, maxItemsCap, PAY_PER_RUN + maxItemsCap, and amount !== unitPrice * maxItemsCap
    expect(() =>
      validateGrantAgainstChallenge(sufficientDualGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "501",
        maxItemsCap: 20,
        amountAtomic: "10000",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_PRICE_MISMATCH" }));

    expect(() =>
      validateGrantAgainstChallenge(sufficientDualGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        amountAtomic: "5000",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_PRICE_MISMATCH" }));

    expect(() =>
      validateGrantAgainstChallenge(sufficientDualGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 20,
        amountAtomic: "9500",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_PRICE_MISMATCH" }));

    expect(() =>
      validateGrantAgainstChallenge(sufficientDualGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "10000",
        maxItemsCap: 20,
        amountAtomic: "10000",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_PRICE_MISMATCH" }));

    // 2. Grant with explicit pricingModel pins only that pricingModel and rejects ungranted model
    const singleGrant = await store.grant({
      facet: dualPricingFacet,
      pricingModel: "PAY_PER_RESULT",
      maxPerRunAtomic: "10000",
      dailyCapAtomic: "50000",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(getGrantPricingOptions(singleGrant)).toEqual([
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 20,
        maxAmountAtomic: "10000",
      },
    ]);
    expect(singleGrant.pricingModel).toBe("PAY_PER_RESULT");
    expect(singleGrant.pinnedPriceAtomic).toBe("500");

    expect(() =>
      validateGrantAgainstChallenge(singleGrant, {
        ...baseChallenge,
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "10000",
        amountAtomic: "10000",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_PRICE_MISMATCH" }));

    // 3. Verified API facets allowed; unverified API facets rejected with Avalanche copy
    const unverifiedApi: PublicFacetRecord = {
      provider: "tai-hung-dev",
      facetName: "market-prices-api",
      facetDisplayName: "Market Prices API",
      version: "1.0.0",
      facetType: "API",
      pricing: {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo,
      },
      apiMeta: {
        method: "GET",
        pathTemplate: "/v1/prices",
        registryVerified: false,
      },
    };
    let apiErr: unknown;
    try {
      await store.grant({
        facet: unverifiedApi,
        expiresAt: "2030-01-01T00:00:00Z",
      });
    } catch (error) {
      apiErr = error;
    }
    expect(apiErr).toMatchObject({ code: "UNVERIFIED_FACET_REGISTRY" });
    expect((apiErr as Error).message).not.toMatch(/\bfuji\b/iu);

    const verifiedApi: PublicFacetRecord = {
      ...unverifiedApi,
      apiMeta: {
        method: "GET",
        pathTemplate: "/v1/prices",
        datasetPath: "data.items",
        registryVerified: true,
        registryTxHash: "0x" + "4".repeat(64),
      },
    };
    const apiGrant = await store.grant({
      facet: verifiedApi,
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "10000",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(apiGrant.facetType).toBe("API");
    expect(apiGrant.registryTxHash).toBe("0x" + "4".repeat(64));

    // 4. Legacy v2 grant without pricingOptions falls back cleanly
    const legacyV2Grant: SpendPolicyGrant = {
      provider: "tai-hung-dev",
      facetName: "legacy-actor",
      facetDisplayName: "Legacy Actor",
      version: "1.0.0",
      facetType: "ACTOR",
      chainId: FUJI_CHAIN_ID,
      network: "eip155:43113",
      assetAddress: FUSD_ASSET_ADDRESS,
      settlementContract: FACET_LEGACY_FEE_SPLIT_V1_ADDRESS,
      providerPayTo: payTo,
      pricingModel: "PAY_PER_RUN",
      pinnedPriceAtomic: "1000",
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "10000",
      dayBoundary: "UTC",
      expiresAt: "2030-01-01T00:00:00Z",
      registryTxHash: "0x" + "1".repeat(64),
      grantedAt: "2026-11-18T00:00:00Z",
    };
    expect(getGrantPricingOptions(legacyV2Grant)).toEqual([
      {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxAmountAtomic: "1000",
      },
    ]);

    expect(() =>
      validateGrantAgainstChallenge(legacyV2Grant, {
        provider: legacyV2Grant.provider,
        facetName: legacyV2Grant.facetName,
        version: legacyV2Grant.version,
        chainId: FUJI_CHAIN_ID,
        assetAddress: FUSD_ASSET_ADDRESS,
        settlementPayTo: "0x0000000000000000000000000000000000000099",
        providerPayTo: payTo,
        amountAtomic: "1000",
      }),
    ).toThrowError(/facet policy grant/iu);
  });
});
