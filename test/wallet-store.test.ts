import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  MacOsKeychainBackend,
  WalletStore,
  WalletStoreError,
  redactSecrets,
  type CredentialBackend,
} from "../src/wallet-store.js";
import {
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
  formatFusdAtomic,
  readFujiWalletStatus,
  type FujiRpcClient,
} from "../src/fuji-wallet.js";

function createMemoryBackend(initial?: Record<string, string>): CredentialBackend {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async hasSecret(service, account) {
      return map.has(`${service}:${account}`);
    },
    async getSecret(service, account) {
      return map.get(`${service}:${account}`) ?? null;
    },
    async setSecret(service, account, secret) {
      const key = `${service}:${account}`;
      if (map.has(key)) {
        throw new Error("Duplicate keychain entry");
      }
      map.set(key, secret);
    },
  };
}

describe("WalletStore", () => {
  it("creates a dedicated Fuji EOA without returning or leaking the private key", async () => {
    const backend = createMemoryBackend();
    const store = new WalletStore({ backend });

    const created = await store.createWallet();

    expect(created.address).toMatch(/^0x[a-fA-F0-9]{40}$/u);
    expect(created.chainId).toBe(FUJI_CHAIN_ID);
    expect(created.network).toBe("eip155:43113");
    expect(created.created).toBe(true);
    expect(JSON.stringify(created)).not.toMatch(/0x[a-fA-F0-9]{64}/u);
    expect(await store.getWalletAddress()).toBe(created.address);
  });

  it("rejects duplicate wallet creation without overwriting the existing key", async () => {
    const backend = createMemoryBackend();
    const store = new WalletStore({ backend });
    const first = await store.createWallet();
    const storedBefore = await backend.getSecret(
      store.serviceName,
      store.accountName,
    );

    await expect(store.createWallet()).rejects.toMatchObject({
      code: "WALLET_ALREADY_EXISTS",
    });

    const storedAfter = await backend.getSecret(
      store.serviceName,
      store.accountName,
    );
    expect(storedAfter).toBe(storedBefore);
    expect(await store.getWalletAddress()).toBe(first.address);
  });

  it("imports a private key, validates format, and never leaks the secret in errors", async () => {
    const testKey = ("0x" + "1".repeat(64)) as `0x${string}`;
    const expectedAddress = privateKeyToAccount(testKey).address;
    const backend = createMemoryBackend();
    const store = new WalletStore({ backend });

    const imported = await store.importWallet(testKey);
    expect(imported).toEqual({
      address: expectedAddress,
      chainId: 43113,
      network: "eip155:43113",
      imported: true,
    });
    expect(JSON.stringify(imported)).not.toContain(testKey.slice(2));

    const badSecret = "0x" + "z".repeat(64);
    await expect(store.importWallet(badSecret)).rejects.toMatchObject({
      code: "INVALID_PRIVATE_KEY",
    });
    try {
      await store.importWallet(badSecret);
    } catch (error) {
      expect((error as Error).message).not.toContain(badSecret);
    }

    await expect(store.importWallet(testKey)).rejects.toMatchObject({
      code: "WALLET_ALREADY_EXISTS",
    });
  });

  it("throws WALLET_NOT_FOUND when credential is missing", async () => {
    const store = new WalletStore({ backend: createMemoryBackend() });

    await expect(store.getWalletAddress()).rejects.toBeInstanceOf(
      WalletStoreError,
    );
    await expect(store.getWalletAddress()).rejects.toMatchObject({
      code: "WALLET_NOT_FOUND",
    });
    await expect(store.loadWalletAccount()).rejects.toMatchObject({
      code: "WALLET_NOT_FOUND",
    });
  });

  it("stores credentials via macOS security -i stdin without passing secret in argv or env", async () => {
    const testKey = ("0x" + "a".repeat(64)) as `0x${string}`;
    const calls: Array<{
      command: string;
      args: string[];
      stdin: string | undefined;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];

    const backend = new MacOsKeychainBackend({
      platform: "darwin",
      runCommand: async (command, args, options) => {
        calls.push({
          command,
          args,
          stdin: options?.stdin,
          env: options?.env,
        });
        if (args[0] === "find-generic-password") {
          return { exitCode: 44, stdout: "", stderr: "SecKeychainSearchCopyNext: item not found" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await backend.setSecret("space.briandev.facet.cli.wallet", "default", testKey);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("/usr/bin/security");
    expect(call.args).toEqual(["-i"]);
    expect(call.args.join(" ")).not.toContain(testKey);
    expect(JSON.stringify(call.env ?? {})).not.toContain(testKey);
    expect(call.stdin).toContain("add-generic-password");
    expect(call.stdin).toContain(testKey);
  });

  it("redacts 64-hex secrets from backend error messages and rejects non-darwin platforms", async () => {
    const testKey = ("0x" + "b".repeat(64)) as `0x${string}`;
    expect(redactSecrets(`boom ${testKey}`, [testKey])).not.toContain(
      testKey.slice(2),
    );

    const failBackend = new MacOsKeychainBackend({
      platform: "darwin",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: `keychain error near ${testKey}`,
      }),
    });

    let caught: unknown;
    try {
      await failBackend.setSecret(
        "space.briandev.facet.cli.wallet",
        "default",
        testKey,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WalletStoreError);
    expect((caught as Error).message).not.toContain(testKey.slice(2));

    const linuxBackend = new MacOsKeychainBackend({ platform: "linux" });
    await expect(
      linuxBackend.hasSecret("space.briandev.facet.cli.wallet", "default"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM_KEYCHAIN" });
  });
});

describe("Fuji wallet status", () => {
  it("formats atomic fUSD balances without floating point drift", () => {
    expect(formatFusdAtomic(0n)).toBe("0.000000");
    expect(formatFusdAtomic(1000n)).toBe("0.001000");
    expect(formatFusdAtomic(12345678n)).toBe("12.345678");
  });

  it("reads fUSD balance on Fuji 43113 and rejects wrong chain IDs", async () => {
    const address = "0xFA8cCB3C5145fca08f22675ea740e89B1D3a317f" as const;
    const fujiClient: FujiRpcClient = {
      getChainId: vi.fn(async () => 43113),
      readFusdBalance: vi.fn(async (addr, asset) => {
        expect(addr).toBe(address);
        expect(asset).toBe(FUSD_ASSET_ADDRESS);
        return 250000n;
      }),
    };

    const status = await readFujiWalletStatus(address, { client: fujiClient });
    expect(status).toEqual({
      address,
      chainId: 43113,
      network: "eip155:43113",
      assetAddress: FUSD_ASSET_ADDRESS,
      symbol: "fUSD",
      decimals: 6,
      balanceAtomic: "250000",
      balanceFormatted: "0.250000",
      fundingNote:
        "Fund this Avalanche wallet with testnet fUSD via /faucet on FACET or an explicit transfer.",
    });
    expect(status.fundingNote).not.toMatch(/\bfuji\b/iu);

    const wrongChainClient: FujiRpcClient = {
      getChainId: vi.fn(async () => 43114),
      readFusdBalance: vi.fn(async () => 0n),
    };

    let wrongChainErr: unknown;
    try {
      await readFujiWalletStatus(address, { client: wrongChainClient });
    } catch (error) {
      wrongChainErr = error;
    }
    expect(wrongChainErr).toMatchObject({ code: "WRONG_CHAIN_ID" });
    expect((wrongChainErr as Error).message).not.toMatch(/\bfuji\b/iu);

    const rpcFailClient: FujiRpcClient = {
      getChainId: vi.fn(async () => {
        throw new Error("RPC down");
      }),
      readFusdBalance: vi.fn(async () => 0n),
    };
    let rpcErr: unknown;
    try {
      await readFujiWalletStatus(address, { client: rpcFailClient });
    } catch (error) {
      rpcErr = error;
    }
    expect(rpcErr).toMatchObject({ code: "FUJI_RPC_ERROR" });
    expect((rpcErr as Error).message).not.toMatch(/\bfuji\b/iu);
  });
});
