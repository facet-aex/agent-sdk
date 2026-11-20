import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  SNOWTRACE_TX_BASE,
  SpendLedger,
  formatSpendHistory,
  formatSpendHistoryText,
} from "../src/spend-ledger.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facet-ledger-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SpendLedger & Task B6 spend history", () => {
  it("reserves, confirms, releases, and resets settled spend at UTC midnight while keeping pending reservations", async () => {
    const dir = await makeTempDir();
    const ledger = new SpendLedger({ filePath: join(dir, "ledger.json") });
    const day1 = new Date("2026-11-18T23:55:00Z");
    const day2 = new Date("2026-11-19T00:05:00Z");

    const baseOpts = {
      dailyCapAtomic: "2000",
      provider: "tai-hung-dev",
      facetName: "echo-actor",
      facetDisplayName: "Echo Actor",
      version: "1.0.0",
      facetType: "ACTOR" as const,
      now: day1,
    };

    const r1 = await ledger.reserve("tai-hung-dev/echo-actor@1.0.0:key1", "1000", baseOpts);
    expect(r1.status).toBe("PENDING");

    // Idempotent replay with same runKey & amount does not double-charge
    const r1Replay = await ledger.reserve("tai-hung-dev/echo-actor@1.0.0:key1", "1000", baseOpts);
    expect(r1Replay.runKey).toBe("tai-hung-dev/echo-actor@1.0.0:key1");

    // Second reservation fits within 2000 cap
    const r2 = await ledger.reserve("tai-hung-dev/echo-actor@1.0.0:key2", "1000", baseOpts);
    expect(r2.status).toBe("PENDING");

    // Third reservation exceeds daily cap while r1 and r2 are PENDING
    await expect(
      ledger.reserve("tai-hung-dev/echo-actor@1.0.0:key3", "1000", baseOpts),
    ).rejects.toMatchObject({ code: "DAILY_CAP_EXCEEDED" });

    // Confirm r1, leave r2 PENDING across UTC midnight
    const paymentTx = "0x" + "a".repeat(64);
    const receiptTx = "0x" + "b".repeat(64);
    const confirmed = await ledger.confirm("tai-hung-dev/echo-actor@1.0.0:key1", {
      paymentTxHash: paymentTx,
      receiptTxHash: receiptTx,
      runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
      payer: "0xFA8cCB3C5145fca08f22675ea740e89B1D3a317f",
      providerPayTo: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
      now: day1,
    });
    expect(confirmed.status).toBe("SETTLED");

    // On day2: settled r1 from day1 no longer counts toward day2 cap,
    // while unsettled PENDING r2 still holds 1000 until reconciled!
    await expect(
      ledger.reserve("tai-hung-dev/echo-actor@1.0.0:key4", "1500", {
        ...baseOpts,
        now: day2,
      }),
    ).rejects.toMatchObject({ code: "DAILY_CAP_EXCEEDED" });

    // Releasing r2 frees that 1000 immediately
    const released = await ledger.release("tai-hung-dev/echo-actor@1.0.0:key2", "TIMEOUT_CANCELLED", {
      now: day2,
    });
    expect(released.status).toBe("RELEASED");

    const r4 = await ledger.reserve("tai-hung-dev/echo-actor@1.0.0:key4", "1500", {
      ...baseOpts,
      now: day2,
    });
    expect(r4.status).toBe("PENDING");

    const entries = await ledger.list();
    expect(entries).toHaveLength(3);

    // Task B6: verify invoice formatting & CLI spend history output without UUID leakage or fake pending receipts
    const summary = formatSpendHistory(entries);
    expect(summary.summary.totalCount).toBe(3);
    expect(summary.summary.settledCount).toBe(1);
    expect(summary.summary.pendingCount).toBe(1);
    expect(summary.summary.totalSettledAtomic).toBe("1000");
    expect(summary.summary.totalSettledFormatted).toBe("0.001000");
    expect(summary.invoices[0]?.status).toBe("PENDING");
    expect(summary.invoices[0]?.receiptSnowtraceUrl).toBeUndefined();

    const settledInvoice = summary.invoices.find((item) => item.status === "SETTLED")!;
    expect(settledInvoice.provider).toBe("tai-hung-dev");
    expect(settledInvoice.facetName).toBe("echo-actor");
    expect(settledInvoice.facetDisplayName).toBe("Echo Actor");
    expect(settledInvoice.version).toBe("1.0.0");
    expect(settledInvoice.facetType).toBe("ACTOR");
    expect(settledInvoice.amountFormatted).toBe("0.001000");
    expect(settledInvoice.paymentSnowtraceUrl).toBe(`${SNOWTRACE_TX_BASE}${paymentTx}`);
    expect(settledInvoice.receiptSnowtraceUrl).toBe(`${SNOWTRACE_TX_BASE}${receiptTx}`);

    const cliTextOut: string[] = [];
    const textCode = await runCli(
      ["spend", "history", "--profile", "default", "--status", "SETTLED"],
      {
        env: { ...process.env, FACET_SPEND_LEDGER_PATH: ledger.filePath },
        stdout: (line) => cliTextOut.push(line),
      },
    );
    expect(textCode).toBe(0);
    expect(cliTextOut[0]).toContain("FACET Spend History (profile: default)");
    expect(cliTextOut[0]).toContain("0.001000 fUSD (1000 atomic)");
    expect(cliTextOut[0]).toContain(`${SNOWTRACE_TX_BASE}${receiptTx}`);
    expect(() => JSON.parse(cliTextOut[0]!)).toThrow();

    const cliOut: string[] = [];
    const code = await runCli(
      ["spend", "history", "--profile", "default", "--status", "SETTLED", "--json"],
      {
        env: { ...process.env, FACET_SPEND_LEDGER_PATH: ledger.filePath },
        stdout: (line) => cliOut.push(line),
      },
    );
    expect(code).toBe(0);
    const cliBody = JSON.parse(cliOut[0]!) as {
      profile: string;
      invoices: Array<{ provider: string; facetName: string; receiptSnowtraceUrl?: string }>;
    };
    expect(cliBody.profile).toBe("default");
    expect(cliBody.invoices).toHaveLength(1);
    expect(cliBody.invoices[0]?.provider).toBe("tai-hung-dev");
    expect(cliBody.invoices[0]?.receiptSnowtraceUrl).toBe(
      `${SNOWTRACE_TX_BASE}${receiptTx}`,
    );
  });

  it("reconciles PAY_PER_RESULT escrow reservation to actual settled amountAtomic and frees unused cap", async () => {
    const dir = await makeTempDir();
    const ledger = new SpendLedger({ filePath: join(dir, "ledger.json") });
    const now = new Date("2026-11-19T10:30:00Z");

    const baseOpts = {
      dailyCapAtomic: "10000",
      provider: "studio-c4fc0882e",
      facetName: "vn-tech-news-actor",
      facetDisplayName: "VN Tech & Macro News Extractor",
      version: "1.0.0",
      facetType: "ACTOR" as const,
      now,
    };

    const reserved = await ledger.reserve(
      "studio-c4fc0882e/vn-tech-news-actor@1.0.0:pay-per-result-1",
      "10000",
      baseOpts,
    );
    expect(reserved.amountAtomic).toBe("10000");

    const paymentTx = "0x" + "9".repeat(64);
    const receiptTx = "0x" + "7".repeat(64);
    const settled = await ledger.confirm(
      "studio-c4fc0882e/vn-tech-news-actor@1.0.0:pay-per-result-1",
      {
        paymentTxHash: paymentTx,
        receiptTxHash: receiptTx,
        amountAtomic: "500",
        runId: "cfa3c216-b707-47c8-b6aa-e53a3b9fa18c",
        payer: "0xfa8ccb3c5145fca08f22675ea740e89b1d3a317f",
        providerPayTo: "0x5189c4c1a14dc1a6845425b6c44d2b40c0b4f39b",
        now,
      },
    );
    expect(settled.amountAtomic).toBe("500");

    // Since only 500 was actually settled (9500 refunded by escrow), another 9500 fits under the 10000 daily cap
    const nextRun = await ledger.reserve(
      "studio-c4fc0882e/vn-tech-news-actor@1.0.0:pay-per-result-2",
      "9500",
      baseOpts,
    );
    expect(nextRun.status).toBe("PENDING");

    const out: string[] = [];
    const code = await runCli(["spend", "history", "--status", "SETTLED"], {
      env: { ...process.env, FACET_SPEND_LEDGER_PATH: ledger.filePath },
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(0);
    expect(out[0]).toContain("Settled: 1 (0.000500 fUSD)");
    expect(out[0]).toContain("0.000500 fUSD (500 atomic)");
  });

  it("prevents concurrent OS processes from overspending the same daily cap", async () => {
    const dir = await makeTempDir();
    const ledgerPath = join(dir, "ledger.json");
    const pkgDir = resolve(import.meta.dirname, "..");
    const source = await readFile(join(pkgDir, "src/spend-ledger.ts"), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
      },
    });
    const compiledPath = join(dir, "spend-ledger.mjs");
    await writeFile(compiledPath, compiled.outputText, "utf8");
    const ledgerModuleUrl = pathToFileURL(compiledPath).href;

    const script = `
      import { SpendLedger } from ${JSON.stringify(ledgerModuleUrl)};
      const ledger = new SpendLedger({ filePath: process.env.LEDGER_PATH });
      try {
        await ledger.reserve(process.env.RUN_KEY, "1000", {
          dailyCapAtomic: "1000",
          provider: "tai-hung-dev",
          facetName: "echo-actor",
          version: "1.0.0",
          now: new Date("2026-11-18T12:00:00Z"),
        });
        console.log("RESERVED");
      } catch (err) {
        console.log("DENIED:" + (err?.code ?? err?.message));
      }
    `;

    const runChild = (runKey: string) =>
      new Promise<string>((resolveChild, rejectChild) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          {
            cwd: dir,
            env: { ...process.env, LEDGER_PATH: ledgerPath, RUN_KEY: runKey },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString("utf8");
        });
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString("utf8");
        });
        child.on("error", rejectChild);
        child.on("close", (code) => {
          if (code !== 0) rejectChild(new Error(`child exit ${code}: ${err}`));
          else resolveChild(out.trim());
        });
      });

    const results = await Promise.all([
      runChild("tai-hung-dev/echo-actor@1.0.0:proc-1"),
      runChild("tai-hung-dev/echo-actor@1.0.0:proc-2"),
    ]);

    expect(results.filter((r) => r === "RESERVED")).toHaveLength(1);
    expect(
      results.filter((r) => r === "DENIED:DAILY_CAP_EXCEEDED"),
    ).toHaveLength(1);
  });

  it("records PAY_PER_RESULT escrow deposit, partial/zero-item refunds, release refund metadata, and Avalanche spend history text", async () => {
    const dir = await makeTempDir();
    const ledger = new SpendLedger({ filePath: join(dir, "ledger.json") });
    const now = new Date("2026-11-20T08:00:00Z");

    const baseOpts = {
      dailyCapAtomic: "5000",
      provider: "studio-c4fc0882e",
      facetName: "vn-tech-news-actor",
      facetDisplayName: "VN Tech & Macro News Extractor",
      version: "1.0.0",
      facetType: "ACTOR" as const,
      pricingModel: "PAY_PER_RESULT" as const,
      depositedAmountAtomic: "5000",
      now,
    };

    // Run 1: itemCount = 3 -> 1500 settled, 3500 refunded
    const r1 = await ledger.reserve("run-escrow-3", "5000", baseOpts);
    expect(r1.pricingModel).toBe("PAY_PER_RESULT");
    expect(r1.depositedAmountAtomic).toBe("5000");

    const depositTx1 = "0x" + "1".repeat(64);
    const paymentTx1 = "0x" + "2".repeat(64);
    const receiptTx1 = "0x" + "3".repeat(64);

    const c1 = await ledger.confirm("run-escrow-3", {
      paymentTxHash: paymentTx1,
      receiptTxHash: receiptTx1,
      depositTxHash: depositTx1,
      pricingModel: "PAY_PER_RESULT",
      depositedAmountAtomic: "5000",
      amountAtomic: "1500",
      refundAmountAtomic: "3500",
      itemCount: 3,
      runId: "11111111-1111-4111-8111-111111111111",
      now,
    });
    expect(c1.pricingModel).toBe("PAY_PER_RESULT");
    expect(c1.depositedAmountAtomic).toBe("5000");
    expect(c1.amountAtomic).toBe("1500");
    expect(c1.refundAmountAtomic).toBe("3500");
    expect(c1.itemCount).toBe(3);

    // Replaying settled PAY_PER_RESULT with original deposit amount succeeds idempotently
    const replay1 = await ledger.reserve("run-escrow-3", "5000", baseOpts);
    expect(replay1.status).toBe("SETTLED");
    expect(replay1.amountAtomic).toBe("1500");

    // Reusing same runKey with a different pricingModel conflicts
    await expect(
      ledger.reserve("run-escrow-3", "1000", {
        ...baseOpts,
        pricingModel: "PAY_PER_RUN",
      }),
    ).rejects.toMatchObject({ code: "RESERVATION_CONFLICT" });

    // Run 2: reserve remaining 3500 cap, settle with itemCount = 0 -> amountAtomic = "0", full 3500 refund
    const r2 = await ledger.reserve("run-escrow-0", "3500", {
      ...baseOpts,
      depositedAmountAtomic: "3500",
    });
    expect(r2.status).toBe("PENDING");

    const c2 = await ledger.confirm("run-escrow-0", {
      paymentTxHash: "0x" + "4".repeat(64),
      receiptTxHash: "0x" + "5".repeat(64),
      pricingModel: "PAY_PER_RESULT",
      depositedAmountAtomic: "3500",
      amountAtomic: "0",
      refundAmountAtomic: "3500",
      itemCount: 0,
      now,
    });
    expect(c2.amountAtomic).toBe("0");
    expect(c2.refundAmountAtomic).toBe("3500");
    expect(c2.itemCount).toBe(0);

    // Run 3: 3500 available again after 0-item settlement; release on 502 ESCROW_REFUNDED frees cap
    const r3 = await ledger.reserve("run-escrow-refunded", "3500", {
      ...baseOpts,
      depositedAmountAtomic: "3500",
    });
    expect(r3.status).toBe("PENDING");
    const rel3 = await ledger.release("run-escrow-refunded", "ESCROW_REFUNDED", {
      refundTxHash: "0x" + "6".repeat(64),
      refundAmountAtomic: "3500",
      now,
    });
    expect(rel3.status).toBe("RELEASED");
    expect(rel3.refundAmountAtomic).toBe("3500");

    const entries = await ledger.list();
    const report = formatSpendHistory(entries);
    expect(report.summary.totalSettledAtomic).toBe("1500");

    const threeItemInvoice = report.invoices.find((i) => i.runKey === "run-escrow-3")!;
    expect(threeItemInvoice.pricingModel).toBe("PAY_PER_RESULT");
    expect(threeItemInvoice.depositedAmountAtomic).toBe("5000");
    expect(threeItemInvoice.refundAmountAtomic).toBe("3500");
    expect(threeItemInvoice.itemCount).toBe(3);
    expect(threeItemInvoice.depositSnowtraceUrl).toBe(`${SNOWTRACE_TX_BASE}${depositTx1}`);

    const zeroItemInvoice = report.invoices.find((i) => i.runKey === "run-escrow-0")!;
    expect(zeroItemInvoice.amountAtomic).toBe("0");
    expect(zeroItemInvoice.refundAmountAtomic).toBe("3500");
    expect(zeroItemInvoice.itemCount).toBe(0);

    const text = formatSpendHistoryText("staging", report);
    expect(text).toContain("PAY_PER_RESULT");
    expect(text).toContain("0.005000 fUSD (5000 atomic)");
    expect(text).toContain("0.003500 fUSD (3500 atomic)");
    expect(text).toContain("items: 3");
    expect(text).toContain("items: 0");
    expect(text).toContain(`${SNOWTRACE_TX_BASE}${depositTx1}`);
    expect(text).not.toMatch(/\bfuji\b/iu);
  });
});
