import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FACET_FEE_SPLIT_ADDRESS,
  FACET_LEGACY_FEE_SPLIT_V1_ADDRESS,
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

export const PRICING_MODELS = ["PAY_PER_RUN", "PAY_PER_RESULT"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const DEFAULT_POLICY_MAX_PER_RUN_ATOMIC = "1000" as const;
export const DEFAULT_POLICY_DAILY_CAP_ATOMIC = "10000" as const;
export const DEFAULT_PAY_PER_RESULT_MAX_ITEMS_CAP = 20 as const;
export const MAX_PAY_PER_RESULT_ITEMS_CAP = 1000 as const;

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

export interface ApiMeta {
  method: HttpMethod;
  pathTemplate: string;
  datasetPath?: string;
  staticHeaderNames?: string[];
  registryTxHash?: string;
  registryVerified?: boolean;
}

export interface FacetPricingOption {
  model: PricingModel;
  priceAtomic: string;
  maxItemsCap?: number;
  maxAmountAtomic: string;
  assetAddress: string;
  chainId: number;
  payTo: string;
  isPrimary: boolean;
}

export interface PinnedPricingOption {
  model: PricingModel;
  priceAtomic: string;
  maxItemsCap?: number;
  maxAmountAtomic: string;
}

export interface PublicFacetRecord {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: FacetType;
  summary?: string;
  description?: string;
  category?: string;
  tags?: string[];
  method?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  pricing?: {
    model: PricingModel;
    priceAtomic: string;
    maxItemsCap?: number;
    maxAmountAtomic?: string;
    assetAddress: string;
    chainId: number;
    payTo: string;
    isPrimary?: boolean;
  };
  pricingOptions?: FacetPricingOption[];
  apiMeta?: ApiMeta;
  actorMeta?: {
    runtime: string;
    imageDigest: string;
    runnerOciDigest?: string;
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
  publishedAt?: string;
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
  pricingModel: PricingModel;
  pinnedPriceAtomic: string;
  pricingOptions?: PinnedPricingOption[];
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
  pricingModel?: PricingModel;
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
  pricingModel?: PricingModel;
  unitPriceAtomic?: string;
  maxItemsCap?: number;
  now?: Date;
}

export function isValidPricingModel(value: string): value is PricingModel {
  return (PRICING_MODELS as readonly string[]).includes(value);
}

/**
 * Returns the pinned pricing options for a grant, synthesizing a single-entry
 * list for legacy v2 grants written before `pricingOptions` was introduced.
 */
export function getGrantPricingOptions(
  grant: SpendPolicyGrant,
): PinnedPricingOption[] {
  if (Array.isArray(grant.pricingOptions) && grant.pricingOptions.length > 0) {
    return grant.pricingOptions.map((option) => ({
      model: option.model,
      priceAtomic: option.priceAtomic,
      ...(option.maxItemsCap !== undefined
        ? { maxItemsCap: option.maxItemsCap }
        : {}),
      maxAmountAtomic: option.maxAmountAtomic,
    }));
  }

  if (grant.pricingModel === "PAY_PER_RESULT") {
    const cap = DEFAULT_PAY_PER_RESULT_MAX_ITEMS_CAP;
    const maxAmount = (BigInt(grant.pinnedPriceAtomic) * BigInt(cap)).toString();
    return [
      {
        model: "PAY_PER_RESULT",
        priceAtomic: grant.pinnedPriceAtomic,
        maxItemsCap: cap,
        maxAmountAtomic: maxAmount,
      },
    ];
  }

  return [
    {
      model: "PAY_PER_RUN",
      priceAtomic: grant.pinnedPriceAtomic,
      maxAmountAtomic: grant.pinnedPriceAtomic,
    },
  ];
}

/**
 * Emits non-fatal warnings when a granted `maxPerRunAtomic` limit is lower than
 * any pinned option's `maxAmountAtomic` (e.g., default 1000 vs PAY_PER_RESULT cap).
 */
export function getPolicyGrantWarnings(grant: SpendPolicyGrant): string[] {
  let maxPerRun: bigint;
  try {
    maxPerRun = parsePositiveAtomic(grant.maxPerRunAtomic, "maxPerRunAtomic");
  } catch {
    return [];
  }

  const warnings: string[] = [];
  for (const option of getGrantPricingOptions(grant)) {
    let maxAmount: bigint;
    try {
      maxAmount = parsePositiveAtomic(option.maxAmountAtomic, "maxAmountAtomic");
    } catch {
      continue;
    }
    if (maxPerRun < maxAmount) {
      warnings.push(
        `Warning: maxPerRunAtomic (${grant.maxPerRunAtomic}) is below ${option.model} maxAmountAtomic (${option.maxAmountAtomic}); invocations will fail POLICY_MAX_PER_RUN_EXCEEDED unless granted with --max-per-run >= ${option.maxAmountAtomic}.`,
      );
    }
  }
  return warnings;
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
  const registryByType: Record<
    FacetType,
    { label: string; meta: { registryVerified?: boolean; registryTxHash?: string } | undefined }
  > = {
    ACTOR: { label: "Actor", meta: facet.actorMeta },
    AGENT: { label: "Agent", meta: facet.agentMeta },
    API: { label: "API", meta: facet.apiMeta },
  };
  const entry = registryByType[facet.facetType];
  if (
    entry.meta?.registryVerified !== true ||
    !entry.meta.registryTxHash ||
    !TX_HASH_REGEX.test(entry.meta.registryTxHash)
  ) {
    throw new SpendPolicyError(
      "UNVERIFIED_FACET_REGISTRY",
      `Refusing policy grant: ${entry.label} does not have a verified Avalanche registry record.`,
    );
  }
  return entry.meta.registryTxHash;
}

function assertExpectedMaxAmount(
  rawMaxAmount: string | undefined,
  expected: bigint,
  model: PricingModel,
): void {
  if (rawMaxAmount === undefined) return;
  let parsedMax: bigint;
  try {
    parsedMax = parsePositiveAtomic(rawMaxAmount, "maxAmountAtomic");
  } catch (error) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsedMax !== expected) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      model === "PAY_PER_RUN"
        ? `PAY_PER_RUN maxAmountAtomic (${rawMaxAmount}) must equal priceAtomic (${expected.toString()}).`
        : `PAY_PER_RESULT maxAmountAtomic (${rawMaxAmount}) must equal priceAtomic * maxItemsCap (${expected.toString()}).`,
    );
  }
}

