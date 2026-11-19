import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FacetType } from "./identifiers.js";

export const SNOWTRACE_TX_BASE = "https://testnet.snowtrace.io/tx/" as const;
const LEDGER_FUJI_CHAIN_ID = 43113 as const;
const LEDGER_FUSD_DECIMALS = 6 as const;
const LEDGER_FUSD_SYMBOL = "fUSD" as const;

function formatAtomicFusd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction}`;
}

export type SpendEntryStatus = "PENDING" | "SETTLED" | "RELEASED" | "FAILED";

export type SpendLedgerErrorCode =
  | "INVALID_AMOUNT"
  | "DAILY_CAP_EXCEEDED"
  | "MAX_PER_RUN_EXCEEDED"
  | "RESERVATION_CONFLICT"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_ALREADY_SETTLED"
  | "RESERVATION_CLOSED"
  | "LEDGER_LOCK_TIMEOUT";

export class SpendLedgerError extends Error {
  constructor(
    public readonly code: SpendLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpendLedgerError";
  }
}

export interface SpendLedgerEntry {
  runKey: string;
  provider?: string;
  facetName?: string;
  facetDisplayName?: string;
  version?: string;
  facetType?: FacetType;
  runId?: string;
  amountAtomic: string;
  status: SpendEntryStatus;
  utcDay: string;
  paymentTxHash?: string;
  receiptTxHash?: string;
  payer?: string;
  providerPayTo?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface SpendLedgerFile {
  version: 1;
  dayBoundary: "UTC";
  entries: SpendLedgerEntry[];
}

export interface ReserveOptions {
  dailyCapAtomic?: bigint | string;
  maxPerRunAtomic?: bigint | string;
  provider?: string;
  facetName?: string;
  facetDisplayName?: string;
  version?: string;
  facetType?: FacetType;
  runId?: string;
  payer?: string;
  providerPayTo?: string;
  now?: Date;
}

export interface ConfirmOptions {
  paymentTxHash: string;
  receiptTxHash?: string;
  amountAtomic?: bigint | string;
  runId?: string;
  payer?: string;
  providerPayTo?: string;
  now?: Date;
}

export interface SpendHistoryInvoice {
  runKey: string;
  runId?: string;
  provider?: string;
  facetName?: string;
  facetDisplayName?: string;
  version?: string;
  facetType?: FacetType;
  status: SpendEntryStatus;
  utcDay: string;
  amountAtomic: string;
  amountFormatted: string;
  assetSymbol: typeof LEDGER_FUSD_SYMBOL;
  decimals: typeof LEDGER_FUSD_DECIMALS;
  chainId: typeof LEDGER_FUJI_CHAIN_ID;
  payer?: string;
  providerPayTo?: string;
  paymentTxHash?: string;
  paymentSnowtraceUrl?: string;
  receiptTxHash?: string;
  receiptSnowtraceUrl?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpendHistoryReport {
  summary: {
    totalCount: number;
    settledCount: number;
    pendingCount: number;
    releasedCount: number;
    failedCount: number;
    totalSettledAtomic: string;
    totalSettledFormatted: string;
    totalPendingAtomic: string;
    totalPendingFormatted: string;
  };
  invoices: SpendHistoryInvoice[];
}

const ATOMIC_POSITIVE_REGEX = /^[1-9][0-9]*$/u;
const ATOMIC_NON_NEGATIVE_REGEX = /^(?:0|[1-9][0-9]*)$/u;
const SAFE_PROFILE_REGEX = /^[a-zA-Z0-9._-]+$/u;

export function snowtraceTxUrl(txHash: string): string {
  return `${SNOWTRACE_TX_BASE}${txHash}`;
}

function resolveLedgerProfile(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = (explicit ?? env.FACET_PROFILE ?? "default").trim();
  if (!SAFE_PROFILE_REGEX.test(candidate)) {
    throw new SpendLedgerError(
      "RESERVATION_CONFLICT",
      "Invalid profile name; use only letters, digits, '.', '_', or '-'.",
    );
  }
  return candidate;
}

export function parsePositiveAtomic(
  value: bigint | string,
  label = "amountAtomic",
): bigint {
  if (typeof value === "bigint") {
    if (value <= 0n) {
      throw new SpendLedgerError(
        "INVALID_AMOUNT",
        `${label} must be a positive integer atomic amount.`,
      );
    }
    return value;
  }
  const trimmed = value.trim();
  if (!ATOMIC_POSITIVE_REGEX.test(trimmed)) {
    throw new SpendLedgerError(
      "INVALID_AMOUNT",
      `${label} must be a positive integer atomic string.`,
    );
  }
  return BigInt(trimmed);
}

export function parseNonNegativeAtomic(
  value: bigint | string,
  label = "amountAtomic",
): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new SpendLedgerError(
        "INVALID_AMOUNT",
        `${label} must be a non-negative integer atomic amount.`,
      );
    }
    return value;
  }
  const trimmed = value.trim();
  if (!ATOMIC_NON_NEGATIVE_REGEX.test(trimmed)) {
    throw new SpendLedgerError(
      "INVALID_AMOUNT",
      `${label} must be a non-negative integer atomic string.`,
    );
  }
  return BigInt(trimmed);
}

export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function defaultSpendLedgerPath(
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): string {
  if (env.FACET_SPEND_LEDGER_PATH) {
    return env.FACET_SPEND_LEDGER_PATH;
  }
  const baseDir = env.FACET_CONFIG_DIR ?? join(homedir(), ".config", "facet");
  const resolvedProfile = resolveLedgerProfile(profile, env);
  return resolvedProfile === "default"
    ? join(baseDir, "spend-ledger.json")
    : join(baseDir, "profiles", resolvedProfile, "spend-ledger.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SpendLedger {
  public readonly filePath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(options?: {
    filePath?: string;
    lockTimeoutMs?: number;
    staleLockMs?: number;
  }) {
    this.filePath = options?.filePath ?? defaultSpendLedgerPath();
    this.lockTimeoutMs = options?.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options?.staleLockMs ?? 15_000;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;

    while (true) {
      try {
        const handle = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
            "utf8",
          );
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;

        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > this.staleLockMs) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() >= deadline) {
          throw new SpendLedgerError(
            "LEDGER_LOCK_TIMEOUT",
            "Timed out waiting for local spend ledger lock.",
          );
        }
        await sleep(5 + Math.floor(Math.random() * 15));
      }
    }

    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }

  private async readLedger(): Promise<SpendLedgerFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SpendLedgerFile>;
      return {
        version: 1,
        dayBoundary: "UTC",
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, dayBoundary: "UTC", entries: [] };
      }
      throw error;
    }
  }

  private async writeLedger(data: SpendLedgerFile): Promise<void> {
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

  async reserve(
    runKey: string,
    amount: bigint | string,
    options: ReserveOptions = {},
  ): Promise<SpendLedgerEntry> {
    if (!runKey || !runKey.trim()) {
      throw new SpendLedgerError(
        "RESERVATION_CONFLICT",
        "runKey must be a non-empty string.",
      );
    }
    const parsedAmount = parsePositiveAtomic(amount, "amountAtomic");
    const amountStr = parsedAmount.toString();
    const now = options.now ?? new Date();
    const currentDay = utcDayKey(now);

    if (options.maxPerRunAtomic !== undefined) {
      const maxPerRun = parsePositiveAtomic(
        options.maxPerRunAtomic,
        "maxPerRunAtomic",
      );
      if (parsedAmount > maxPerRun) {
        throw new SpendLedgerError(
          "MAX_PER_RUN_EXCEEDED",
          `Requested spend ${amountStr} exceeds per-run limit ${maxPerRun.toString()}.`,
        );
      }
    }

    const dailyCap =
      options.dailyCapAtomic !== undefined
        ? parsePositiveAtomic(options.dailyCapAtomic, "dailyCapAtomic")
        : undefined;

    return this.withFileLock(async () => {
      const ledger = await this.readLedger();
      const existingIndex = ledger.entries.findIndex(
        (entry) => entry.runKey === runKey,
      );
      const existing =
        existingIndex >= 0 ? ledger.entries[existingIndex] : undefined;

      if (
        existing &&
        (existing.status === "PENDING" || existing.status === "SETTLED")
      ) {
        if (existing.amountAtomic === amountStr) {
          return existing;
        }
        throw new SpendLedgerError(
          "RESERVATION_CONFLICT",
          `Reservation ${runKey} already exists with a different amount (${existing.amountAtomic}).`,
        );
      }

      if (dailyCap !== undefined) {
        const hasScopedTarget = Boolean(
          options.provider && options.facetName && options.version,
        );
        const committedToday = ledger.entries.reduce((sum, entry) => {
          if (
            hasScopedTarget &&
            entry.provider &&
            entry.facetName &&
            entry.version &&
            (entry.provider !== options.provider ||
              entry.facetName !== options.facetName ||
              entry.version !== options.version)
          ) {
            return sum;
          }
          const countsTowardCap =
            entry.status === "PENDING" ||
            (entry.status === "SETTLED" && entry.utcDay === currentDay);
          return countsTowardCap ? sum + BigInt(entry.amountAtomic) : sum;
        }, 0n);

        if (committedToday + parsedAmount > dailyCap) {
          throw new SpendLedgerError(
            "DAILY_CAP_EXCEEDED",
            `Spend ${amountStr} plus active/settled UTC daily spend ${committedToday.toString()} exceeds daily cap ${dailyCap.toString()}.`,
          );
        }
      }

      const timestamp = now.toISOString();
      const nextEntry: SpendLedgerEntry = {
        runKey,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.facetName ? { facetName: options.facetName } : {}),
        ...(options.facetDisplayName
          ? { facetDisplayName: options.facetDisplayName }
          : {}),
        ...(options.version ? { version: options.version } : {}),
        ...(options.facetType ? { facetType: options.facetType } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        amountAtomic: amountStr,
        status: "PENDING",
        utcDay: currentDay,
        ...(options.payer ? { payer: options.payer } : {}),
        ...(options.providerPayTo
          ? { providerPayTo: options.providerPayTo }
          : {}),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      if (existingIndex >= 0) {
        ledger.entries[existingIndex] = nextEntry;
      } else {
        ledger.entries.push(nextEntry);
      }
      await this.writeLedger(ledger);
      return nextEntry;
    });
  }

  async confirm(
    runKey: string,
    txOrDetails: string | ConfirmOptions,
    options?: { now?: Date },
  ): Promise<SpendLedgerEntry> {
    const details: ConfirmOptions =
      typeof txOrDetails === "string"
        ? {
            paymentTxHash: txOrDetails,
            ...(options?.now ? { now: options.now } : {}),
          }
        : txOrDetails;
    const now = details.now ?? options?.now ?? new Date();

    return this.withFileLock(async () => {
      const ledger = await this.readLedger();
      const index = ledger.entries.findIndex((entry) => entry.runKey === runKey);
      const entry = index >= 0 ? ledger.entries[index] : undefined;
      if (!entry) {
        throw new SpendLedgerError(
          "RESERVATION_NOT_FOUND",
          `No spend reservation found for ${runKey}.`,
        );
      }
      if (entry.status === "RELEASED" || entry.status === "FAILED") {
        throw new SpendLedgerError(
          "RESERVATION_CLOSED",
          `Spend reservation ${runKey} is already closed (${entry.status}).`,
        );
      }
      const settledAmount =
        details.amountAtomic !== undefined
          ? parseNonNegativeAtomic(details.amountAtomic, "amountAtomic").toString()
          : undefined;
      if (
        entry.status === "SETTLED" &&
        entry.paymentTxHash === details.paymentTxHash &&
        (!details.receiptTxHash ||
          entry.receiptTxHash === details.receiptTxHash) &&
        (settledAmount === undefined || entry.amountAtomic === settledAmount)
      ) {
        return entry;
      }

      const updated: SpendLedgerEntry = {
        ...entry,
        status: "SETTLED",
        paymentTxHash: details.paymentTxHash,
        ...(settledAmount !== undefined ? { amountAtomic: settledAmount } : {}),
        ...(details.receiptTxHash
          ? { receiptTxHash: details.receiptTxHash }
          : {}),
        ...(details.runId ? { runId: details.runId } : {}),
        ...(details.payer ? { payer: details.payer } : {}),
        ...(details.providerPayTo
          ? { providerPayTo: details.providerPayTo }
          : {}),
        updatedAt: now.toISOString(),
      };
      ledger.entries[index] = updated;
      await this.writeLedger(ledger);
      return updated;
    });
  }

  async release(
    runKey: string,
    reason?: string,
    options?: { status?: "RELEASED" | "FAILED"; now?: Date },
  ): Promise<SpendLedgerEntry> {
    const now = options?.now ?? new Date();
    const targetStatus = options?.status ?? "RELEASED";

    return this.withFileLock(async () => {
      const ledger = await this.readLedger();
      const index = ledger.entries.findIndex((entry) => entry.runKey === runKey);
      const entry = index >= 0 ? ledger.entries[index] : undefined;
      if (!entry) {
        throw new SpendLedgerError(
          "RESERVATION_NOT_FOUND",
          `No spend reservation found for ${runKey}.`,
        );
      }
      if (entry.status === "SETTLED") {
        throw new SpendLedgerError(
          "RESERVATION_ALREADY_SETTLED",
          `Cannot release settled reservation ${runKey}.`,
        );
      }
      if (entry.status === targetStatus) {
        return entry;
      }

      const updated: SpendLedgerEntry = {
        ...entry,
        status: targetStatus,
        ...(reason ? { errorCode: reason } : {}),
        updatedAt: now.toISOString(),
      };
      ledger.entries[index] = updated;
      await this.writeLedger(ledger);
      return updated;
    });
  }

  async list(filter?: {
    utcDay?: string;
    status?: SpendEntryStatus;
    provider?: string;
    facetName?: string;
    version?: string;
  }): Promise<SpendLedgerEntry[]> {
    const ledger = await this.readLedger();
    return ledger.entries.filter((entry) => {
      if (filter?.utcDay && entry.utcDay !== filter.utcDay) return false;
      if (filter?.status && entry.status !== filter.status) return false;
      if (filter?.provider && entry.provider !== filter.provider) return false;
      if (filter?.facetName && entry.facetName !== filter.facetName) return false;
      if (filter?.version && entry.version !== filter.version) return false;
      return true;
    });
  }
}

export function formatSpendHistory(
  entries: SpendLedgerEntry[],
): SpendHistoryReport {
  const ordered = [...entries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  let settledCount = 0;
  let pendingCount = 0;
  let releasedCount = 0;
  let failedCount = 0;
  let totalSettledAtomic = 0n;
  let totalPendingAtomic = 0n;

  const invoices: SpendHistoryInvoice[] = ordered.map((entry) => {
    const amount = BigInt(entry.amountAtomic);
    if (entry.status === "SETTLED") {
      settledCount += 1;
      totalSettledAtomic += amount;
    } else if (entry.status === "PENDING") {
      pendingCount += 1;
      totalPendingAtomic += amount;
    } else if (entry.status === "RELEASED") {
      releasedCount += 1;
    } else if (entry.status === "FAILED") {
      failedCount += 1;
    }

    const invoice: SpendHistoryInvoice = {
      runKey: entry.runKey,
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.facetName ? { facetName: entry.facetName } : {}),
      ...(entry.facetDisplayName
        ? { facetDisplayName: entry.facetDisplayName }
        : {}),
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.facetType ? { facetType: entry.facetType } : {}),
      status: entry.status,
      utcDay: entry.utcDay,
      amountAtomic: entry.amountAtomic,
      amountFormatted: formatAtomicFusd(amount),
      assetSymbol: LEDGER_FUSD_SYMBOL,
      decimals: LEDGER_FUSD_DECIMALS,
      chainId: LEDGER_FUJI_CHAIN_ID,
      ...(entry.payer ? { payer: entry.payer } : {}),
      ...(entry.providerPayTo ? { providerPayTo: entry.providerPayTo } : {}),
      ...(entry.paymentTxHash
        ? {
            paymentTxHash: entry.paymentTxHash,
            paymentSnowtraceUrl: snowtraceTxUrl(entry.paymentTxHash),
          }
        : {}),
      ...(entry.status === "SETTLED" && entry.receiptTxHash
        ? {
            receiptTxHash: entry.receiptTxHash,
            receiptSnowtraceUrl: snowtraceTxUrl(entry.receiptTxHash),
          }
        : {}),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    return invoice;
  });

  return {
    summary: {
      totalCount: entries.length,
      settledCount,
      pendingCount,
      releasedCount,
      failedCount,
      totalSettledAtomic: totalSettledAtomic.toString(),
      totalSettledFormatted: formatAtomicFusd(totalSettledAtomic),
      totalPendingAtomic: totalPendingAtomic.toString(),
      totalPendingFormatted: formatAtomicFusd(totalPendingAtomic),
    },
    invoices,
  };
}

export function formatSpendHistoryText(
  profile: string,
  report: SpendHistoryReport,
): string {
  const lines = [
    `FACET Spend History (profile: ${profile})`,
    `Settled: ${report.summary.settledCount} (${report.summary.totalSettledFormatted} fUSD) | Pending: ${report.summary.pendingCount} (${report.summary.totalPendingFormatted} fUSD) | Released: ${report.summary.releasedCount} | Failed: ${report.summary.failedCount}`,
  ];
  for (const inv of report.invoices) {
    const label = inv.provider && inv.facetName
      ? `${inv.provider}/${inv.facetName}@${inv.version ?? "?"}`
      : inv.runKey;
    const title = inv.facetDisplayName ? ` (${inv.facetDisplayName})` : "";
    lines.push(
      `- [${inv.status}] ${label}${title} | ${inv.amountFormatted} fUSD (${inv.amountAtomic} atomic) | ${inv.createdAt}`,
    );
    if (inv.runId) {
      lines.push(`  runId: ${inv.runId}`);
    }
    if (inv.providerPayTo) {
      lines.push(`  payTo: ${inv.providerPayTo}`);
    }
    if (inv.paymentSnowtraceUrl) {
      lines.push(`  payment: ${inv.paymentSnowtraceUrl}`);
    }
    if (inv.receiptSnowtraceUrl) {
      lines.push(`  receipt: ${inv.receiptSnowtraceUrl}`);
    }
  }
  return lines.join("\n");
}
