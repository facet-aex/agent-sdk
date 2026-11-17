import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { runCli } from "../src/cli.js";
import { WalletStore, type CredentialBackend } from "../src/wallet-store.js";
import type { FujiRpcClient } from "../src/fuji-wallet.js";

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
  it("handles wallet create, status, and duplicate rejection without printing secrets", async () => {
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
    const created = JSON.parse(stdout[0]!) as {
      address: string;
      chainId: number;
      network: string;
      created: boolean;
    };
    expect(created.address).toMatch(/^0x[a-fA-F0-9]{40}$/u);
    expect(created.chainId).toBe(43113);
    expect(created.created).toBe(true);
    expect(stdout.join("\n")).not.toMatch(/0x[a-fA-F0-9]{64}/u);

    const statusOut: string[] = [];
    const statusCode = await runCli(["wallet", "status"], {
      walletStore: store,
      fujiClient,
      stdout: (line) => statusOut.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(statusCode).toBe(0);
    const status = JSON.parse(statusOut[0]!) as Record<string, unknown>;
    expect(status.address).toBe(created.address);
    expect(status.balanceAtomic).toBe("1000");
    expect(status.balanceFormatted).toBe("0.001000");
    expect(statusOut.join("\n")).not.toMatch(/0x[a-fA-F0-9]{64}/u);

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

  it("imports via secure prompt and rejects private keys passed in argv", async () => {
    const testKey = ("0x" + "2".repeat(64)) as `0x${string}`;
    const expectedAddress = privateKeyToAccount(testKey).address;
    const backend = createMemoryBackend();
    const store = new WalletStore({ backend });

    const forbiddenErr: string[] = [];
    const forbiddenCode = await runCli(
      ["wallet", "import", "--private-key", testKey],
      {
        walletStore: store,
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
      walletStore: store,
      promptSecret: async () => testKey,
      stdout: () => {},
      stderr: (line) => positionalErr.push(line),
    });
    expect(positionalCode).toBe(1);
    expect(positionalErr.join("\n")).toContain("PRIVATE_KEY_ARG_FORBIDDEN");
    expect(positionalErr.join("\n")).not.toContain(testKey.slice(2));

    const importOut: string[] = [];
    const importCode = await runCli(["wallet", "import"], {
      walletStore: store,
      promptSecret: async () => testKey,
      stdout: (line) => importOut.push(line),
      stderr: () => {},
    });
    expect(importCode).toBe(0);
    expect(JSON.parse(importOut[0]!)).toEqual({
      address: expectedAddress,
      chainId: 43113,
      network: "eip155:43113",
      imported: true,
    });
    expect(importOut.join("\n")).not.toContain(testKey.slice(2));
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
    expect(pkg.bin.facet).toBe("./dist/cli.js");
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
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/wallet-store.js");
    expect(paths).toContain("dist/fuji-wallet.js");
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
    expect(paths.some((p) => p.includes(".superpowers"))).toBe(false);
  });
});
