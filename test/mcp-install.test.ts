import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  PINNED_MCP_PACKAGE_NAME,
  PINNED_MCP_PACKAGE_VERSION,
  buildFacetMcpSpec,
  renderMcpConfigSnippet,
} from "../src/mcp-config.js";
import { installMcpClient } from "../src/mcp-install.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facet-mcp-install-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("MCP config & client installers", () => {
  it("builds pinned npx MCP spec with public origin and no secrets or local dist paths", () => {
    const spec = buildFacetMcpSpec();
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual([
      "-y",
      `${PINNED_MCP_PACKAGE_NAME}@${PINNED_MCP_PACKAGE_VERSION}`,
    ]);
    expect(spec.env.FACET_CONTROL_API_URL).toBe("https://facet.briandev.space");
    expect(spec.env.FACET_GATEWAY_URL).toBe("https://facet.briandev.space");
    expect(spec.env.FACET_PROFILE).toBeUndefined();
    expect(JSON.stringify(spec)).not.toContain("localhost");
    expect(JSON.stringify(spec)).not.toContain("127.0.0.1");
    expect(JSON.stringify(spec)).not.toContain("dist/server.js");
    expect(JSON.stringify(spec)).not.toMatch(/PRIVATE_KEY|SECRET/iu);

    const profiled = buildFacetMcpSpec({ profile: "research" });
    expect(profiled.env.FACET_PROFILE).toBe("research");

    const snippet = renderMcpConfigSnippet("codex", { profile: "research" });
    expect(snippet).toContain("codex mcp add facet");
    expect(snippet).toContain("FACET_PROFILE=research");
    expect(snippet).toContain("[mcp_servers.facet]");
  });

  it("installs idempotently for antigravity while preserving existing entries, symlinks, and creating backups", async () => {
    const home = await makeTempHome();
    const geminiDir = join(home, ".gemini");
    const agyDir = join(geminiDir, "antigravity");
    const realTarget = join(home, "real-mcp-config.json");
    await writeFile(
      realTarget,
      JSON.stringify(
        {
          mcpServers: {
            context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
          },
          theme: "dark",
        },
        null,
        2,
      ),
      "utf8",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(agyDir, { recursive: true });
    const symlinkPath = join(agyDir, "mcp_config.json");
    await symlink(realTarget, symlinkPath);

    const first = await installMcpClient("antigravity", { homeDir: home });
    expect(first.backupPath).toBeDefined();
    expect(first.configPath).toBe(symlinkPath);

    const afterFirst = JSON.parse(await readFile(realTarget, "utf8")) as {
      theme: string;
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };
    expect(afterFirst.theme).toBe("dark");
    expect(afterFirst.mcpServers.context7?.command).toBe("npx");
    expect(afterFirst.mcpServers.facet?.args).toEqual([
      "-y",
      `${PINNED_MCP_PACKAGE_NAME}@${PINNED_MCP_PACKAGE_VERSION}`,
    ]);

    // Repeat install is idempotent
    await installMcpClient("antigravity", { homeDir: home });
    const afterSecond = JSON.parse(await readFile(realTarget, "utf8")) as typeof afterFirst;
    expect(Object.keys(afterSecond.mcpServers)).toEqual(["context7", "facet"]);
  });

  it("installs idempotently for codex TOML and claude JSON without clobbering existing MCP servers", async () => {
    const home = await makeTempHome();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".codex"), { recursive: true });
    const codexToml = join(home, ".codex", "config.toml");
    await writeFile(
      codexToml,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.other]",
        'command = "npx"',
        'args = ["-y", "other-mcp"]',
        "",
        "[mcp_servers.facet]",
        'command = "old"',
        "",
        "[mcp_servers.facet.env]",
        'FACET_CONTROL_API_URL = "https://old.example"',
        "",
      ].join("\n"),
      "utf8",
    );

    const codexRes = await installMcpClient("codex", {
      homeDir: home,
      profile: "research",
    });
    expect(codexRes.backupPath).toBeDefined();
    const updatedToml = await readFile(codexToml, "utf8");
    expect(updatedToml).toContain('model = "gpt-5"');
    expect(updatedToml).toContain("[mcp_servers.other]");
    expect(updatedToml).toContain('FACET_PROFILE = "research"');
    expect(updatedToml).not.toContain("https://old.example");
    expect(updatedToml.match(/\[mcp_servers\.facet\]/gu)).toHaveLength(1);

    const claudeJson = join(home, ".claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      }),
      "utf8",
    );
    await installMcpClient("claude", { homeDir: home, runClientCli: false });
    const updatedClaude = JSON.parse(await readFile(claudeJson, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(updatedClaude.mcpServers)).toEqual(["github", "facet"]);
  });

  it("rejects malformed existing config files without overwriting them and exposes CLI install/config", async () => {
    const home = await makeTempHome();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });
    const badJsonPath = join(home, ".gemini", "antigravity", "mcp_config.json");
    await writeFile(badJsonPath, "{ bad json", "utf8");

    await expect(
      installMcpClient("antigravity", { homeDir: home }),
    ).rejects.toMatchObject({ code: "MCP_CONFIG_MALFORMED" });
    expect(await readFile(badJsonPath, "utf8")).toBe("{ bad json");

    const out: string[] = [];
    const code = await runCli(["mcp", "config", "claude"], {
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("claude mcp add --scope user facet");

    const jsonConfigOut: string[] = [];
    expect(
      await runCli(["mcp", "config", "antigravity", "--json"], {
        stdout: (line) => jsonConfigOut.push(line),
      }),
    ).toBe(0);
    expect(JSON.parse(jsonConfigOut[0]!)).toMatchObject({
      client: "antigravity",
      spec: { name: "facet", command: "npx" },
    });

    const installHome = await makeTempHome();
    const installTextOut: string[] = [];
    expect(
      await runCli(
        ["mcp", "install", "antigravity"],
        {
          env: { ...process.env, HOME: installHome },
          stdout: (line) => installTextOut.push(line),
        },
      ),
    ).toBe(0);
    expect(installTextOut[0]).toContain("FACET MCP Installed (antigravity)");
    expect(() => JSON.parse(installTextOut[0]!)).toThrow();

    const helpOut: string[] = [];
    expect(
      await runCli(["--help"], { stdout: (line) => helpOut.push(line) }),
    ).toBe(0);
    expect(helpOut[0]).toContain("--json");
  });
});
