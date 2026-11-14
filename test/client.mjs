// Manual end-to-end driver: initialize → session/new → session/prompt against
// the real comatecli. Usage: node test/client.mjs "your prompt"
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "dist", "index.js");
const prompt = process.argv[2] ?? "只回复两个字：你好";

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "session/request_permission") {
    const tool = msg.params.toolCall;
    console.log(`  ? 权限请求: ${tool?.title} (${tool?.toolCallId})`);
    // Answer allow_once so the resume path is exercised too.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } })}\n`,
    );
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params.update;
    const text = u.content?.text ?? "";
    console.log(`  · ${u.sessionUpdate}${text ? `: ${JSON.stringify(text.slice(0, 60))}` : ""}`);
    return;
  }
  console.log(`  ← ${msg.method ?? "response"} ${JSON.stringify(msg.params ?? msg.result).slice(0, 200)}`);
});

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "comate-acp-client", version: "0.0.0" },
});
console.log("initialize:", JSON.stringify(init.agentInfo), "loadSession:", init.agentCapabilities?.loadSession);

const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
console.log("session/new:", created.sessionId);

console.log("prompt:");
const result = await request("session/prompt", {
  sessionId: created.sessionId,
  prompt: [{ type: "text", text: prompt }],
});
console.log("stopReason:", result.stopReason);
child.kill("SIGKILL");
process.exit(0);