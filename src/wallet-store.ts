import { spawn } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";

export const DEFAULT_WALLET_SERVICE = "space.briandev.facet.cli.wallet";
export const DEFAULT_WALLET_ACCOUNT = "default";
export const FUJI_WALLET_CHAIN_ID = 43113 as const;
export const FUJI_WALLET_NETWORK = "eip155:43113" as const;

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/u;
const SAFE_KEYCHAIN_TOKEN = /^[a-zA-Z0-9._-]+$/u;

export type WalletStoreErrorCode =
  | "WALLET_NOT_FOUND"
  | "WALLET_ALREADY_EXISTS"
  | "INVALID_PRIVATE_KEY"
  | "KEYCHAIN_ERROR"
  | "UNSUPPORTED_PLATFORM_KEYCHAIN"
  | "PRIVATE_KEY_ARG_FORBIDDEN";

export class WalletStoreError extends Error {
  constructor(
    public readonly code: WalletStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletStoreError";
  }
}

export function redactSecrets(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  let sanitized = text;
  for (const secret of knownSecrets) {
    if (!secret) continue;
    sanitized = sanitized.split(secret).join("[REDACTED]");
    const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
    if (bare.length >= 16) {
      sanitized = sanitized.split(bare).join("[REDACTED]");
    }
  }
  return sanitized.replace(/0x[0-9a-fA-F]{64}/gu, "[REDACTED]");
}

export interface CredentialBackend {
  hasSecret(service: string, account: string): Promise<boolean>;
  getSecret(service: string, account: string): Promise<string | null>;
  setSecret(service: string, account: string, secret: string): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SecurityCommandRunner = (
  command: string,
  args: string[],
  options?: { stdin?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

function defaultSecurityRunner(
  command: string,
  args: string[],
  options?: { stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options?.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin, "utf8");
    }
    child.stdin.end();
  });
}

function assertSafeKeychainIdentifier(value: string, label: string): void {
  if (!SAFE_KEYCHAIN_TOKEN.test(value)) {
    throw new WalletStoreError(
      "KEYCHAIN_ERROR",
      `Invalid keychain ${label} identifier.`,
    );
  }
}

export class MacOsKeychainBackend implements CredentialBackend {
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: SecurityCommandRunner;

  constructor(options?: {
    platform?: NodeJS.Platform;
    runCommand?: SecurityCommandRunner;
  }) {
    this.platform = options?.platform ?? process.platform;
    this.runCommand = options?.runCommand ?? defaultSecurityRunner;
  }

  private assertDarwin(): void {
    if (this.platform !== "darwin") {
      throw new WalletStoreError(
        "UNSUPPORTED_PLATFORM_KEYCHAIN",
        `macOS Keychain credential store requires darwin (current platform: ${this.platform}).`,
      );
    }
  }

  async hasSecret(service: string, account: string): Promise<boolean> {
    this.assertDarwin();
    assertSafeKeychainIdentifier(service, "service");
    assertSafeKeychainIdentifier(account, "account");
    const result = await this.runCommand("/usr/bin/security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 44) return false;
    throw new WalletStoreError(
      "KEYCHAIN_ERROR",
      redactSecrets(
        `Keychain lookup failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      ),
    );
  }

  async getSecret(service: string, account: string): Promise<string | null> {
    this.assertDarwin();
    assertSafeKeychainIdentifier(service, "service");
    assertSafeKeychainIdentifier(account, "account");
    const result = await this.runCommand("/usr/bin/security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      "-w",
    ]);
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) {
      throw new WalletStoreError(
        "KEYCHAIN_ERROR",
        redactSecrets(
          `Keychain read failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        ),
      );
    }
    const secret = result.stdout.trim();
    return secret.length > 0 ? secret : null;
  }

