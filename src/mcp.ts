import type { McpServer } from "@agentclientprotocol/sdk";
import { parse, type ParseError } from "jsonc-parser";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Connection details belong to the live ACP connection, never sessions.json. */
export function validateMcpServers(servers: McpServer[] = []): McpServer[] {
  const names = new Set<string>();
  for (const server of servers) {
    if ("type" in server && server.type === "acp") {
      throw new Error("Comate does not support MCP over the ACP transport");
    }
    if (!server.name || names.has(server.name)) {
      throw new Error("MCP server names must be non-empty and unique");
    }
    names.add(server.name);
  }
  return structuredClone(servers);
}

export function comateMcpSettings(servers: McpServer[], cwd: string): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => {
    if ("type" in server && (server.type === "http" || server.type === "sse")) {
      return [server.name, {
        transportType: server.type === "http" ? "streamableHttp" : "sse",
        url: server.url,
        headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      }];
    }
    if (!("command" in server)) throw new Error("Unsupported MCP transport");
    return [server.name, {
      transportType: "stdio", command: server.command, args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])), cwd,
    }];
  }));
}

export interface McpOverlay {
  preload: string;
  env: NodeJS.ProcessEnv;
  dispose(): void;
}

/**
 * Comate 2.0 has no --mcp-config option. Its Node launcher reads a private
 * replacement for just .comate/mcp.local.json via a preload. Every child gets
 * its own file; the workspace and the user's global configuration stay intact.
 */
export function createMcpOverlay(servers: McpServer[], cwd: string): McpOverlay | undefined {
  if (!servers.length) return undefined;
  const target = join(cwd, ".comate", "mcp.local.json");
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = "";
  }
  const errors: ParseError[] = [];
  const existing = content.trim() ? parse(content, errors, { allowTrailingComma: true }) : {};
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (errors.length || !isObject(existing)) {
    throw new Error(`Invalid MCP configuration: ${target}`);
  }
  const configured = existing.mcpServers ?? existing.servers ?? {};
  if (!isObject(configured)) throw new Error(`Invalid MCP servers in ${target}`);

  const directory = mkdtempSync(join(tmpdir(), "comate-acp-mcp-"));
  const config = join(directory, "mcp.local.json");
  try {
    writeFileSync(config, JSON.stringify({
      ...existing, mcpServers: { ...configured, ...comateMcpSettings(servers, cwd) },
    }), { mode: 0o600 });
    // Comate may canonicalize the workspace before resolving its local file.
    const targets = [...new Set([target, join(realpathSync(cwd), ".comate", "mcp.local.json")])];
    return {
      preload: fileURLToPath(new URL("./mcpPreload.cjs", import.meta.url)),
      // Enables Comate 2.0's existing JSON stdin router for live MCP approvals.
      env: { COMATE_ACP_MCP_CONFIG: config, COMATE_ACP_MCP_TARGETS: JSON.stringify(targets), ZULU_MOBILE_MODE: "1" },
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
