#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FACET_ORIGIN,
  FacetClient,
  PolicyStore,
  SpendLedger,
  WalletStore,
  WalletStoreError,
  defaultPolicyStorePath,
  defaultSpendLedgerPath,
  formatSpendHistory,
  formatSpendHistoryText,
  installMcpClient,
  isMcpClientName,
  isValidFacetName,
  isValidFacetType,
  isValidSemver,
  isValidUsername,
  parseFacetRef,
  readFujiWalletStatus,
  redactSecrets,
  renderMcpConfigSnippet,
  resolveProfileName,
  type FacetType,
  type FujiRpcClient,
  type SpendEntryStatus,
} from "./index.js";

export interface CliDependencies {
  walletStore?: WalletStore;
  policyStore?: PolicyStore;
  spendLedger?: SpendLedger;
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
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error instanceof Error
  ) {
    return `${String((error as { code: unknown }).code)}: ${redactSecrets(error.message)}`;
  }
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function parseOptionalPolicyFilter(subRest: string[]): {
  provider?: string;
  facetName?: string;
  version?: string;
} {
  const providerArg = argValue(subRest, "--provider");
  const facetArg = argValue(subRest, "--facet");
  const versionArg = argValue(subRest, "--version");

  if (versionArg !== undefined && !isValidSemver(versionArg)) {
    throw new Error(
      `Invalid version '${versionArg}'. Expected SemVer MAJOR.MINOR.PATCH.`,
    );
  }

  if (facetArg && facetArg.includes("/")) {
    const { provider, facetName } = parseFacetRef(facetArg, providerArg);
    return {
      provider,
      facetName,
      ...(versionArg ? { version: versionArg } : {}),
    };
  }

  if (providerArg !== undefined && !isValidUsername(providerArg)) {
    throw new Error(
      `Invalid provider '${providerArg}'. Must be 8-16 lowercase hyphenated kebab-case characters.`,
    );
  }
  if (facetArg !== undefined && !isValidFacetName(facetArg)) {
    throw new Error(
      `Invalid facetName '${facetArg}'. Must be 4-32 lowercase hyphenated kebab-case characters.`,
    );
  }

  return {
    ...(providerArg ? { provider: providerArg } : {}),
    ...(facetArg ? { facetName: facetArg } : {}),
    ...(versionArg ? { version: versionArg } : {}),
  };
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
      const profileArg = argValue(subRest, "--profile");
      const profile = resolveProfileName(profileArg, env);
      const walletStore = deps.walletStore ?? new WalletStore({ profile });

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
        stdout(JSON.stringify({ profile, ...status }, null, 2));
        return 0;
      }

      stderr("Usage: facet wallet <create|import|status> [--profile <name>]");
      return 1;
    }

    if (command === "spend") {
      const [subcommand, ...subRest] = rest;
      if (subcommand === "history") {
        const profile = resolveProfileName(
          argValue(subRest, "--profile"),
          env,
        );
        const spendLedger =
          deps.spendLedger ??
          new SpendLedger({
            filePath: defaultSpendLedgerPath(env, profile),
          });
        const statusArg = argValue(subRest, "--status") as
          | SpendEntryStatus
          | undefined;
        if (
          statusArg &&
          !["PENDING", "SETTLED", "RELEASED", "FAILED"].includes(statusArg)
        ) {
          throw new Error(
            `Invalid status '${statusArg}'. Expected PENDING, SETTLED, RELEASED, or FAILED.`,
          );
        }
        const dayArg = argValue(subRest, "--day");
        const filter = parseOptionalPolicyFilter(subRest);
        const entries = await spendLedger.list({
          ...(statusArg ? { status: statusArg } : {}),
          ...(dayArg ? { utcDay: dayArg } : {}),
          ...filter,
        });
        const report = formatSpendHistory(entries);
        if (subRest.includes("--text")) {
          stdout(formatSpendHistoryText(profile, report));
        } else {
          stdout(JSON.stringify({ profile, ...report }, null, 2));
        }
        return 0;
      }
      stderr(
        "Usage: facet spend history [--profile <name>] [--status SETTLED|PENDING|RELEASED|FAILED] [--day YYYY-MM-DD] [--provider <provider>] [--facet <facet-name>] [--version <semver>] [--text]",
      );
      return 1;
    }

    const controlApiUrl =
      argValue(rest, "--origin") ??
      env.FACET_CONTROL_API_URL ??
      DEFAULT_FACET_ORIGIN;
    const client = new FacetClient({
      controlApiUrl,
      ...(env.FACET_GATEWAY_URL ? { gatewayUrl: env.FACET_GATEWAY_URL } : {}),
      ...(env.FACET_DEV_USER ? { devUser: env.FACET_DEV_USER } : {}),
      ...(env.FACET_BEARER_TOKEN ? { bearerToken: env.FACET_BEARER_TOKEN } : {}),
    });

    if (command === "policy") {
      const [subcommand, ...subRest] = rest;
      const profile = resolveProfileName(argValue(subRest, "--profile"), env);
      const policyStore =
        deps.policyStore ??
        new PolicyStore({
          profile,
          filePath: defaultPolicyStorePath(env, profile),
        });

      if (subcommand === "grant") {
        const providerArg = argValue(subRest, "--provider");
        const facetArg = argValue(subRest, "--facet");
        const version = argValue(subRest, "--version");
        const maxPerRun = argValue(subRest, "--max-per-run");
        const dailyCap = argValue(subRest, "--daily-cap");
        const expires = argValue(subRest, "--expires");

        if (!facetArg) {
          stderr(
            "Usage: facet policy grant (--facet <provider/facet-name> | --provider <provider> --facet <facet-name>) [--version <semver>] [--max-per-run 1000] [--daily-cap 10000] [--expires <ISO8601>] [--profile <name>]",
          );
          return 1;
        }
        if (version !== undefined && !isValidSemver(version)) {
          throw new Error(
            `Invalid version '${version}'. Expected SemVer MAJOR.MINOR.PATCH.`,
          );
        }

        const { provider, facetName } = parseFacetRef(facetArg, providerArg);
        const facet = await client.resolveFacet(facetName, {
          provider,
          ...(version ? { version } : {}),
        });
        if (!facet) {
          stderr(
            `POLICY_FACET_NOT_FOUND: Facet ${provider}/${facetName}${version ? `@${version}` : ""} not found in catalog.`,
          );
          return 1;
        }
        const policy = await policyStore.grant({
          facet,
          provider,
          facetName,
          ...(version ? { version } : {}),
          ...(maxPerRun ? { maxPerRunAtomic: maxPerRun } : {}),
          ...(dailyCap ? { dailyCapAtomic: dailyCap } : {}),
          ...(expires ? { expiresAt: expires } : {}),
        });
        stdout(JSON.stringify({ profile, policy }, null, 2));
        return 0;
      }

      if (subcommand === "show") {
        const filter = parseOptionalPolicyFilter(subRest);
        const result = await policyStore.show(filter);
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }

      if (subcommand === "revoke") {
        const all = subRest.includes("--all");
        const filter = parseOptionalPolicyFilter(subRest);
        if (!all && !filter.provider && !filter.facetName && !filter.version) {
          stderr(
            "Usage: facet policy revoke (([--provider <provider>] --facet <provider/facet-name|facet-name>) [--version <semver>] | --all) [--profile <name>]",
          );
          return 1;
        }
        const result = await policyStore.revoke({
          ...filter,
          ...(all ? { all: true } : {}),
        });
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }

      if (subcommand === "prune") {
        const all = subRest.includes("--all");
        const filter = parseOptionalPolicyFilter(subRest);
        const result = await policyStore.prune({
          ...filter,
          ...(all ? { all: true } : {}),
        });
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }

      stderr(
        "Usage: facet policy <grant|show|revoke|prune> [--profile <name>]",
      );
      return 1;
    }

    if (command === "mcp") {
      const [subcommand, clientArg, ...subRest] = rest;
      const profile = resolveProfileName(argValue(subRest, "--profile"), env);
      const origin = argValue(subRest, "--origin");
      const mcpVersion = argValue(subRest, "--mcp-version");
      if (!clientArg || !isMcpClientName(clientArg)) {
        stderr(
          "Usage: facet mcp <install|config> <codex|claude|antigravity> [--profile <name>]",
        );
        return 1;
      }
      const mcpOptions = {
        profile,
        ...(origin ? { origin } : {}),
        ...(mcpVersion ? { mcpVersion } : {}),
      };
      if (subcommand === "config") {
        stdout(renderMcpConfigSnippet(clientArg, mcpOptions));
        return 0;
      }
      if (subcommand === "install") {
        const result = await installMcpClient(clientArg, mcpOptions);
        stdout(JSON.stringify(result, null, 2));
        return 0;
      }
      stderr(
        "Usage: facet mcp <install|config> <codex|claude|antigravity> [--profile <name>]",
      );
      return 1;
    }

    if (command === "search") {
      const query = rest[0] && !rest[0].startsWith("--") ? rest[0] : "";
      const rawType = argValue(rest, "--type");
      if (rawType !== undefined && !isValidFacetType(rawType)) {
        throw new Error(
          `Invalid --type '${rawType}'. Expected API, ACTOR, or AGENT.`,
        );
      }
      const type = rawType as FacetType | undefined;
      const category = argValue(rest, "--category");
      const facets = await client.searchFacets({ query, type, category });
      stdout(JSON.stringify({ facets }, null, 2));
      return 0;
    }

    if (command === "inspect") {
      const facetRefArg =
        rest[0] && !rest[0].startsWith("--")
          ? rest[0]
          : argValue(rest, "--facet");
      const providerArg = argValue(rest, "--provider");
      const versionArg = argValue(rest, "--version");
      if (!facetRefArg) {
        stderr(
          "Usage: facet inspect (<provider/facet-name> | --provider <provider> --facet <facet-name>) [--version <semver>]",
        );
        return 1;
      }
      const facet = await client.resolveFacet(facetRefArg, {
        ...(providerArg ? { provider: providerArg } : {}),
        ...(versionArg ? { version: versionArg } : {}),
      });
      if (!facet) {
        stderr(`NOT_FOUND: Facet ${facetRefArg} not found.`);
        return 1;
      }
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
      "Usage: facet <wallet <create|import|status> | policy <grant|show|revoke|prune> | spend history | mcp <install|config> <codex|claude|antigravity> | search [query] [--type API|ACTOR|AGENT] | inspect <provider/facet-name> [--version <semver>] | publish-actor --file <json>>",
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