  async setSecret(
    service: string,
    account: string,
    secret: string,
  ): Promise<void> {
    this.assertDarwin();
    assertSafeKeychainIdentifier(service, "service");
    assertSafeKeychainIdentifier(account, "account");
    if (!PRIVATE_KEY_REGEX.test(secret)) {
      throw new WalletStoreError(
        "INVALID_PRIVATE_KEY",
        "Private key must be a 32-byte 0x-prefixed hex string.",
      );
    }
    // Feed add-generic-password over stdin (`security -i`) so the secret never enters process argv.
    const result = await this.runCommand(
      "/usr/bin/security",
      ["-i"],
      {
        stdin: `add-generic-password -a ${account} -s ${service} -w ${secret}\n`,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    );
    if (result.exitCode !== 0) {
      throw new WalletStoreError(
        "KEYCHAIN_ERROR",
        redactSecrets(
          `Keychain write failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
          [secret],
        ),
      );
    }
  }
}

export interface WalletCreateResult {
  address: `0x${string}`;
  chainId: 43113;
  network: "eip155:43113";
  created: true;
}

export interface WalletImportResult {
  address: `0x${string}`;
  chainId: 43113;
  network: "eip155:43113";
  imported: true;
}

export class WalletStore {
  public readonly serviceName: string;
  public readonly accountName: string;
  private readonly backend: CredentialBackend;

  constructor(options?: {
    serviceName?: string;
    accountName?: string;
    backend?: CredentialBackend;
  }) {
    this.serviceName =
      options?.serviceName ??
      process.env.FACET_WALLET_SERVICE ??
      DEFAULT_WALLET_SERVICE;
    this.accountName =
      options?.accountName ??
      process.env.FACET_WALLET_ACCOUNT ??
      DEFAULT_WALLET_ACCOUNT;
    this.backend = options?.backend ?? new MacOsKeychainBackend();
  }

  async hasWallet(): Promise<boolean> {
    return this.backend.hasSecret(this.serviceName, this.accountName);
  }

  async createWallet(): Promise<WalletCreateResult> {
    if (await this.hasWallet()) {
      throw new WalletStoreError(
        "WALLET_ALREADY_EXISTS",
        "A FACET buyer wallet already exists in the credential store. Refusing to overwrite it.",
      );
    }
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    await this.backend.setSecret(this.serviceName, this.accountName, privateKey);
    return {
      address: account.address,
      chainId: FUJI_WALLET_CHAIN_ID,
      network: FUJI_WALLET_NETWORK,
      created: true,
    };
  }

  async importWallet(rawPrivateKey: string): Promise<WalletImportResult> {
    const normalized = rawPrivateKey.trim();
    if (!PRIVATE_KEY_REGEX.test(normalized)) {
      throw new WalletStoreError(
        "INVALID_PRIVATE_KEY",
        "Private key must be a 32-byte 0x-prefixed hex string.",
      );
    }
    if (await this.hasWallet()) {
      throw new WalletStoreError(
        "WALLET_ALREADY_EXISTS",
        "A FACET buyer wallet already exists in the credential store. Refusing to overwrite it.",
      );
    }
    const typedKey = normalized.toLowerCase() as `0x${string}`;
    const account = privateKeyToAccount(typedKey);
    await this.backend.setSecret(this.serviceName, this.accountName, typedKey);
    return {
      address: account.address,
      chainId: FUJI_WALLET_CHAIN_ID,
      network: FUJI_WALLET_NETWORK,
      imported: true,
    };
  }

  async loadWalletAccount(): Promise<PrivateKeyAccount> {
    const secret = await this.backend.getSecret(
      this.serviceName,
      this.accountName,
    );
    if (!secret) {
      throw new WalletStoreError(
        "WALLET_NOT_FOUND",
        "No FACET buyer wallet found in the credential store. Run `facet wallet create` or `facet wallet import` first.",
      );
    }
    const normalized = secret.trim();
    if (!PRIVATE_KEY_REGEX.test(normalized)) {
      throw new WalletStoreError(
        "INVALID_PRIVATE_KEY",
        "Stored wallet credential is malformed.",
      );
    }
    return privateKeyToAccount(normalized as `0x${string}`);
  }

  async getWalletAddress(): Promise<`0x${string}`> {
    const account = await this.loadWalletAccount();
    return account.address;
  }
}
