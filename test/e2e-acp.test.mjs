import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const SERVER = new URL("../dist/index.js", import.meta.url).pathname;
const FAKE = new URL("./fake-comatecli.mjs", import.meta.url).pathname;

/**
 * Minimal hand-rolled ACP client over NDJSON stdio. Keeps the test honest about
 * what actually goes over the wire instead of trusting the SDK's own client.
 */
function startAgent(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "comate-acp-e2e-"));
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COMATE_ACP_HOME: home, COMATE_ACP_CMD: FAKE, ...env },
  });
  child.once("close", () => rmSync(home, { recursive: true, force: true }));

  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  let stderr = "";

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method) notifications.push(message);
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  /** Answers a server-initiated request (e.g. session/request_permission). */
  const reply = (id, result) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

  return { child, home, request, notify, reply, notifications, getStderr: () => stderr };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = predicate();
    if (found) return found;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("initialize advertises ACP capabilities", async () => {
  const agent = startAgent();
  try {
    const result = await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "comate-acp-test", version: "0.0.0" },
    });
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(result.agentCapabilities.loadSession, true);
    assert.deepEqual(result.agentCapabilities.mcpCapabilities, { http: true, sse: true });
    assert.equal(result.agentInfo.name, "comate-acp");
  } finally {
    agent.child.kill("SIGKILL");
  }
});

test("session/new then prompt streams chunks and ends the turn", async () => {
  const agent = startAgent({ FAKE_FIXTURE: new URL("./fixtures/text-turn.jsonl", import.meta.url).pathname });
  try {
    await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "0" },
    });

    const created = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] });
    assert.ok(created.sessionId, "应返回 sessionId");
    assert.ok(Array.isArray(created.configOptions), "应返回 configOptions");

    const before = agent.notifications.length;
    const prompt = await agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    assert.equal(prompt.stopReason, "end_turn");

    const updates = agent.notifications.slice(before).filter((n) => n.method === "session/update");
    const kinds = updates.map((n) => n.params.update.sessionUpdate);
    assert.ok(kinds.includes("agent_message_chunk"), `应有正文增量，实际 ${kinds.join(",")}`);
    assert.ok(kinds.includes("usage_update"), "应有 usage_update");
    // Every update must target the session we asked for.
    assert.ok(updates.every((n) => n.params.sessionId === created.sessionId));
  } finally {
    agent.child.kill("SIGKILL");
  }
});

test("a suspending turn surfaces session/request_permission", async () => {
  const agent = startAgent({
    FAKE_FIXTURE: new URL("./fixtures/tool-approval-turn.jsonl", import.meta.url).pathname,
    // 75 is the exit code the adapter passes to --requires-action-exit-code.
    FAKE_EXIT_CODE: "75",
    FAKE_PENDING: new URL("./fixtures/pending-record.json", import.meta.url).pathname,
  });
  try {
    await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const created = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const before = agent.notifications.length;
    const prompt = agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "run ls" }],
    });

    // The adapter asks the client for a decision. Answering "cancelled" (the
    // user dismissed the prompt) must end the turn without resuming comatecli.
    const ask = await waitFor(() => agent.notifications.find((n) => n.method === "session/request_permission"));
    assert.ok(ask, "应发出 session/request_permission");
    assert.equal(ask.params.sessionId, created.sessionId);
    assert.equal(ask.params.toolCall.toolCallId, "call_00_loajddw69ivh9ggijlamqpor");
    assert.deepEqual(
      ask.params.options.map((o) => o.optionId),
      ["allow_once", "reject_once"],
    );

    agent.reply(ask.id, { outcome: { outcome: "cancelled" } });

    const result = await prompt;
    assert.equal(result.stopReason, "cancelled");

    const updates = agent.notifications.slice(before).filter((n) => n.method === "session/update");
    const toolKinds = updates
      .map((n) => n.params.update)
      .filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
    assert.ok(toolKinds.length > 0, "应把 TOOL 元素映射成 tool_call");
  } finally {
    agent.child.kill("SIGKILL");
  }
});

