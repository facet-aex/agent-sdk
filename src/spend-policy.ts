import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FACET_FEE_SPLIT_ADDRESS,
  FUJI_CHAIN_ID,
  FUJI_NETWORK,
  FUSD_ASSET_ADDRESS,
} from "./fuji-wallet.js";
import {
  isValidFacetName,
  isValidFacetType,
  isValidSemver,
  isValidUsername,
  type FacetType,
} from "./identifiers.js";
import { parsePositiveAtomic } from "./spend-ledger.js";
import { resolveProfileName } from "./wallet-store.js";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/u;
const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/u;

export const DEFAULT_POLICY_MAX_PER_RUN_ATOMIC = "1000" as const;
export const DEFAULT_POLICY_DAILY_CAP_ATOMIC = "10000" as const;

export function addOneMonthUtc(from: Date = new Date()): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  const hours = from.getUTCHours();
  const minutes = from.getUTCMinutes();
  const seconds = from.getUTCSeconds();
  const ms = from.getUTCMilliseconds();

  const targetMonthIndex = month + 1;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = targetMonthIndex % 12;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      Math.min(day, lastDayOfTargetMonth),
      hours,
      minutes,
      seconds,
      ms,
    ),
  );
}

export type SpendPolicyErrorCode =
  | "POLICY_NOT_GRANTED"
  | "POLICY_REVOKED"
  | "POLICY_EXPIRED"
  | "POLICY_VERSION_MISMATCH"
  | "POLICY_CHAIN_MISMATCH"
  | "POLICY_ASSET_MISMATCH"
  | "POLICY_RECIPIENT_MISMATCH"
  | "POLICY_MAX_PER_RUN_EXCEEDED"
  | "POLICY_PRICE_MISMATCH"
  | "POLICY_INVALID"
  | "POLICY_NOT_FOUND"
  | "UNVERIFIED_FACET_REGISTRY";

export class SpendPolicyError extends Error {
  constructor(
    public readonly code: SpendPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpendPolicyError";
  }
}

export interface PublicFacetRecord {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: FacetType;
  description?: string;
  category?: string;
  tags?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  pricing?: {
    model: "PAY_PER_RUN" | "PAY_PER_RESULT";
    priceAtomic: string;
    assetAddress: string;
    chainId: number;
    payTo: string;
  };
  actorMeta?: {
    runtime: string;
    imageDigest: string;
    registryTxHash?: string;
    registryVerified?: boolean;
  };
  agentMeta?: {
    erc8004ChainId: number;
    erc8004Registry: string;
    erc8004TokenId: string;
    taskKind: string;
    registryTxHash?: string;
    registryVerified?: boolean;
  };
}

export interface SpendPolicyGrant {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: FacetType;
  chainId: 43113;
  network: "eip155:43113";
  assetAddress: string;
  settlementContract: string;
  providerPayTo: string;
  pricingModel: "PAY_PER_RUN" | "PAY_PER_RESULT";
  pinnedPriceAtomic: string;
  maxPerRunAtomic: string;
  dailyCapAtomic: string;
  dayBoundary: "UTC";
  expiresAt: string;
  registryTxHash: string;
  grantedAt: string;
  revokedAt?: string;
}

interface PolicyFile {
  version: 2;
  dayBoundary: "UTC";
  policies: SpendPolicyGrant[];
}

export interface GrantPolicyInput {
  facet: PublicFacetRecord;
  provider?: string;
  facetName?: string;
  version?: string;
  maxPerRunAtomic?: string;
  dailyCapAtomic?: string;
  expiresAt?: string;
  now?: Date;
}

export interface AuthorizeChallengeInput {
  provider: string;
  facetName: string;
  version: string;
  chainId: number;
  assetAddress: string;
  settlementPayTo: string;
  providerPayTo?: string;
  amountAtomic: string;
  now?: Date;
}

export function defaultPolicyStorePath(
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): string {
  if (env.FACET_POLICY_PATH) {
    return env.FACET_POLICY_PATH;
  }
  const baseDir = env.FACET_CONFIG_DIR ?? join(homedir(), ".config", "facet");
  const resolvedProfile = resolveProfileName(profile, env);
  return resolvedProfile === "default"
    ? join(baseDir, "policies.json")
    : join(baseDir, "profiles", resolvedProfile, "policies.json");
}

