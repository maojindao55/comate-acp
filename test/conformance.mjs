// Protocol conformance sweep against the real comatecli.
// Not part of `npm test`: it spends quota and needs credentials.
//
//   node test/conformance.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "dist", "index.js");

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const pending = new Map();
const updates = [];
const log = (...args) => console.log(...args);
let failures = 0;

const check = (label, ok, detail = "") => {
  if (ok) log(`  ✓ ${label}`);
  else {
    failures += 1;
    log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    updates.push(msg.params);
    return;
  }
  if (msg.method === "session/request_permission") {
    log(`  ! 权限请求 ${msg.params.toolCall?.title}，自动批准`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: "allow_once" } },
      })}\n`,
    );
    return;
  }
  log(`  ← ${msg.method} ${JSON.stringify(msg.params ?? "").slice(0, 160)}`);
});

child.stderr.setEncoding("utf-8");
child.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const mark = () => updates.length;
const since = (from) => updates.slice(from);
const kinds = (from) => since(from).map((u) => u.update.sessionUpdate);
const textOf = (from) =>
  since(from)
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update.content?.text ?? "")
    .join("");

log("\n# initialize");
const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "conformance", version: "0" },
});
check("protocolVersion 回显", init.protocolVersion === 1, JSON.stringify(init.protocolVersion));
check("loadSession 声明", init.agentCapabilities?.loadSession === true);
check("authMethods 非空", Array.isArray(init.authMethods) && init.authMethods.length > 0);

log("\n# session/new");
const created = await request("session/new", { cwd: "/tmp", mcpServers: [] });
check("返回 sessionId", typeof created.sessionId === "string");
check("返回 modes", created.modes?.currentModeId === "Agent");
check("返回 configOptions", Array.isArray(created.configOptions));
const sid = created.sessionId;

log("\n# session/prompt 第一轮（单轮问答）");
let from = mark();
let res = await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "只回复两个字：你好。不要调用任何工具。" }] });
check("stopReason=end_turn", res.stopReason === "end_turn", res.stopReason);
check("有正文增量", kinds(from).includes("agent_message_chunk"));
check("有 usage_update", kinds(from).includes("usage_update"));
const firstAnswer = textOf(from);

log("\n# session/prompt 第二轮（多轮上下文应经 -c 续接）");
from = mark();
res = await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "我刚才让你回复什么？只回那两个字。" }] });
check("stopReason=end_turn", res.stopReason === "end_turn", res.stopReason);
const secondAnswer = textOf(from);
check("记得上下文", secondAnswer.includes("你好"), JSON.stringify(secondAnswer.slice(0, 80)));

log("\n# session/set_mode");
from = mark();
await request("session/set_mode", { sessionId: sid, modeId: "Plan" });
const modeUpdate = since(from).find((u) => u.update.sessionUpdate === "current_mode_update");
check("收到 current_mode_update", modeUpdate?.update.currentModeId === "Plan", JSON.stringify(modeUpdate?.update));

log("\n# session/set_config_option");
const cfg = await request("session/set_config_option", { sessionId: sid, configId: "effort", value: "high" });
const effort = cfg.configOptions?.find((o) => o.id === "effort");
check("effort 已生效", effort?.currentValue === "high", JSON.stringify(effort));

log("\n# session/list / session/load");
const list = await request("session/list", {});
check("列出本会话", list.sessions?.some((s) => s.sessionId === sid));
const loaded = await request("session/load", { sessionId: sid, cwd: "/tmp", mcpServers: [] });
check("load 返回 modes", loaded?.modes?.currentModeId === "Plan", JSON.stringify(loaded?.modes?.currentModeId));

log("\n# session/cancel（长任务应立即中断）");
from = mark();
const longRun = request("session/prompt", {
  sessionId: sid,
  prompt: [{ type: "text", text: "从 1 数到 400，每个数字单独一行，不要停。" }],
});
await new Promise((r) => setTimeout(r, 4000));
const producedBeforeCancel = kinds(from).filter((k) => k === "agent_message_chunk").length;
notify("session/cancel", { sessionId: sid });
const cancelRes = await longRun;
check("取消后 stopReason=cancelled", cancelRes.stopReason === "cancelled", cancelRes.stopReason);
check("取消前确实在产出", producedBeforeCancel > 0, `chunks=${producedBeforeCancel}`);

log("\n# 未知会话的错误路径");
let errored = false;
try {
  await request("session/prompt", { sessionId: "does-not-exist", prompt: [{ type: "text", text: "hi" }] });
} catch (error) {
  errored = true;
  check("报 -32602", String(error.message).includes("-32602"), error.message);
}
check("未知会话应报错", errored);

log("\n# session/delete");
await request("session/delete", { sessionId: sid });
const afterDelete = await request("session/list", {});
check("删除后不再列出", !afterDelete.sessions?.some((s) => s.sessionId === sid));

log(`\n首轮回答: ${JSON.stringify(firstAnswer.slice(0, 60))}`);
log(`次轮回答: ${JSON.stringify(secondAnswer.slice(0, 60))}`);
log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);

child.kill("SIGKILL");
process.exit(failures === 0 ? 0 : 1);