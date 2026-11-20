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

test("a new prompt skips loaded history even in a fresh adapter process", () => {
  const run = (name, skipInitialHistory = false) => {
    const text = [];
    const parser = new EventParser((event) => {
      if (event.type === "text") text.push(event.text);
    }, createParserState(), { skipInitialHistory });
    for (const line of readLines(name)) parser.ingest(JSON.parse(line));
    return text.join("");
  };

  assert.equal(run("multiturn-1.jsonl"), "A");
  assert.equal(run("multiturn-2.jsonl", true), "B", "第二轮不应带出第一轮的 A");
});

test("command approval resumes the same terminal message and forwards its answer and output once", () => {
  // Reduced real Comate 2.0 streams: suspension marks the assistant success,
  // reload marks it cancelled, then --approve appends to that same message.
  const state = createParserState();
  const events = [];
  for (const name of ["command-suspend.jsonl", "command-resume.jsonl"]) {
    const parser = new EventParser(event => events.push(event), state);
    for (const line of readLines(name)) parser.ingest(JSON.parse(line));
  }
  assert.equal(events.filter(e => e.type === "text").map(e => e.text).join(""), "CHECK_OK");
  assert.equal(events.filter(e => e.type === "tool_start").length, 1);
  const updates = events.filter(e => e.type === "tool_update");
  const completed = updates.filter(e => e.status === "completed");
  assert.equal(completed.length, 1, "waiting for approval must not count as completed");
  assert.equal(completed[0].rawOutput.metadata.output, "/tmp/approval-workspace\n");
  assert.equal(completed[0].rawOutput.metadata.exitCode, 0);
});

test("new elements arriving after a terminal message snapshot are still forwarded", () => {
  const events = [];
  const parser = new EventParser(event => events.push(event));
  const frame = children => ({ type: "partial-message-data", messages: [{
    id: "same-message", role: "assistant", status: "success", elements: [{ children }],
  }] });
  parser.ingest(frame([]));
  parser.ingest(frame([{ id: "answer", type: "TEXT", content: "late answer", end: true }]));
  parser.ingest(frame([{ id: "answer", type: "TEXT", content: "late answer", end: true }]));
  assert.deepEqual(events, [{ type: "text", messageId: "same-message", text: "late answer" }]);
});

test("skipping history preserves the current answer when the first snapshot is already a submit", () => {
  const events = [];
  const parser = new EventParser(event => events.push(event), createParserState(), { skipInitialHistory: true });
  const answer = (id, content) => ({ id, role: "assistant", status: "success", elements: [{
    children: [{ id: `${id}-text`, type: "TEXT", content, end: true }],
  }] });
  parser.ingest({ type: "conversation-messages", snapshotVersion: { mutation: "submit" }, messages: [
    { id: "old-user", role: "user" }, answer("old", "old answer"),
    { id: "new-user", role: "user" }, answer("new", "current answer"),
  ] });
  assert.deepEqual(events, [{ type: "text", messageId: "new", text: "current answer" }]);
});

test("history stays suppressed if its element ids change or it receives partial snapshots", () => {
  const events = [];
  const parser = new EventParser(event => events.push(event), createParserState(), { skipInitialHistory: true });
  const message = { id: "history", role: "assistant", status: "cancelled", elements: [{ children: [
    { id: "old-element", type: "TEXT", content: "old answer", end: true },
  ] }] };
  parser.ingest({ type: "conversation-messages", messages: [message] });
  message.elements[0].children[0].id = "regenerated-id";
  parser.ingest({ type: "conversation-messages", messages: [message] });
  parser.ingest({ type: "partial-message-data", messages: [{ ...message,
    tokenUsage: { contextUsed: 100, contextLimit: 1000 }, performanceMetrics: { firstTokenLatency: 100 },
  }] });
  parser.ingest({ type: "partial-message-elements", messageData: message });
  assert.deepEqual(events, []);
});

