import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResumeArgs, buildRunArgs, MODE_IDS } from "../dist/comateArgs.js";

test("run args: always headless and event-stream", () => {
  const args = buildRunArgs({ prompt: "hi", cwd: "/tmp" });
  assert.deepEqual(args, [
    "run", "-q", "hi", "--cwd", "/tmp", "-d", "event-stream",
    "--disable-auto-approve",
    "--on-requires-action", "suspend",
    "--requires-action-exit-code", "75",
  ]);
});

test("run args: optional flags are appended in a stable order", () => {
  const args = buildRunArgs({
    prompt: "hi",
    cwd: "/repo",
    conversationId: "conv-1",
    model: "ERNIE",
    effort: "high",
    mode: "Plan",
    activateSkills: ["a", "b"],
    attachFiles: ["/x.ts"],
    enableCodebaseSearch: true,
  });
  assert.deepEqual(args, [
    "run", "-q", "hi", "--cwd", "/repo", "-d", "event-stream",
    "-c", "conv-1",
    "-m", "ERNIE",
    "--effort", "high",
    "--mode", "Plan",
    "--enable-codebase-search",
    "--disable-auto-approve",
    "--on-requires-action", "suspend",
    "--requires-action-exit-code", "75",
    "--activate-skill", "a",
    "--activate-skill", "b",
    "--attach-file", "/x.ts",
  ]);
});

test("run args: thinking is only sent when explicitly set", () => {
  assert.ok(buildRunArgs({ prompt: "p", cwd: "/tmp" }).includes("--thinking") === false);
  assert.ok(buildRunArgs({ prompt: "p", cwd: "/tmp", thinking: true }).includes("true"));
});

test("resume args: approve carries the conversation and a fallback query", () => {
  const args = buildResumeArgs({ cwd: "/repo", conversationId: "c1", decision: "approve" });
  assert.ok(args.includes("--approve"));
  assert.ok(args.includes("-c"));
  assert.ok(args.includes("c1"));
  // comatecli requires -q even on resume.
  assert.equal(args[args.indexOf("-q") + 1], "继续");
});

test("resume args: reject and tool result payload", () => {
  const args = buildResumeArgs({
    cwd: "/repo",
    conversationId: "c1",
    decision: "reject",
    toolResult: { approved: false },
  });
  assert.ok(args.includes("--reject"));
  const idx = args.indexOf("--resume-tool-result");
  assert.ok(idx > 0);
  assert.deepEqual(JSON.parse(args[idx + 1]), { approved: false });
});

test("modes are the ones comatecli accepts via --mode", () => {
  assert.deepEqual([...MODE_IDS], ["Agent", "Plan", "Goal"]);
});