import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FACET_FEE_SPLIT_ADDRESS,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
} from "../src/fuji-wallet.js";
import {
  PolicyStore,
  SpendPolicyError,
  addOneMonthUtc,
  authorizePaymentChallenge,
  defaultPolicyStorePath,
  type PublicFacetRecord,
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
    id: "01a1e97a-90e0-7030-b565-91c9abc3857b",
    versionId: "01a1e97a-90e0-7038-b9ff-4f8d2a599e04",
    slug: "echo-actor",
    name: "Echo Actor",
    displayVersion: "1.0.0",
    provider: { id: "prov-1", name: "Tai Hung", slug: "taihung" },
    facetType: "HOSTED_ACTOR",
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

describe("SpendPolicy store & authorization", () => {
  it("denies by default when no policy grant exists", async () => {
    const dir = await makeTempDir();
    const store = new PolicyStore({ filePath: join(dir, "policies.json") });
    const facet = sampleVerifiedFacet();

    await expect(
      authorizePaymentChallenge(store, {
        facetId: facet.id,
        facetVersionId: facet.versionId,
        chainId: FUJI_CHAIN_ID,
        assetAddress: FUSD_ASSET_ADDRESS,
        settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
        creatorPayTo: facet.pricing.payTo,
        amountAtomic: "1000",
      }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_GRANTED" });
  });

  it("pins exact version, Fuji/fUSD, creator recipient, and fee-split contract on grant, and rejects unverified records", async () => {
    const dir = await makeTempDir();
    const store = new PolicyStore({ filePath: join(dir, "policies.json") });
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
        facetId: unverified.id,
        versionId: unverified.versionId,
        maxPerRunAtomic: "1000",
        dailyCapAtomic: "10000",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "UNVERIFIED_FACET_REGISTRY" });

    const verified = sampleVerifiedFacet();
    await expect(
      store.grant({
        facet: verified,
        facetId: verified.id,
        versionId: "01a1e97a-90e0-7038-b9ff-4f8d2a599999",
        maxPerRunAtomic: "1000",
        dailyCapAtomic: "10000",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_MISMATCH" });

    const grant = await store.grant({
      facet: verified,
      facetId: verified.id,
      versionId: verified.versionId,
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "10000",
      expiresAt: "2030-01-01T00:00:00Z",
    });

    expect(grant.settlementContract.toLowerCase()).toBe(
      FACET_FEE_SPLIT_ADDRESS.toLowerCase(),
    );
    expect(grant.creatorPayTo.toLowerCase()).toBe(
      verified.pricing.payTo.toLowerCase(),
    );
    expect(grant.dayBoundary).toBe("UTC");

    // Different version denied
    await expect(
      authorizePaymentChallenge(store, {
        facetId: verified.id,
        facetVersionId: "01a1e97a-90e0-7038-b9ff-4f8d2a599999",
        chainId: FUJI_CHAIN_ID,
        assetAddress: FUSD_ASSET_ADDRESS,
        settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
        creatorPayTo: verified.pricing.payTo,
        amountAtomic: "1000",
      }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_GRANTED" });
  });

  it("denies expired grants, amount mismatches, wrong creator/settlement recipient, and revoked grants", async () => {
    const dir = await makeTempDir();
    const store = new PolicyStore({ filePath: join(dir, "policies.json") });
    const facet = sampleVerifiedFacet();

    await store.grant({
      facet,
      facetId: facet.id,
      versionId: facet.versionId,
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "5000",
      expiresAt: "2026-11-18T12:00:00Z",
      now: new Date("2026-11-18T00:00:00Z"),
    });

    const validBase = {
      facetId: facet.id,
      facetVersionId: facet.versionId,
      chainId: FUJI_CHAIN_ID,
      assetAddress: FUSD_ASSET_ADDRESS,
      settlementPayTo: FACET_FEE_SPLIT_ADDRESS,
      creatorPayTo: facet.pricing.payTo,
      amountAtomic: "1000",
      now: new Date("2026-11-18T01:00:00Z"),
    };

    const authorized = await authorizePaymentChallenge(store, validBase);
    expect(authorized.versionId).toBe(facet.versionId);

    // Expired
    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        now: new Date("2026-11-18T12:00:01Z"),
      }),
    ).rejects.toMatchObject({ code: "POLICY_EXPIRED" });

    // Amount exceeds max-per-run
    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        amountAtomic: "1001",
      }),
    ).rejects.toMatchObject({ code: "POLICY_MAX_PER_RUN_EXCEEDED" });

    // Wrong creator recipient
    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        creatorPayTo: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toMatchObject({ code: "POLICY_RECIPIENT_MISMATCH" });

    // Wrong fee-split settlement recipient
    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        settlementPayTo: "0x2222222222222222222222222222222222222222",
      }),
    ).rejects.toMatchObject({ code: "POLICY_RECIPIENT_MISMATCH" });

    // Wrong asset / chain
    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        chainId: 43114,
      }),
    ).rejects.toMatchObject({ code: "POLICY_CHAIN_MISMATCH" });

    // Revoke
    const revoked = await store.revoke({
      facetId: facet.id,
      versionId: facet.versionId,
      now: new Date("2026-11-18T02:00:00Z"),
    });
    expect(revoked.revoked).toBe(true);

    await expect(
      authorizePaymentChallenge(store, {
        ...validBase,
        now: new Date("2026-11-18T03:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "POLICY_REVOKED" });
  });

  it("supports facet policy grant, show, and revoke via CLI", async () => {
    const dir = await makeTempDir();
    const policyPath = join(dir, "policies.json");
    const facet = sampleVerifiedFacet();

    const fetchMock = vi.fn(async (url: URL | string) => {
      expect(String(url)).toContain(`/v1/catalog/facets/${facet.id}`);
      return new Response(JSON.stringify({ facet }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const grantOut: string[] = [];
      const grantCode = await runCli(
        [
          "policy",
          "grant",
          "--facet",
          facet.id,
          "--version",
          facet.versionId,
          "--max-per-run",
          "1000",
          "--daily-cap",
          "10000",
          "--expires",
          "2030-01-01T00:00:00Z",
        ],
        {
          env: {
            ...process.env,
            FACET_POLICY_PATH: policyPath,
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
        policy: { versionId: string; maxPerRunAtomic: string; dailyCapAtomic: string };
      };
      expect(granted.policy.versionId).toBe(facet.versionId);
      expect(granted.policy.maxPerRunAtomic).toBe("1000");

      const showOut: string[] = [];
      const showCode = await runCli(["policy", "show"], {
        env: { ...process.env, FACET_POLICY_PATH: policyPath },
        stdout: (line) => showOut.push(line),
      });
      expect(showCode).toBe(0);
      const shown = JSON.parse(showOut[0]!) as {
        dayBoundary: string;
        policies: Array<{ versionId: string }>;
      };
      expect(shown.dayBoundary).toBe("UTC");
      expect(shown.policies).toHaveLength(1);

      const revokeOut: string[] = [];
      const revokeCode = await runCli(
        [
          "policy",
          "revoke",
          "--facet",
          facet.id,
          "--version",
          facet.versionId,
        ],
        {
          env: { ...process.env, FACET_POLICY_PATH: policyPath },
          stdout: (line) => revokeOut.push(line),
        },
      );
      expect(revokeCode).toBe(0);
      expect(JSON.parse(revokeOut[0]!)).toMatchObject({ revoked: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults facet policy grant to latest version, 1000 max-per-run, 10000 daily-cap, and +1 UTC month expiry, and resolves username/facet-name", async () => {
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
      if (href.endsWith("/v1/catalog/facets/taihung/echo-actor")) {
        return new Response(JSON.stringify({ facet }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ facets: [facet] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const grantOut: string[] = [];
      const grantCode = await runCli(
        [
          "policy",
          "grant",
          "--facet",
          "taihung/echo-actor",
          "--profile",
          "research",
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
      const { policy } = JSON.parse(grantOut[0]!) as {
        policy: {
          profile: string;
          facetId: string;
          facetFullName: string;
          versionId: string;
          displayVersion: string;
          maxPerRunAtomic: string;
          dailyCapAtomic: string;
          expiresAt: string;
          grantedAt: string;
        };
      };
      expect(policy.profile).toBe("research");
      expect(policy.facetId).toBe(facet.id);
      expect(policy.facetFullName).toBe("taihung/echo-actor");
      expect(policy.versionId).toBe(facet.versionId);
      expect(policy.displayVersion).toBe("1.0.0");
      expect(policy.maxPerRunAtomic).toBe("1000");
      expect(policy.dailyCapAtomic).toBe("10000");
      expect(Date.parse(policy.expiresAt)).toBeGreaterThan(
        Date.parse(policy.grantedAt) + 27 * 24 * 3600 * 1000,
      );

      const showOut: string[] = [];
      const showCode = await runCli(
        ["policy", "show", "--profile", "research"],
        {
          env: { ...process.env, FACET_CONFIG_DIR: dir },
          stdout: (line) => showOut.push(line),
        },
      );
      expect(showCode).toBe(0);
      expect(JSON.parse(showOut[0]!).policies).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