for (const expansion of ["before submit", "on submit", "after submit"]) {
  test(`paginated history expanding ${expansion} is excluded from output and token estimates`, () => {
    const events = [];
    const state = createParserState();
    const parser = new EventParser(event => events.push(event), state, { skipInitialHistory: true });
    const answer = (id, content) => ({ id, role: "assistant", elements: [{ children: [
      { id: `${id}-text`, type: "TEXT", content, end: true },
    ] }] });
    // Comate initially loads only the last three queries, then expands the
    // window. The older pages must never become output of the new prompt.
    const history = Array.from({ length: 5 }, (_, i) => [
      { id: `user-${i}`, role: "user" }, answer(`assistant-${i}`, "old answer"),
    ]).flat();
    const recent = history.slice(4);
    const current = [{ id: "current-user", role: "user" }, answer("current-answer", "RECONNECT_OK")];
    const snapshot = (mutation, messages) => parser.ingest({
      type: "conversation-messages", snapshotVersion: { mutation }, messages,
    });
    if (expansion === "before submit") snapshot("refresh", []);
    snapshot("refresh", recent);
    if (expansion === "before submit") snapshot("refresh", history);
    snapshot("submit", [...(expansion === "on submit" ? history : recent), ...current]);
    snapshot("refresh", [...history, ...current]);
    parser.ingest({ type: "partial-message-data", messages: [{ ...history[1],
      tokenUsage: { contextUsed: 999, contextLimit: 1000 },
      performanceMetrics: { firstTokenLatency: 999, totalDuration: 999 },
    }] });
    assert.deepEqual(events, [{ type: "text", messageId: "current-answer", text: "RECONNECT_OK" }]);
    assert.equal(parser.estimatedOutputTokens(), 3);

    // Approval restarts share the same prompt boundary, even if another old
    // page is first encountered by the new CLI process.
    const resumed = new EventParser(event => events.push(event), state);
    resumed.ingest({ type: "conversation-messages", messages: [
      answer("even-older", "old answer"), ...history, ...current,
    ] });
    assert.equal(events.length, 1);
    assert.equal(resumed.estimatedOutputTokens(), 0);
  });
}

test("tool output changes stream even when the tool status stays the same", () => {
  const events = [];
  const parser = new EventParser(event => events.push(event));
  const frame = output => ({ type: "partial-message-elements", messageData: { id: "message", elements: [{ children: [{
    id: "tool", type: "TOOL", toolName: "run_command", toolState: "executing", result: { metadata: { state: "running", output } },
  }] }] } });
  parser.ingest(frame("first\n"));
  parser.ingest(frame("first\nsecond\n"));
  parser.ingest(frame("first\nsecond\n"));
  const updates = events.filter(e => e.type === "tool_update");
  assert.deepEqual(updates.map(e => e.rawOutput.metadata.output), ["first\n", "first\nsecond\n"]);
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

test("turnStatus tracks completed/failed/cancelled and resets on Running", () => {
  const events = [];
  const parser = new EventParser((event) => events.push(event));
  assert.equal(parser.turnStatus, undefined);

  parser.ingest({ type: "conversation-status", conversationInfo: { id: "c1", status: "Running" } });
  assert.equal(parser.turnStatus, undefined);
  assert.equal(parser.finished, false);

  parser.ingest({ type: "conversation-status", conversationInfo: { id: "c1", status: "Completed" } });
  assert.equal(parser.turnStatus, "completed");
  assert.equal(parser.finished, true);

  parser.ingest({ type: "conversation-status", conversationInfo: { id: "c1", status: "Running" } });
  assert.equal(parser.turnStatus, undefined);
  assert.equal(parser.finished, false);

  parser.ingest({ type: "conversation-status", conversationInfo: { id: "c1", status: "Failed" } });
  assert.equal(parser.turnStatus, "failed");
  assert.equal(parser.finished, true);

  parser.ingest({ type: "conversation-status", conversationInfo: { id: "c1", status: "Cancelled" } });
  assert.equal(parser.turnStatus, "cancelled");
  assert.equal(parser.finished, true);
});
