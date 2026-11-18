import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildFacetMcpSpec,
  renderCodexTomlSection,
  type BuildMcpSpecOptions,
  type FacetMcpServerSpec,
  type McpClientName,
} from "./mcp-config.js";

export type McpInstallErrorCode =
  | "MCP_CLIENT_INVALID"
  | "MCP_CONFIG_MALFORMED"
  | "MCP_CLI_FAILED";

export class McpInstallError extends Error {
  constructor(
    public readonly code: McpInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpInstallError";
  }
}

export interface InstallMcpOptions extends BuildMcpSpecOptions {
  homeDir?: string;
  runClientCli?: boolean | ((command: string, args: string[]) => { exitCode: number; stderr: string });
}

export interface InstallMcpResult {
  client: McpClientName;
  method: "file" | "cli";
  configPath?: string;
  backupPath?: string;
  spec: FacetMcpServerSpec;
}

async function atomicWritePreservingSymlink(
  targetPath: string,
  contents: string,
): Promise<{ backupPath?: string }> {
  const writePath = existsSync(targetPath)
    ? realpathSync(targetPath)
    : targetPath;
  await mkdir(dirname(writePath), { recursive: true, mode: 0o700 });

  let backupPath: string | undefined;
  if (existsSync(writePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    backupPath = `${writePath}.bak.${stamp}`;
    await copyFile(writePath, backupPath);
  }

  const tmpPath = `${writePath}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(
    tmpPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await rename(tmpPath, writePath);
  return backupPath ? { backupPath } : {};
}

async function updateJsonMcpConfig(
  configPath: string,
  spec: FacetMcpServerSpec,
): Promise<{ backupPath?: string }> {
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = await readFile(realpathSync(configPath), "utf8");
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new McpInstallError(
          "MCP_CONFIG_MALFORMED",
          `Existing MCP config at ${configPath} is not valid JSON. Refusing to overwrite.`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new McpInstallError(
          "MCP_CONFIG_MALFORMED",
          `Existing MCP config at ${configPath} must be a JSON object.`,
        );
      }
      root = parsed as Record<string, unknown>;
    }
  }

  const existingServers = root.mcpServers;
  if (
    existingServers !== undefined &&
    (existingServers === null ||
      typeof existingServers !== "object" ||
      Array.isArray(existingServers))
  ) {
    throw new McpInstallError(
      "MCP_CONFIG_MALFORMED",
      `Existing mcpServers field in ${configPath} must be an object.`,
    );
  }

  const nextRoot: Record<string, unknown> = {
    ...root,
    mcpServers: {
      ...(existingServers as Record<string, unknown> | undefined),
      facet: {
        command: spec.command,
        args: spec.args,
        env: spec.env,
      },
    },
  };

  return atomicWritePreservingSymlink(
    configPath,
    `${JSON.stringify(nextRoot, null, 2)}\n`,
  );
}

function upsertCodexToml(raw: string, spec: FacetMcpServerSpec): string {
  const lines = raw.length > 0 ? raw.split(/\r?\n/u) : [];
  const kept: string[] = [];
  let skippingFacetSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (!/^\[+\s*[a-zA-Z0-9_."'-]+(?:\.[a-zA-Z0-9_."'-]+)*\s*\]+$/u.test(trimmed)) {
        throw new McpInstallError(
          "MCP_CONFIG_MALFORMED",
          `Malformed TOML section header in Codex config: ${trimmed}`,
        );
      }
      skippingFacetSection =
        trimmed === "[mcp_servers.facet]" ||
        trimmed.startsWith("[mcp_servers.facet.");
    }
    if (!skippingFacetSection) {
      kept.push(line);
    }
  }

  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
    kept.pop();
  }

  const prefix = kept.length > 0 ? `${kept.join("\n")}\n\n` : "";
  return `${prefix}${renderCodexTomlSection(spec)}`;
}

function defaultCliRunner(command: string, args: string[]) {
  const res = spawnSync(command, args, { encoding: "utf8" });
  return {
    exitCode: res.status ?? 1,
    stderr: res.stderr ?? "",
  };
}

function hasBinary(name: string): boolean {
  const probe = spawnSync("which", [name], { encoding: "utf8" });
  return probe.status === 0;
}

export async function installMcpClient(
  client: McpClientName,
  options: InstallMcpOptions = {},
): Promise<InstallMcpResult> {
  const homeDir = options.homeDir ?? homedir();
  const spec = buildFacetMcpSpec(options);

  if (client === "antigravity") {
    const configPath = join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    const { backupPath } = await updateJsonMcpConfig(configPath, spec);
    return {
      client,
      method: "file",
      configPath,
      ...(backupPath ? { backupPath } : {}),
      spec,
    };
  }

  if (client === "codex") {
    const configPath = join(homeDir, ".codex", "config.toml");
    const raw = existsSync(configPath)
      ? await readFile(realpathSync(configPath), "utf8")
      : "";
    const nextToml = upsertCodexToml(raw, spec);
    const { backupPath } = await atomicWritePreservingSymlink(
      configPath,
      nextToml,
    );
    return {
      client,
      method: "file",
      configPath,
      ...(backupPath ? { backupPath } : {}),
      spec,
    };
  }

  if (client === "claude") {
    const customRunner =
      typeof options.runClientCli === "function"
        ? options.runClientCli
        : undefined;
    const shouldTryCli =
      options.runClientCli === true ||
      Boolean(customRunner) ||
      (options.runClientCli !== false &&
        options.homeDir === undefined &&
        hasBinary("claude"));

    if (shouldTryCli) {
      const run = customRunner ?? defaultCliRunner;
      run("claude", ["mcp", "remove", "-s", "user", "facet"]);
      const addArgs = [
        "mcp",
        "add",
        "--scope",
        "user",
        "facet",
        ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "--",
        spec.command,
        ...spec.args,
      ];
      const result = run("claude", addArgs);
      if (result.exitCode !== 0) {
        throw new McpInstallError(
          "MCP_CLI_FAILED",
          `claude mcp add failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
      return { client, method: "cli", spec };
    }

    const configPath = join(homeDir, ".claude.json");
    const { backupPath } = await updateJsonMcpConfig(configPath, spec);
    return {
      client,
      method: "file",
      configPath,
      ...(backupPath ? { backupPath } : {}),
      spec,
    };
  }

  throw new McpInstallError(
    "MCP_CLIENT_INVALID",
    `Unsupported MCP client '${String(client)}'. Expected codex, claude, or antigravity.`,
  );
}