function assertVerifiedRegistry(facet: PublicFacetRecord): string {
  if (!isValidFacetType(facet.facetType)) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Unsupported facetType '${String(facet.facetType)}'. Expected API, ACTOR, or AGENT.`,
    );
  }
  if (facet.facetType === "ACTOR") {
    if (
      facet.actorMeta?.registryVerified !== true ||
      !facet.actorMeta.registryTxHash ||
      !TX_HASH_REGEX.test(facet.actorMeta.registryTxHash)
    ) {
      throw new SpendPolicyError(
        "UNVERIFIED_FACET_REGISTRY",
        "Refusing policy grant: Actor does not have a verified Fuji registry record.",
      );
    }
    return facet.actorMeta.registryTxHash;
  }
  if (facet.facetType === "AGENT") {
    if (
      facet.agentMeta?.registryVerified !== true ||
      !facet.agentMeta.registryTxHash ||
      !TX_HASH_REGEX.test(facet.agentMeta.registryTxHash)
    ) {
      throw new SpendPolicyError(
        "UNVERIFIED_FACET_REGISTRY",
        "Refusing policy grant: Agent does not have a verified Fuji registry record.",
      );
    }
    return facet.agentMeta.registryTxHash;
  }
  throw new SpendPolicyError(
    "UNVERIFIED_FACET_REGISTRY",
    `Refusing policy grant: Facet type ${facet.facetType} lacks a verified on-chain registry record.`,
  );
}

export class PolicyStore {
  public readonly profile: string;
  public readonly filePath: string;

  constructor(options?: { profile?: string; filePath?: string }) {
    this.profile = resolveProfileName(options?.profile);
    this.filePath =
      options?.filePath ?? defaultPolicyStorePath(process.env, this.profile);
  }

  private async readPolicies(): Promise<PolicyFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PolicyFile>;
      return {
        version: 2,
        dayBoundary: "UTC",
        policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 2, dayBoundary: "UTC", policies: [] };
      }
      throw error;
    }
  }

  private async writePolicies(data: PolicyFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    const handle = await open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    await rename(tmpPath, this.filePath);
  }

  async grant(input: GrantPolicyInput): Promise<SpendPolicyGrant> {
    const now = input.now ?? new Date();
    const { facet } = input;

    if (!isValidUsername(facet.provider)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Invalid provider '${facet.provider}'. Must be 8-16 lowercase hyphenated kebab-case characters.`,
      );
    }
    if (!isValidFacetName(facet.facetName)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Invalid facetName '${facet.facetName}'. Must be 4-32 lowercase hyphenated kebab-case characters.`,
      );
    }
    if (!facet.facetDisplayName || !facet.facetDisplayName.trim()) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "Catalog Facet is missing facetDisplayName.",
      );
    }
    if (!isValidSemver(facet.version)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Invalid Facet version '${facet.version}'. Expected SemVer MAJOR.MINOR.PATCH.`,
      );
    }

    if (
      (input.provider !== undefined && input.provider !== facet.provider) ||
      (input.facetName !== undefined && input.facetName !== facet.facetName)
    ) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Catalog returned ${facet.provider}/${facet.facetName}, expected ${input.provider ?? facet.provider}/${input.facetName ?? facet.facetName}.`,
      );
    }

    if (input.version !== undefined) {
      if (!isValidSemver(input.version)) {
        throw new SpendPolicyError(
          "POLICY_INVALID",
          `Requested version '${input.version}' must be SemVer MAJOR.MINOR.PATCH.`,
        );
      }
      if (facet.version !== input.version) {
        throw new SpendPolicyError(
          "POLICY_VERSION_MISMATCH",
          `Catalog returned ${facet.provider}/${facet.facetName} version ${facet.version}, expected ${input.version}.`,
        );
      }
    }

    const registryTxHash = assertVerifiedRegistry(facet);
    const pricing = facet.pricing;
    if (!pricing) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "Catalog Facet is missing pricing metadata.",
      );
    }
    if (pricing.chainId !== FUJI_CHAIN_ID) {
      throw new SpendPolicyError(
        "POLICY_CHAIN_MISMATCH",
        `Expected Fuji chainId ${FUJI_CHAIN_ID}, got ${pricing.chainId}.`,
      );
    }
    if (
      pricing.assetAddress.toLowerCase() !== FUSD_ASSET_ADDRESS.toLowerCase()
    ) {
      throw new SpendPolicyError(
        "POLICY_ASSET_MISMATCH",
        `Expected Fuji fUSD ${FUSD_ASSET_ADDRESS}, got ${pricing.assetAddress}.`,
      );
    }
    if (!ADDRESS_REGEX.test(pricing.payTo)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "Facet pricing.payTo is not a valid EVM address.",
      );
    }

    const rawMaxPerRun =
      input.maxPerRunAtomic ?? DEFAULT_POLICY_MAX_PER_RUN_ATOMIC;
    const rawDailyCap =
      input.dailyCapAtomic ?? DEFAULT_POLICY_DAILY_CAP_ATOMIC;
    const rawExpiresAt = input.expiresAt ?? addOneMonthUtc(now).toISOString();

    let pinnedPrice: bigint;
    let maxPerRun: bigint;
    let dailyCap: bigint;
    try {
      pinnedPrice = parsePositiveAtomic(pricing.priceAtomic, "priceAtomic");
      maxPerRun = parsePositiveAtomic(rawMaxPerRun, "maxPerRunAtomic");
      dailyCap = parsePositiveAtomic(rawDailyCap, "dailyCapAtomic");
    } catch (error) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (dailyCap < maxPerRun) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "dailyCapAtomic must be greater than or equal to maxPerRunAtomic.",
      );
    }

    const expiresMs = Date.parse(rawExpiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "expiresAt must be a valid future ISO-8601 timestamp.",
      );
    }

    const grant: SpendPolicyGrant = {
      provider: facet.provider,
      facetName: facet.facetName,
      facetDisplayName: facet.facetDisplayName,
      version: facet.version,
      facetType: facet.facetType,
      chainId: FUJI_CHAIN_ID,
      network: FUJI_NETWORK,
      assetAddress: FUSD_ASSET_ADDRESS,
      // Always pin the verified FeeSplit contract shipped with the package, never from agent input.
      settlementContract: FACET_FEE_SPLIT_ADDRESS,
      providerPayTo: pricing.payTo,
      pricingModel: pricing.model,
      pinnedPriceAtomic: pinnedPrice.toString(),
      maxPerRunAtomic: maxPerRun.toString(),
      dailyCapAtomic: dailyCap.toString(),
      dayBoundary: "UTC",
      expiresAt: new Date(expiresMs).toISOString(),
      registryTxHash,
      grantedAt: now.toISOString(),
    };

    const file = await this.readPolicies();
    const filtered = file.policies.filter(
      (existing) =>
        !(
          existing.provider === grant.provider &&
          existing.facetName === grant.facetName &&
          existing.version === grant.version
        ),
    );
    filtered.push(grant);
    await this.writePolicies({
      version: 2,
      dayBoundary: "UTC",
      policies: filtered,
    });
    return grant;
  }

  async findGrant(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<SpendPolicyGrant | undefined> {
    const file = await this.readPolicies();
    return file.policies.find(
      (entry) =>
        entry.provider === provider &&
        entry.facetName === facetName &&
        entry.version === version,
    );
  }

  async show(filter?: {
    provider?: string;
    facetName?: string;
    version?: string;
  }): Promise<{
    profile: string;
    dayBoundary: "UTC";
    policies: SpendPolicyGrant[];
  }> {
    const file = await this.readPolicies();
    const policies = file.policies.filter((entry) => {
      if (filter?.provider && entry.provider !== filter.provider) return false;
      if (filter?.facetName && entry.facetName !== filter.facetName) return false;
      if (filter?.version && entry.version !== filter.version) return false;
      return true;
    });
    return { profile: this.profile, dayBoundary: "UTC", policies };
  }

  async revoke(input: {
    provider?: string;
    facetName?: string;
    version?: string;
    all?: boolean;
    now?: Date;
  }): Promise<{ revoked: boolean; count: number }> {
    const nowIso = (input.now ?? new Date()).toISOString();
    const file = await this.readPolicies();
    let count = 0;

    const updated = file.policies.map((entry) => {
      const providerMatches = !input.provider || entry.provider === input.provider;
      const facetMatches =
        !input.facetName || entry.facetName === input.facetName;
      const versionMatches = !input.version || entry.version === input.version;
      const matches = input.all
        ? true
        : providerMatches && facetMatches && versionMatches;
      if (matches && !entry.revokedAt) {
        count += 1;
        return { ...entry, revokedAt: nowIso };
      }
      return entry;
    });

    if (count === 0) {
      throw new SpendPolicyError(
        "POLICY_NOT_FOUND",
        "No matching active spending policy found to revoke.",
      );
    }

    await this.writePolicies({
      version: 2,
      dayBoundary: "UTC",
      policies: updated,
    });
    return { revoked: true, count };
  }

  async prune(input: {
    provider?: string;
    facetName?: string;
    version?: string;
    all?: boolean;
  } = {}): Promise<{ pruned: number }> {
    const file = await this.readPolicies();
    const hasFilter = Boolean(input.provider || input.facetName || input.version);
    const kept: SpendPolicyGrant[] = [];
    let pruned = 0;

    for (const entry of file.policies) {
      const isRevoked = Boolean(entry.revokedAt);
      const matchesFilter =
        (!input.provider || entry.provider === input.provider) &&
        (!input.facetName || entry.facetName === input.facetName) &&
        (!input.version || entry.version === input.version);
      const shouldDrop = input.all
        ? true
        : hasFilter
          ? matchesFilter
          : isRevoked;
      if (shouldDrop) {
        pruned += 1;
      } else {
        kept.push(entry);
      }
    }

    await this.writePolicies({
      version: 2,
      dayBoundary: "UTC",
      policies: kept,
    });
    return { pruned };
  }
}

export function validateGrantAgainstChallenge(
  grant: SpendPolicyGrant | undefined,
  challenge: AuthorizeChallengeInput,
): SpendPolicyGrant {
  if (!grant) {
    throw new SpendPolicyError(
      "POLICY_NOT_GRANTED",
      `Default-deny: no spending policy granted for ${challenge.provider}/${challenge.facetName}@${challenge.version}.`,
    );
  }
  if (grant.revokedAt) {
    throw new SpendPolicyError(
      "POLICY_REVOKED",
      `Spending policy for ${grant.provider}/${grant.facetName}@${grant.version} was revoked at ${grant.revokedAt}.`,
    );
  }

  const now = challenge.now ?? new Date();
  if (now.getTime() >= Date.parse(grant.expiresAt)) {
    throw new SpendPolicyError(
      "POLICY_EXPIRED",
      `Spending policy for ${grant.provider}/${grant.facetName}@${grant.version} expired at ${grant.expiresAt}.`,
    );
  }

  if (challenge.chainId !== grant.chainId) {
    throw new SpendPolicyError(
      "POLICY_CHAIN_MISMATCH",
      `Challenge chainId ${challenge.chainId} does not match pinned chainId ${grant.chainId}.`,
    );
  }

  if (
    challenge.assetAddress.toLowerCase() !== grant.assetAddress.toLowerCase()
  ) {
    throw new SpendPolicyError(
      "POLICY_ASSET_MISMATCH",
      `Challenge asset ${challenge.assetAddress} does not match pinned asset ${grant.assetAddress}.`,
    );
  }

  if (
    challenge.settlementPayTo.toLowerCase() !==
    grant.settlementContract.toLowerCase()
  ) {
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      `Challenge payTo ${challenge.settlementPayTo} does not match pinned FeeSplit contract ${grant.settlementContract}.`,
    );
  }

  if (
    challenge.providerPayTo !== undefined &&
    challenge.providerPayTo.toLowerCase() !== grant.providerPayTo.toLowerCase()
  ) {
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      `Provider payTo ${challenge.providerPayTo} does not match pinned provider ${grant.providerPayTo}.`,
    );
  }

  let requestedAmount: bigint;
  try {
    requestedAmount = parsePositiveAtomic(
      challenge.amountAtomic,
      "amountAtomic",
    );
  } catch (error) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (requestedAmount > BigInt(grant.maxPerRunAtomic)) {
    throw new SpendPolicyError(
      "POLICY_MAX_PER_RUN_EXCEEDED",
      `Challenge amount ${requestedAmount.toString()} exceeds granted per-run limit ${grant.maxPerRunAtomic}.`,
    );
  }

  if (
    grant.pricingModel === "PAY_PER_RUN" &&
    requestedAmount !== BigInt(grant.pinnedPriceAtomic)
  ) {
    throw new SpendPolicyError(
      "POLICY_PRICE_MISMATCH",
      `Challenge amount ${requestedAmount.toString()} does not match pinned PAY_PER_RUN price ${grant.pinnedPriceAtomic}.`,
    );
  }

  return grant;
}

export async function authorizePaymentChallenge(
  store: PolicyStore,
  challenge: AuthorizeChallengeInput,
): Promise<SpendPolicyGrant> {
  const grant = await store.findGrant(
    challenge.provider,
    challenge.facetName,
    challenge.version,
  );
  return validateGrantAgainstChallenge(grant, challenge);
}
