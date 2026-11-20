import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile as readFileAsync, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { runCli } from "../src/cli.js";
import {
  formatCliHelpText,
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
} from "../src/cli-format.js";
import {
  FACET_FEE_SPLIT_ADDRESS,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
  readFujiWalletStatus,
  type FujiRpcClient,
} from "../src/fuji-wallet.js";
import { formatSpendHistory, formatSpendHistoryText } from "../src/spend-ledger.js";
import type { PublicFacetRecord, SpendPolicyGrant } from "../src/spend-policy.js";
import { WalletStore, type CredentialBackend } from "../src/wallet-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createMemoryBackend(): CredentialBackend {
  const map = new Map<string, string>();
  return {
    async hasSecret(service, account) {
      return map.has(`${service}:${account}`);
    },
    async getSecret(service, account) {
      return map.get(`${service}:${account}`) ?? null;
    },
    async setSecret(service, account, secret) {
      map.set(`${service}:${account}`, secret);
    },
  };
}

describe("facet wallet CLI & packaging", () => {
  it("prints human-readable output by default, supports --json, and rejects duplicate/plaintext keys", async () => {
    const backend = createMemoryBackend();
    const store = new WalletStore({ backend });
    const fujiClient: FujiRpcClient = {
      getChainId: vi.fn(async () => 43113),
      readFusdBalance: vi.fn(async () => 1000n),
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const createCode = await runCli(["wallet", "create"], {
      walletStore: store,
      fujiClient,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(createCode).toBe(0);
    expect(stderr).toEqual([]);
    const createText = stdout.join("\n");
    expect(createText).toContain("FACET Wallet Created");
    expect(createText).toMatch(/0x[a-fA-F0-9]{40}/u);
    expect(() => JSON.parse(createText)).toThrow();
    expect(createText).not.toMatch(/0x[a-fA-F0-9]{64}/u);

    const addressMatch = createText.match(/0x[a-fA-F0-9]{40}/u);
    expect(addressMatch).not.toBeNull();
    const expectedAddress = addressMatch![0];

    const statusOut: string[] = [];
    const statusCode = await runCli(["wallet", "status"], {
      walletStore: store,
      fujiClient,
      stdout: (line) => statusOut.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(statusCode).toBe(0);
    const statusText = statusOut.join("\n");
    expect(statusText).toContain("FACET Wallet Status");
    expect(statusText).toContain(expectedAddress);
    expect(statusText).toContain("0.001000 fUSD (1000 atomic)");
    expect(() => JSON.parse(statusText)).toThrow();
    expect(statusText).not.toMatch(/0x[a-fA-F0-9]{64}/u);

    const statusJsonOut: string[] = [];
    const statusJsonCode = await runCli(["wallet", "status", "--json"], {
      walletStore: store,
      fujiClient,
      stdout: (line) => statusJsonOut.push(line),
      stderr: (line) => stderr.push(line),
    });
    expect(statusJsonCode).toBe(0);
    const statusJson = JSON.parse(statusJsonOut[0]!) as Record<string, unknown>;
    expect(statusJson.address).toBe(expectedAddress);
    expect(statusJson.balanceAtomic).toBe("1000");
    expect(statusJson.balanceFormatted).toBe("0.001000");

    const dupErr: string[] = [];
    const dupCode = await runCli(["wallet", "create"], {
      walletStore: store,
      fujiClient,
      stdout: () => {},
      stderr: (line) => dupErr.push(line),
    });
    expect(dupCode).toBe(1);
    expect(dupErr.join("\n")).toContain("WALLET_ALREADY_EXISTS");
  });

  it("imports via secure prompt (human-readable default + --json) and rejects private keys passed in argv", async () => {
    const testKey = ("0x" + "2".repeat(64)) as `0x${string}`;
    const expectedAddress = privateKeyToAccount(testKey).address;

    const forbiddenErr: string[] = [];
    const forbiddenCode = await runCli(
      ["wallet", "import", "--private-key", testKey],
      {
        walletStore: new WalletStore({ backend: createMemoryBackend() }),
        promptSecret: async () => testKey,
        stdout: () => {},
        stderr: (line) => forbiddenErr.push(line),
      },
    );
    expect(forbiddenCode).toBe(1);
    expect(forbiddenErr.join("\n")).toContain("PRIVATE_KEY_ARG_FORBIDDEN");
    expect(forbiddenErr.join("\n")).not.toContain(testKey.slice(2));

    const positionalErr: string[] = [];
    const positionalCode = await runCli(["wallet", "import", testKey], {
      walletStore: new WalletStore({ backend: createMemoryBackend() }),
      promptSecret: async () => testKey,
      stdout: () => {},
      stderr: (line) => positionalErr.push(line),
    });
    expect(positionalCode).toBe(1);
    expect(positionalErr.join("\n")).toContain("PRIVATE_KEY_ARG_FORBIDDEN");
    expect(positionalErr.join("\n")).not.toContain(testKey.slice(2));

    const importOut: string[] = [];
    const importCode = await runCli(["wallet", "import"], {
      walletStore: new WalletStore({ backend: createMemoryBackend() }),
      promptSecret: async () => testKey,
      stdout: (line) => importOut.push(line),
      stderr: () => {},
    });
    expect(importCode).toBe(0);
    expect(importOut[0]).toContain("FACET Wallet Imported");
    expect(importOut[0]).toContain(expectedAddress);
    expect(() => JSON.parse(importOut[0]!)).toThrow();
    expect(importOut.join("\n")).not.toContain(testKey.slice(2));

    const importJsonOut: string[] = [];
    const importJsonCode = await runCli(["wallet", "import", "--json"], {
      walletStore: new WalletStore({ backend: createMemoryBackend() }),
      promptSecret: async () => testKey,
      stdout: (line) => importJsonOut.push(line),
      stderr: () => {},
    });
    expect(importJsonCode).toBe(0);
    expect(JSON.parse(importJsonOut[0]!)).toEqual({
      address: expectedAddress,
      chainId: 43113,
      network: "eip155:43113",
      imported: true,
    });
  });

  it("publishes @facet-aex/cli with clean tarball contents and Node >=22 support", () => {
    const pkgDir = resolve(import.meta.dirname, "..");
    const pkg = JSON.parse(
      readFileSync(resolve(pkgDir, "package.json"), "utf8"),
    ) as {
      name: string;
      private: boolean;
      bin: Record<string, string>;
      files?: string[];
      engines: { node: string };
    };

    expect(pkg.name).toBe("@facet-aex/cli");
    expect(pkg.private).toBe(false);
    expect(pkg.bin.facet).toBe("dist/cli.js");
    expect(pkg.files).toEqual(["dist", "README.md"]);
    expect(pkg.engines.node).toBe(">=22.0.0");

    const packJson = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: pkgDir,
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const paths = packJson[0]!.files.map((entry) => entry.path);
    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("dist/cli-format.js");
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/wallet-store.js");
    expect(paths).toContain("dist/fuji-wallet.js");
    expect(paths).toContain("dist/spend-policy.js");
    expect(paths).toContain("dist/spend-ledger.js");
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
    expect(paths.some((p) => p.includes(".superpowers"))).toBe(false);
  });

  it("uses Avalanche copy (zero Fuji) across all CLI formatters and wallet import prompt", async () => {
    const testKey = ("0x" + "2".repeat(64)) as `0x${string}`;
    const address = privateKeyToAccount(testKey).address;
    const prompts: string[] = [];

    await runCli(["wallet", "import"], {
      walletStore: new WalletStore({ backend: createMemoryBackend() }),
      promptSecret: async (prompt) => {
        prompts.push(prompt);
        return testKey;
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(prompts[0]).toContain("Avalanche");
    expect(prompts[0]).not.toMatch(/\bfuji\b/iu);

    const status = await readFujiWalletStatus(address, {
      client: {
        getChainId: async () => 43113,
        readFusdBalance: async () => 1_000_000n,
      },
    });
    const payTo = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
    const facets: PublicFacetRecord[] = [
      {
        provider: "tai-hung-dev",
        facetName: "echo-actor",
        facetDisplayName: "Echo Actor",
        version: "1.0.0",
        facetType: "ACTOR",
        description: "Runs code",
        pricing: {
          model: "PAY_PER_RUN",
          priceAtomic: "1000",
          maxAmountAtomic: "1000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo,
          isPrimary: true,
        },
        pricingOptions: [
          {
            model: "PAY_PER_RUN",
            priceAtomic: "1000",
            maxAmountAtomic: "1000",
            assetAddress: FUSD_ASSET_ADDRESS,
            chainId: FUJI_CHAIN_ID,
            payTo,
            isPrimary: true,
          },
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "500",
            maxItemsCap: 10,
            maxAmountAtomic: "5000",
            assetAddress: FUSD_ASSET_ADDRESS,
            chainId: FUJI_CHAIN_ID,
            payTo,
            isPrimary: false,
          },
        ],
        actorMeta: {
          runtime: "nodejs22-alpine-v1",
          imageDigest: "sha256:" + "a".repeat(64),
          registryTxHash: "0x" + "1".repeat(64),
          registryVerified: true,
        },
      },
      {
        provider: "tai-hung-dev",
        facetName: "analyst-agent",
        facetDisplayName: "Analyst Agent",
        version: "1.0.0",
        facetType: "AGENT",
        agentMeta: {
          erc8004ChainId: 43113,
          erc8004Registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
          erc8004TokenId: "42",
          taskKind: "analysis",
          registryTxHash: "0x" + "2".repeat(64),
          registryVerified: true,
        },
      },
      {
        provider: "tai-hung-dev",
        facetName: "prices-api",
        facetDisplayName: "Prices API",
        version: "1.0.0",
        facetType: "API",
        apiMeta: {
          method: "GET",
          pathTemplate: "/v1/prices",
          datasetPath: "data.items",
          registryTxHash: "0x" + "3".repeat(64),
          registryVerified: true,
        },
      },
    ];

    const grant: SpendPolicyGrant = {
      provider: "tai-hung-dev",
      facetName: "echo-actor",
      facetDisplayName: "Echo Actor",
      version: "1.0.0",
      facetType: "ACTOR",
      chainId: 43113,
      network: "eip155:43113",
      assetAddress: FUSD_ASSET_ADDRESS,
      settlementContract: FACET_FEE_SPLIT_ADDRESS,
      providerPayTo: payTo,
      pricingModel: "PAY_PER_RESULT",
      pinnedPriceAtomic: "500",
      pricingOptions: [
        {
          model: "PAY_PER_RESULT",
          priceAtomic: "500",
          maxItemsCap: 10,
          maxAmountAtomic: "5000",
        },
      ],
      maxPerRunAtomic: "1000",
      dailyCapAtomic: "10000",
      dayBoundary: "UTC",
      expiresAt: "2030-01-01T00:00:00Z",
      registryTxHash: "0x" + "1".repeat(64),
      grantedAt: "2026-11-20T00:00:00Z",
    };

    const report = formatSpendHistory([
      {
        runKey: "k1",
        provider: "tai-hung-dev",
        facetName: "echo-actor",
        facetDisplayName: "Echo Actor",
        version: "1.0.0",
        facetType: "ACTOR",
        pricingModel: "PAY_PER_RESULT",
        amountAtomic: "1500",
        depositedAmountAtomic: "5000",
        refundAmountAtomic: "3500",
        itemCount: 3,
        status: "SETTLED",
        utcDay: "2026-11-20",
        paymentTxHash: "0x" + "4".repeat(64),
        receiptTxHash: "0x" + "5".repeat(64),
        depositTxHash: "0x" + "6".repeat(64),
        createdAt: "2026-11-20T00:00:00Z",
        updatedAt: "2026-11-20T00:01:00Z",
      },
    ]);

    const outputs = [
      formatWalletCreateText("staging", {
        address,
        chainId: 43113,
        network: "eip155:43113",
        created: true,
      }),
      formatWalletImportText("staging", {
        address,
        chainId: 43113,
        network: "eip155:43113",
        imported: true,
      }),
      formatWalletStatusText("staging", status),
      formatFacetSearchText(facets),
      ...facets.map((f) => formatFacetInspectText(f)),
      formatPolicyGrantText("staging", grant),
      formatPolicyShowText({
        profile: "staging",
        dayBoundary: "UTC",
        policies: [grant],
      }),
      formatPolicyRevokeText("staging", { revoked: true, count: 1 }),
      formatPolicyPruneText("staging", { pruned: 1 }),
      formatMcpInstallText({
        client: "antigravity",
        method: "file",
        configPath: "/tmp/mcp_config.json",
        spec: {
          name: "facet",
          command: "npx",
          args: ["-y", "@facet-aex/mcp-server@0.3.0"],
          env: {
            FACET_CONTROL_API_URL: "https://staging.facet.briandev.space",
            FACET_GATEWAY_URL: "https://staging.facet.briandev.space",
            FACET_PROFILE: "staging",
          },
        },
      }),
      formatPublishActorText({
        provider: "tai-hung-dev",
        facetName: "echo-actor",
        version: "1.0.0",
        facetDisplayName: "Echo Actor",
        facetType: "ACTOR",
        status: "PUBLISHED",
      }),
      formatSpendHistoryText("staging", report),
      formatCliHelpText(),
    ];

    for (const out of outputs) {
      expect(out).not.toMatch(/\bfuji\b/iu);
    }
    expect(outputs[2]).toContain("Avalanche");
    expect(outputs[2]).toContain("/faucet");
  });

  it("parses --pricing-model PAY_PER_RESULT on facet policy grant and prints warnings when maxPerRunAtomic < maxAmountAtomic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facet-cli-grant-test-"));
    tempDirs.push(dir);
    const payTo = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
    const dualFacet: PublicFacetRecord = {
      provider: "tai-hung-dev",
      facetName: "vn-tech-news-actor",
      facetDisplayName: "VN Tech & Macro News Extractor",
      version: "1.0.0",
      facetType: "ACTOR",
      pricing: {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxAmountAtomic: "1000",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo,
        isPrimary: true,
      },
      pricingOptions: [
        {
          model: "PAY_PER_RUN",
          priceAtomic: "1000",
          maxAmountAtomic: "1000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo,
          isPrimary: true,
        },
        {
          model: "PAY_PER_RESULT",
          priceAtomic: "500",
          maxItemsCap: 10,
          maxAmountAtomic: "5000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo,
          isPrimary: false,
        },
      ],
      actorMeta: {
        runtime: "nodejs22-alpine-v1",
        imageDigest: "sha256:" + "a".repeat(64),
        registryTxHash: "0x" + "1".repeat(64),
        registryVerified: true,
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ facet: dualFacet }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const stdout: string[] = [];
    const code = await runCli(
      [
        "policy",
        "grant",
        "--facet",
        "tai-hung-dev/vn-tech-news-actor",
        "--pricing-model",
        "PAY_PER_RESULT",
        "--max-per-run",
        "1000",
        "--daily-cap",
        "10000",
        "--origin",
        "https://staging.facet.briandev.space",
        "--profile",
        "staging",
      ],
      {
        env: { ...process.env, FACET_CONFIG_DIR: dir },
        stdout: (line) => stdout.push(line),
        stderr: (line) => {
          throw new Error(`Unexpected stderr: ${line}`);
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout[0]).toContain("PAY_PER_RESULT");
    expect(stdout[0]).toContain("Warning:");
    expect(stdout[0]).toContain("5000");
    expect(stdout[0]).not.toMatch(/\bfuji\b/iu);

    const saved = JSON.parse(
      await readFileAsync(join(dir, "profiles", "staging", "policies.json"), "utf8"),
    ) as { policies: SpendPolicyGrant[] };
    expect(saved.policies).toHaveLength(1);
    expect(saved.policies[0]?.pricingModel).toBe("PAY_PER_RESULT");
    expect(saved.policies[0]?.pricingOptions).toEqual([
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 10,
        maxAmountAtomic: "5000",
      },
    ]);
  });
});
