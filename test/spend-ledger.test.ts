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

    const cliOut: string[] = [];
    const code = await runCli(
      ["spend", "history", "--profile", "default", "--status", "SETTLED"],
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
});
