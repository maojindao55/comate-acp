import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EventParser, createParserState } from "../dist/eventParser.js";

function readLines(name) {
  const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
  return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

function parseFixture(name) {
  const events = [];
  const parser = new EventParser((event) => events.push(event));
  let lines = 0;
  for (const line of readLines(name)) {
    parser.ingest(JSON.parse(line));
    lines += 1;
  }
  return { events, parser, lines };
}

test("text turn: emits incremental text without duplicating the snapshot prefix", () => {
  const { events, parser, lines } = parseFixture("text-turn.jsonl");
  assert.ok(lines > 20, `fixture 应有较多帧，实际 ${lines}`);

  const text = events.filter((e) => e.type === "text");
  assert.ok(text.length > 0, "应至少产出一段 text");
  assert.equal(parser.finished, true, "conversation-status Completed 应结束 turn");

  // The snapshot repeats accumulated content; concatenated deltas must still
  // reconstruct the visible answer exactly once.
  const joined = text.map((e) => e.text).join("");
  assert.ok(
    joined.includes("hello-from-comate"),
    `拼接结果应包含正文，实际: ${joined.slice(0, 200)}`,
  );
  // The snapshot repeats the whole accumulated content on every frame; a
  // duplicated prefix means the suffix bookkeeping is off.
  assert.ok(!joined.includes("我先向你确认一下，得到你的同意后再执行。我先向你确认一下"),
    "不应把快照前缀重复发出");

  const usage = events.filter((e) => e.type === "usage");
  assert.ok(usage.length > 0, "应产出 usage");
  assert.equal(usage[0].size, 1000000);
  assert.ok(usage[0].used > 0);
  // tokenUsage repeats on every snapshot; a client should not hear it twice.
  const signatures = usage.map((e) => `${e.used}/${e.size}`);
  assert.equal(new Set(signatures).size, signatures.length, "相同的 usage 不应重复上报");
});

test("tool turn: tool_call then tool_update through the state machine", () => {
  const { events } = parseFixture("tool-approval-turn.jsonl");

  const starts = events.filter((e) => e.type === "tool_start");
  const updates = events.filter((e) => e.type === "tool_update");
  assert.equal(starts.length, 1, "每个工具只应发一次 tool_start");
  assert.ok(updates.length >= 1, "状态变化应产生 tool_update");

  const start = starts[0];
  assert.equal(start.toolCallId, "call_00_loajddw69ivh9ggijlamqpor");
  assert.equal(start.kind, "execute", "run_command 应映射为 execute");
  assert.equal(start.rawInput.command, "ls /tmp");

  const statuses = updates.map((e) => e.status);
  assert.ok(statuses.includes("in_progress"), `应包含 in_progress，实际 ${statuses.join(",")}`);
  assert.equal(new Set(statuses).size, statuses.length, "同一状态不应重复上报");
});

test("thought chunks are separated from answer text", () => {
  const { events } = parseFixture("tool-approval-turn.jsonl");
  const thoughts = events.filter((e) => e.type === "thought");
  assert.ok(thoughts.length > 0, "REASON 元素应产出 thought");
  assert.ok(
    thoughts.every((e) => e.text.length > 0),
    "thought 文本不应为空",
  );
});

test("a resumed turn does not replay the previous answer", () => {
  // comatecli replays the whole conversation when a turn is continued with -c,
  // and neither message ids nor element ids stay stable, so identity has to
  // come from "this message already finished".
  const state = createParserState();
  const run = (name) => {
    const text = [];
    const parser = new EventParser((event) => {
      if (event.type === "text") text.push(event.text);
    }, state);
    for (const line of readLines(name)) parser.ingest(JSON.parse(line));
    return text.join("");
  };

  assert.equal(run("multiturn-1.jsonl"), "A");
  assert.equal(run("multiturn-2.jsonl"), "B", "第二轮不应带出第一轮的 A");
});

test("parser ignores malformed and unknown frames", () => {
  const events = [];
  const parser = new EventParser((event) => events.push(event));
  parser.ingest(null);
  parser.ingest("not an object");
  parser.ingest({ type: "pending-approvals", pendingApprovals: [] });
  parser.ingest({ type: "some-future-frame" });
  parser.ingest({ type: "conversation-status", conversationInfo: { status: "Running" } });
  assert.deepEqual(events, [], "非终态/未知帧不应产出事件");
  assert.equal(parser.finished, false);
});

test("legacy MCP pending approvals emit live actions only for the current conversation", () => {
  const events = [];
  const parser = new EventParser(event => events.push(event));
  const approval = { toolId: "tool-1", toolName: "use_mcp_tool", approvalKind: "legacy", params: { server_name: "host", tool_name: "echo" } };
  parser.ingest({ type: "pending-approvals", conversationInfo: { id: "current" }, pendingApprovals: [
    { ...approval, conversationId: "current" },
    { ...approval, conversationId: "other" },
    { ...approval, conversationId: "current", toolName: "run_command" },
    null,
  ] });
  assert.deepEqual(events, [{ type: "live_approval", payload: {
    conversationId: "current", toolId: "tool-1", toolName: "use_mcp_tool", payload: approval.params,
  } }]);
});
