import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { SpendLedger } from "../src/spend-ledger.js";

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

describe("SpendLedger", () => {
  it("reserves, confirms, releases, and resets settled spend at UTC midnight while keeping pending reservations", async () => {
    const dir = await makeTempDir();
    const ledger = new SpendLedger({ filePath: join(dir, "ledger.json") });
    const day1 = new Date("2026-11-18T23:55:00Z");
    const day2 = new Date("2026-11-19T00:05:00Z");

    const r1 = await ledger.reserve("ver1:key1", "1000", {
      dailyCapAtomic: "2000",
      facetId: "facet-1",
      facetVersionId: "ver1",
      now: day1,
    });
    expect(r1.status).toBe("PENDING");

    // Idempotent replay with same runKey & amount does not double-charge
    const r1Replay = await ledger.reserve("ver1:key1", "1000", {
      dailyCapAtomic: "2000",
      facetId: "facet-1",
      facetVersionId: "ver1",
      now: day1,
    });
    expect(r1Replay.runKey).toBe("ver1:key1");

    // Second reservation fits within 2000 cap
    const r2 = await ledger.reserve("ver1:key2", "1000", {
      dailyCapAtomic: "2000",
      facetId: "facet-1",
      facetVersionId: "ver1",
      now: day1,
    });
    expect(r2.status).toBe("PENDING");

    // Third reservation exceeds daily cap while r1 and r2 are PENDING
    await expect(
      ledger.reserve("ver1:key3", "1000", {
        dailyCapAtomic: "2000",
        facetId: "facet-1",
        facetVersionId: "ver1",
        now: day1,
      }),
    ).rejects.toMatchObject({ code: "DAILY_CAP_EXCEEDED" });

    // Confirm r1, leave r2 PENDING across UTC midnight
    const confirmed = await ledger.confirm("ver1:key1", "0x" + "a".repeat(64), {
      now: day1,
    });
    expect(confirmed.status).toBe("SETTLED");

    // On day2: settled r1 from day1 no longer counts toward day2 cap,
    // while unsettled PENDING r2 still holds 1000 until reconciled!
    await expect(
      ledger.reserve("ver1:key4", "1500", {
        dailyCapAtomic: "2000",
        facetId: "facet-1",
        facetVersionId: "ver1",
        now: day2,
      }),
    ).rejects.toMatchObject({ code: "DAILY_CAP_EXCEEDED" });

    // Releasing r2 frees that 1000 immediately
    const released = await ledger.release("ver1:key2");
    expect(released.status).toBe("RELEASED");

    const r4 = await ledger.reserve("ver1:key4", "1500", {
      dailyCapAtomic: "2000",
      facetId: "facet-1",
      facetVersionId: "ver1",
      now: day2,
    });
    expect(r4.status).toBe("PENDING");

    const entries = await ledger.list();
    expect(entries).toHaveLength(3);
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
          facetVersionId: "ver-concurrent",
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
      runChild("ver-concurrent:proc-1"),
      runChild("ver-concurrent:proc-2"),
    ]);

    expect(results.filter((r) => r === "RESERVED")).toHaveLength(1);
    expect(
      results.filter((r) => r === "DENIED:DAILY_CAP_EXCEEDED"),
    ).toHaveLength(1);
  });
});
