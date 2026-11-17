#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FACET_ORIGIN,
  FacetClient,
  WalletStore,
  WalletStoreError,
  readFujiWalletStatus,
  redactSecrets,
  type FacetType,
  type FujiRpcClient,
} from "./index.js";

export interface CliDependencies {
  walletStore?: WalletStore;
  fujiClient?: FujiRpcClient;
  promptSecret?: (prompt: string) => Promise<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

const FORBIDDEN_KEY_FLAGS = [
  "--private-key",
  "--key",
  "--secret",
  "-k",
] as const;

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function assertNoSecretInArgv(args: string[]): void {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (
      FORBIDDEN_KEY_FLAGS.some(
        (flag) => lower === flag || lower.startsWith(`${flag}=`),
      ) ||
      /^0x[0-9a-f]{64}$/iu.test(arg) ||
      /^[0-9a-f]{64}$/iu.test(arg)
    ) {
      throw new WalletStoreError(
        "PRIVATE_KEY_ARG_FORBIDDEN",
        "Private keys must never be passed on the command line. Use the interactive prompt in `facet wallet import`.",
      );
    }
  }
}

async function defaultPromptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    });
    try {
      for await (const line of rl) {
        return line.trim();
      }
      return "";
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let buffer = "";
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Prompt cancelled."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(buffer.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    stdin.on("data", onData);
  });
}

function formatCliError(error: unknown): string {
  if (error instanceof WalletStoreError) {
    return `${error.code}: ${redactSecrets(error.message)}`;
  }
  if (error && typeof error === "object" && "code" in error && error instanceof Error) {
    return `${String((error as { code: unknown }).code)}: ${redactSecrets(error.message)}`;
  }
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export async function runCli(
  argv: string[],
  deps: CliDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const [command, ...rest] = argv;

  try {
    if (command === "wallet") {
      const [subcommand, ...subRest] = rest;
      assertNoSecretInArgv(subRest);
      const walletStore = deps.walletStore ?? new WalletStore();

      if (subcommand === "create") {
        const result = await walletStore.createWallet();
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }

      if (subcommand === "import") {
        const promptSecret = deps.promptSecret ?? defaultPromptSecret;
        const rawKey = await promptSecret(
          "Enter Fuji private key (0x..., input hidden): ",
        );
        const result = await walletStore.importWallet(rawKey);
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }

      if (subcommand === "status") {
        const address = await walletStore.getWalletAddress();
        const status = await readFujiWalletStatus(address, {
          ...(deps.fujiClient ? { client: deps.fujiClient } : {}),
          ...(env.FACET_FUJI_RPC_URL ? { rpcUrl: env.FACET_FUJI_RPC_URL } : {}),
        });
        stdout(JSON.stringify(status, null, 2));
        return 0;
      }

      stderr("Usage: facet wallet <create|import|status>");
      return 1;
    }

    const controlApiUrl =
      env.FACET_CONTROL_API_URL ?? DEFAULT_FACET_ORIGIN;
    const client = new FacetClient({
      controlApiUrl,
      ...(env.FACET_GATEWAY_URL ? { gatewayUrl: env.FACET_GATEWAY_URL } : {}),
      ...(env.FACET_DEV_USER ? { devUser: env.FACET_DEV_USER } : {}),
      ...(env.FACET_BEARER_TOKEN ? { bearerToken: env.FACET_BEARER_TOKEN } : {}),
    });

    if (command === "search") {
      const query = rest[0] && !rest[0].startsWith("--") ? rest[0] : "";
      const type = argValue(rest, "--type") as FacetType | undefined;
      const category = argValue(rest, "--category");
      const facets = await client.searchFacets({ query, type, category });
      stdout(JSON.stringify({ facets }, null, 2));
      return 0;
    }

    if (command === "inspect" && rest[0]) {
      const facet = await client.getFacet(rest[0]);
      stdout(JSON.stringify({ facet }, null, 2));
      return 0;
    }

    if (command === "publish-actor") {
      const filePath = argValue(rest, "--file");
      if (!filePath) throw new Error("--file <actor-manifest.json> is required");
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Parameters<
        FacetClient["publishActor"]
      >[0];
      const facet = await client.publishActor(raw);
      stdout(JSON.stringify({ facet }, null, 2));
      return 0;
    }

    stderr(
      "Usage: facet <wallet <create|import|status> | search [query] [--type HOSTED_ACTOR|AUTONOMOUS_AGENT|EXTERNAL_HTTP_API] | inspect <facetId> | publish-actor --file <json>>",
    );
    return 1;
  } catch (error) {
    stderr(formatCliError(error));
    return 1;
  }
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