test("comatecli stderr is reported on failure but never enters stdout", async () => {
  const agent = startAgent({
    FAKE_FIXTURE: new URL("./fixtures/text-turn.jsonl", import.meta.url).pathname,
    FAKE_EXIT_CODE: "1",
  });
  try {
    await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const created = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const before = agent.notifications.length;
    await assert.rejects(
      agent.request("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      }),
      (error) => {
        assert.match(error.message, /退出码 1/);
        // The stderr tail is what makes the failure diagnosable.
        assert.match(error.message, /unrelated noise/);
        return true;
      },
    );

    // Nothing on stdout may have been anything but JSON-RPC.
    assert.ok(agent.notifications.slice(before).every((n) => n.jsonrpc === "2.0"));
    assert.ok(agent.notifications.every((n) => n.method !== undefined || n.id !== undefined));
  } finally {
    agent.child.kill("SIGKILL");
  }
});

test("--version prints the package version and exits", async () => {
  const child = spawn(process.execPath, [SERVER, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  const stdout = await new Promise((resolve) => {
    let out = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.on("close", () => resolve(out));
  });
  assert.equal(stdout.trim(), pkg.version);
});

const TEXT_FIXTURE = new URL("./fixtures/text-turn.jsonl", import.meta.url).pathname;
const mcpServer = (name, value) => ({
  name, command: process.execPath, args: ["mcp.mjs"], env: [{ name: "HOST_TOKEN", value }],
});

async function mcpAgent(t, extraEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "comate-acp-host mcp-"));
  const calls = join(cwd, "calls.jsonl");
  const agent = startAgent({ FAKE_FIXTURE: TEXT_FIXTURE, FAKE_CALLS_FILE: calls, ...extraEnv });
  t.after(async () => {
    if (agent.child.exitCode === null && agent.child.signalCode === null) {
      const closed = new Promise(resolve => agent.child.once("close", resolve));
      agent.child.kill("SIGKILL"); await closed;
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  return {
    ...agent, cwd,
    runs: () => readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse),
    prompt: sessionId => agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "probe" }] }),
  };
}

test("MCP injection survives turns, replaces on load, clears with an empty list, and never enters session storage", { timeout: 10000 }, async (t) => {
  const agent = await mcpAgent(t);
  mkdirSync(join(agent.cwd, ".comate"));
  const local = join(agent.cwd, ".comate", "mcp.local.json");
  const original = JSON.stringify({ mcpServers: { keep: { command: "user-command" } } });
  writeFileSync(local, original);
  const { sessionId } = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("freebuddy_browser", "old-token")] });
  await agent.prompt(sessionId);
  await agent.request("session/set_mode", { sessionId, modeId: "Plan" });
  await agent.prompt(sessionId);
  await agent.request("session/load", { sessionId, cwd: agent.cwd, mcpServers: [mcpServer("freebuddy_skill", "new-token")] });
  await agent.prompt(sessionId);
  await agent.request("session/load", { sessionId, cwd: agent.cwd, mcpServers: [] });
  await agent.prompt(sessionId);
  const runs = agent.runs();
  assert.equal(runs.length, 4);
  for (const run of runs.slice(0, 2)) assert.equal(run.config.mcpServers.freebuddy_browser.env.HOST_TOKEN, "old-token");
  assert.equal(runs[2].config.mcpServers.freebuddy_browser, undefined);
  assert.equal(runs[2].config.mcpServers.freebuddy_skill.env.HOST_TOKEN, "new-token");
  assert.deepEqual(runs[3].config, JSON.parse(original));
  assert.equal(runs[3].overlay, undefined);
  assert.ok(runs.every(run => run.config.mcpServers.keep.command === "user-command"));
  assert.equal(readFileSync(local, "utf8"), original);
  const stored = readFileSync(join(agent.home, "sessions.json"), "utf8");
  assert.doesNotMatch(stored, /old-token|new-token|freebuddy_browser|freebuddy_skill/);
  assert.ok(await waitFor(() => runs.slice(0, 3).every(run => !existsSync(run.overlay))), "temporary configs are removed after exit");
});

test("concurrent ACP sessions in one workspace receive only their own MCP endpoints", { timeout: 10000 }, async (t) => {
  const agent = await mcpAgent(t);
  const first = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("host", "first")] });
  const second = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("host", "second")] });
  await Promise.all([agent.prompt(first.sessionId), agent.prompt(second.sessionId)]);
  const runs = agent.runs();
  assert.deepEqual(runs.map(run => run.config.mcpServers.host.env.HOST_TOKEN).sort(), ["first", "second"]);
  assert.notEqual(runs[0].overlay, runs[1].overlay);
  assert.equal(existsSync(join(agent.cwd, ".comate")), false);
});

