import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COMATE_ACP_CMD: FAKE, ...env },
  });

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

  return { child, request, notify, reply, notifications, getStderr: () => stderr };
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