type RawCatalogPricingOption = NonNullable<PublicFacetRecord["pricing"]>;

function normalizeCatalogPricingOptions(facet: PublicFacetRecord): {
  payTo: string;
  primaryModel: PricingModel;
  options: PinnedPricingOption[];
} {
  const rawList: RawCatalogPricingOption[] =
    Array.isArray(facet.pricingOptions) && facet.pricingOptions.length > 0
      ? facet.pricingOptions
      : facet.pricing
        ? [facet.pricing]
        : [];

  if (rawList.length === 0) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      "Catalog Facet is missing pricing metadata.",
    );
  }

  const seenModels = new Set<PricingModel>();
  const normalized: Array<{ pinned: PinnedPricingOption; isPrimary: boolean }> =
    [];
  let sharedPayTo: string | undefined;
  let explicitPrimaryCount = 0;
  let explicitPrimaryModel: PricingModel | undefined;

  for (const rawOpt of rawList) {
    if (!isValidPricingModel(rawOpt.model)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Unsupported pricingModel '${String(rawOpt.model)}'.`,
      );
    }
    if (seenModels.has(rawOpt.model)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Catalog Facet contains duplicate pricing option '${rawOpt.model}'.`,
      );
    }
    seenModels.add(rawOpt.model);

    if (rawOpt.chainId !== FUJI_CHAIN_ID) {
      throw new SpendPolicyError(
        "POLICY_CHAIN_MISMATCH",
        `Expected Avalanche chainId ${FUJI_CHAIN_ID}, got ${rawOpt.chainId}.`,
      );
    }
    if (
      rawOpt.assetAddress.toLowerCase() !== FUSD_ASSET_ADDRESS.toLowerCase()
    ) {
      throw new SpendPolicyError(
        "POLICY_ASSET_MISMATCH",
        `Expected Avalanche fUSD ${FUSD_ASSET_ADDRESS}, got ${rawOpt.assetAddress}.`,
      );
    }
    if (!ADDRESS_REGEX.test(rawOpt.payTo)) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "Facet pricing.payTo is not a valid EVM address.",
      );
    }
    if (sharedPayTo === undefined) {
      sharedPayTo = rawOpt.payTo;
    } else if (sharedPayTo.toLowerCase() !== rawOpt.payTo.toLowerCase()) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        "Catalog Facet pricing options disagree on payTo recipient.",
      );
    }

    let unitPrice: bigint;
    try {
      unitPrice = parsePositiveAtomic(rawOpt.priceAtomic, "priceAtomic");
    } catch (error) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }

    let pinned: PinnedPricingOption;
    if (rawOpt.model === "PAY_PER_RUN") {
      if (rawOpt.maxItemsCap !== undefined) {
        throw new SpendPolicyError(
          "POLICY_INVALID",
          "PAY_PER_RUN pricing option must not specify maxItemsCap.",
        );
      }
      assertExpectedMaxAmount(rawOpt.maxAmountAtomic, unitPrice, "PAY_PER_RUN");
      pinned = {
        model: "PAY_PER_RUN",
        priceAtomic: unitPrice.toString(),
        maxAmountAtomic: unitPrice.toString(),
      };
    } else {
      const cap =
        rawOpt.maxItemsCap === undefined
          ? DEFAULT_PAY_PER_RESULT_MAX_ITEMS_CAP
          : rawOpt.maxItemsCap;
      if (
        typeof cap !== "number" ||
        !Number.isSafeInteger(cap) ||
        cap < 1 ||
        cap > MAX_PAY_PER_RESULT_ITEMS_CAP
      ) {
        throw new SpendPolicyError(
          "POLICY_INVALID",
          `PAY_PER_RESULT maxItemsCap must be an integer between 1 and ${MAX_PAY_PER_RESULT_ITEMS_CAP}.`,
        );
      }
      const maxAmount = unitPrice * BigInt(cap);
      assertExpectedMaxAmount(
        rawOpt.maxAmountAtomic,
        maxAmount,
        "PAY_PER_RESULT",
      );
      pinned = {
        model: "PAY_PER_RESULT",
        priceAtomic: unitPrice.toString(),
        maxItemsCap: cap,
        maxAmountAtomic: maxAmount.toString(),
      };
    }

    const isPrimary = rawOpt.isPrimary === true;
    if (isPrimary) {
      explicitPrimaryCount += 1;
      explicitPrimaryModel = pinned.model;
    }
    normalized.push({ pinned, isPrimary });
  }

  if (
    facet.pricing &&
    sharedPayTo &&
    facet.pricing.payTo.toLowerCase() !== sharedPayTo.toLowerCase()
  ) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      "Catalog Facet pricing.payTo disagrees with pricingOptions.",
    );
  }
  if (explicitPrimaryCount > 1) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      "Catalog Facet marks more than one pricing option as primary.",
    );
  }

  const primaryModel =
    explicitPrimaryModel ??
    (facet.pricing && seenModels.has(facet.pricing.model)
      ? facet.pricing.model
      : undefined) ??
    (seenModels.has("PAY_PER_RUN")
      ? "PAY_PER_RUN"
      : normalized[0]!.pinned.model);

  return {
    payTo: sharedPayTo!,
    primaryModel,
    options: normalized.map((item) => item.pinned),
  };
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

    if (
      input.pricingModel !== undefined &&
      !isValidPricingModel(input.pricingModel)
    ) {
      throw new SpendPolicyError(
        "POLICY_INVALID",
        `Invalid pricingModel '${String(input.pricingModel)}'. Expected PAY_PER_RUN or PAY_PER_RESULT.`,
      );
    }

    const registryTxHash = assertVerifiedRegistry(facet);
    const catalogPricing = normalizeCatalogPricingOptions(facet);
    let pinnedOptions: PinnedPricingOption[];
    let primaryOption: PinnedPricingOption;
    if (input.pricingModel !== undefined) {
      const selected = catalogPricing.options.find(
        (opt) => opt.model === input.pricingModel,
      );
      if (!selected) {
        throw new SpendPolicyError(
          "POLICY_INVALID",
          `Facet ${facet.provider}/${facet.facetName}@${facet.version} does not offer pricingModel '${input.pricingModel}'.`,
        );
      }
      pinnedOptions = [selected];
      primaryOption = selected;
    } else {
      pinnedOptions = catalogPricing.options;
      primaryOption =
        pinnedOptions.find(
          (opt) => opt.model === catalogPricing.primaryModel,
        ) ?? pinnedOptions[0]!;
    }

    const rawMaxPerRun =
      input.maxPerRunAtomic ?? DEFAULT_POLICY_MAX_PER_RUN_ATOMIC;
    const rawDailyCap =
      input.dailyCapAtomic ?? DEFAULT_POLICY_DAILY_CAP_ATOMIC;
    const rawExpiresAt = input.expiresAt ?? addOneMonthUtc(now).toISOString();

    let maxPerRun: bigint;
    let dailyCap: bigint;
    try {
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
      providerPayTo: catalogPricing.payTo,
      pricingModel: primaryOption.model,
      pinnedPriceAtomic: primaryOption.priceAtomic,
      pricingOptions: pinnedOptions,
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
    const legacyHint =
      grant.settlementContract.toLowerCase() ===
      FACET_LEGACY_FEE_SPLIT_V1_ADDRESS.toLowerCase()
        ? " Re-run `facet policy grant` to update your local policy for the upgraded payment contract."
        : "";
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      `Challenge payTo ${challenge.settlementPayTo} does not match pinned FeeSplit contract ${grant.settlementContract}.${legacyHint}`,
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

  if (
    challenge.pricingModel !== undefined &&
    !isValidPricingModel(challenge.pricingModel)
  ) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Unsupported challenge pricingModel '${String(challenge.pricingModel)}'.`,
    );
  }

  const pinnedOptions = getGrantPricingOptions(grant);
  let matchedOption: PinnedPricingOption;
  if (challenge.pricingModel !== undefined) {
    const found = pinnedOptions.find(
      (option) => option.model === challenge.pricingModel,
    );
    if (!found) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Pricing model ${challenge.pricingModel} is not authorized in this spending policy grant.`,
      );
    }
    matchedOption = found;
  } else if (pinnedOptions.length > 1) {
    throw new SpendPolicyError(
      "POLICY_PRICE_MISMATCH",
      "Challenge must specify pricingModel when policy grant authorizes multiple pricing options.",
    );
  } else {
    matchedOption = pinnedOptions[0]!;
  }

  if (challenge.unitPriceAtomic !== undefined) {
    let challengeUnitPrice: bigint;
    try {
      challengeUnitPrice = parsePositiveAtomic(
        challenge.unitPriceAtomic,
        "unitPriceAtomic",
      );
    } catch {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Challenge unitPriceAtomic '${challenge.unitPriceAtomic}' is invalid.`,
      );
    }
    if (challengeUnitPrice !== BigInt(matchedOption.priceAtomic)) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Challenge unitPriceAtomic ${challengeUnitPrice.toString()} does not match pinned ${matchedOption.model} price ${matchedOption.priceAtomic}.`,
      );
    }
  }

  if (matchedOption.model === "PAY_PER_RUN") {
    if (challenge.maxItemsCap !== undefined) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        "PAY_PER_RUN challenge must not include maxItemsCap.",
      );
    }
  } else if (challenge.maxItemsCap !== undefined) {
    if (
      typeof challenge.maxItemsCap !== "number" ||
      !Number.isSafeInteger(challenge.maxItemsCap) ||
      challenge.maxItemsCap < 1 ||
      challenge.maxItemsCap > MAX_PAY_PER_RESULT_ITEMS_CAP
    ) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `PAY_PER_RESULT challenge maxItemsCap must be an integer between 1 and ${MAX_PAY_PER_RESULT_ITEMS_CAP}.`,
      );
    }
    if (
      matchedOption.maxItemsCap !== undefined &&
      challenge.maxItemsCap !== matchedOption.maxItemsCap
    ) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Challenge maxItemsCap ${challenge.maxItemsCap} does not match pinned maxItemsCap ${matchedOption.maxItemsCap}.`,
      );
    }
  }

  if (requestedAmount > BigInt(grant.maxPerRunAtomic)) {
    throw new SpendPolicyError(
      "POLICY_MAX_PER_RUN_EXCEEDED",
      `Challenge amount ${requestedAmount.toString()} exceeds granted per-run limit ${grant.maxPerRunAtomic}.`,
    );
  }

  if (matchedOption.model === "PAY_PER_RUN") {
    if (requestedAmount !== BigInt(matchedOption.priceAtomic)) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Challenge amount ${requestedAmount.toString()} does not match pinned PAY_PER_RUN price ${matchedOption.priceAtomic}.`,
      );
    }
  } else {
    const effectiveCap = challenge.maxItemsCap ?? matchedOption.maxItemsCap;
    if (effectiveCap !== undefined) {
      const expectedAmount =
        BigInt(matchedOption.priceAtomic) * BigInt(effectiveCap);
      if (requestedAmount !== expectedAmount) {
        throw new SpendPolicyError(
          "POLICY_PRICE_MISMATCH",
          `Challenge amount ${requestedAmount.toString()} does not match pinned PAY_PER_RESULT deposit ${expectedAmount.toString()} (${matchedOption.priceAtomic} * ${effectiveCap}).`,
        );
      }
    }
    const hasPinnedOptions =
      Array.isArray(grant.pricingOptions) && grant.pricingOptions.length > 0;
    if (hasPinnedOptions) {
      if (requestedAmount !== BigInt(matchedOption.maxAmountAtomic)) {
        throw new SpendPolicyError(
          "POLICY_PRICE_MISMATCH",
          `Challenge amount ${requestedAmount.toString()} does not match pinned PAY_PER_RESULT maxAmountAtomic ${matchedOption.maxAmountAtomic}.`,
        );
      }
    } else if (
      challenge.maxItemsCap === undefined &&
      requestedAmount % BigInt(matchedOption.priceAtomic) !== 0n
    ) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Challenge amount ${requestedAmount.toString()} is not a multiple of pinned PAY_PER_RESULT unit price ${matchedOption.priceAtomic}.`,
      );
    }
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