test("approval resume receives the same host MCP configuration", { timeout: 10000 }, async (t) => {
  const agent = await mcpAgent(t, {
    FAKE_FIXTURE: new URL("./fixtures/tool-approval-turn.jsonl", import.meta.url).pathname,
    FAKE_RESUME_FIXTURE: TEXT_FIXTURE, FAKE_EXIT_CODE: "75",
  });
  const { sessionId } = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("host", "approval-token")] });
  const prompt = agent.prompt(sessionId);
  const ask = await waitFor(() => agent.notifications.find(message => message.method === "session/request_permission"));
  assert.ok(ask);
  agent.reply(ask.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
  assert.equal((await prompt).stopReason, "end_turn");
  const runs = agent.runs();
  assert.equal(runs.length, 2);
  assert.ok(runs[1].args.includes("--approve"));
  assert.ok(runs.every(run => run.config.mcpServers.host.env.HOST_TOKEN === "approval-token"));
  assert.ok(await waitFor(() => runs.every(run => !existsSync(run.overlay))));
});

test("MCP snapshots are cleaned up when the CLI fails", { timeout: 10000 }, async (t) => {
  const agent = await mcpAgent(t, { FAKE_EXIT_CODE: "1" });
  const { sessionId } = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("host", "failure-token")] });
  await assert.rejects(agent.prompt(sessionId), /退出码 1/);
  assert.ok(await waitFor(() => agent.runs().every(run => !existsSync(run.overlay))));
});

test("cancelling an active turn removes its MCP snapshot", { timeout: 10000 }, async (t) => {
  const agent = await mcpAgent(t, { FAKE_RUN_DELAY_MS: "30000" });
  const { sessionId } = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("host", "cancel-token")] });
  const prompt = agent.prompt(sessionId);
  assert.ok(await waitFor(() => {
    try { return agent.runs().length === 1; } catch { return false; }
  }));
  const [{ overlay }] = agent.runs();
  assert.equal(existsSync(overlay), true);
  agent.notify("session/cancel", { sessionId });
  assert.equal((await prompt).stopReason, "cancelled");
  assert.ok(await waitFor(() => !existsSync(overlay)));
});

test("reconnecting loads the new MCP endpoint instead of an old stored credential", { timeout: 10000 }, async (t) => {
  const first = await mcpAgent(t);
  const { sessionId } = await first.request("session/new", { cwd: first.cwd, mcpServers: [mcpServer("host", "expired-token")] });
  await first.prompt(sessionId);
  // Reuse the durable session mapping in a separate adapter process.
  const second = await mcpAgent(t, { COMATE_ACP_HOME: first.home });
  await second.request("session/load", { sessionId, cwd: second.cwd, mcpServers: [mcpServer("host", "current-token")] });
  await second.prompt(sessionId);
  assert.equal(second.runs()[0].config.mcpServers.host.env.HOST_TOKEN, "current-token");
  const stored = readFileSync(join(first.home, "sessions.json"), "utf8");
  assert.doesNotMatch(stored, /expired-token|current-token/);
});

for (const decision of ["approve", "reject", "cancelled"]) {
  test(`legacy live MCP approval forwards ${decision} without restarting the CLI`, { timeout: 10000 }, async (t) => {
    const decisionsFile = join(tmpdir(), `comate-acp-decision-${process.pid}-${decision}.jsonl`);
    t.after(() => rmSync(decisionsFile, { force: true }));
    const agent = await mcpAgent(t, { FAKE_LIVE_APPROVAL: "1", FAKE_DECISIONS_FILE: decisionsFile });
    const { sessionId } = await agent.request("session/new", { cwd: agent.cwd, mcpServers: [mcpServer("host", "live-token")] });
    const prompt = agent.prompt(sessionId);
    const ask = await waitFor(() => agent.notifications.find(message => message.method === "session/request_permission"));
    assert.ok(ask);
    assert.equal(ask.params.toolCall.toolCallId, "live-tool");
    agent.reply(ask.id, { outcome: decision === "cancelled" ? { outcome: "cancelled" } : {
      outcome: "selected", optionId: decision === "approve" ? "allow_once" : "reject_once",
    } });
    assert.equal((await prompt).stopReason, decision === "cancelled" ? "cancelled" : "end_turn");
    assert.equal(agent.notifications.filter(message => message.method === "session/request_permission").length, 1);
    const runs = agent.runs();
    assert.equal(runs.length, 1, "live MCP approval must keep the original process");
    if (decision === "cancelled") assert.equal(existsSync(decisionsFile), false);
    else {
      const action = JSON.parse(readFileSync(decisionsFile, "utf8"));
      assert.equal(action.name, decision === "approve" ? "confirm" : "reject");
      assert.equal(action.conversationId, "live-conversation");
      assert.equal(action.toolId, "live-tool");
    }
    assert.ok(await waitFor(() => runs.every(run => !existsSync(run.overlay))));
  });
}
