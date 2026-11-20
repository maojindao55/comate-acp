import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isComateStderrNoise,
  isGracefulExitCleanupError,
  StderrTail,
} from "../dist/stderr.js";

const WINDOWS_CLEANUP_STDERR = [
  "2026-11-20T04:29:48.263Z [Langfuse SDK] [WARN] Span attribute langfuse.trace.metadata is not a stringified object. Skipping media handling.",
  "2026-11-20T04:29:48.371Z [Langfuse SDK] [WARN] Span attribute langfuse.trace.metadata is not a stringified object. Skipping media handling.",
  "Error during graceful exit:",
  "Tips：可进入如流群（12199111）获得帮助",
  " AggregateError: agent-core provider cleanup failed (2)",
  "    at InProcessKernelProvider.disposeOnce (file:///C:/Users/Administrator/AppData/Roaming/FreeBuddy/freebuddy/node-cli/node_modules/@comate/comatecli/dist/zulu/chunk-riLt5CoU.js:1027:809998) {",
  "  [errors]: [",
  "    AggregateError: RuntimeLifecycle 释放失败（1 个资源）",
  "        at RuntimeLifecycle.disposeOwned (file:///C:/Users/Administrator/AppData/Roaming/FreeBuddy/freebuddy/node-cli/node_modules/@comate/comatecli/dist/zulu/chunk-riLt5CoU.js:52:160887)",
  "    AggregateError: ProcessSupervisor shutdown failed (1)",
  "        at ProcessSupervisor.shutdownAll (file:///C:/Users/Administrator/AppData/Roaming/FreeBuddy/freebuddy/node-cli/node_modules/@comate/comatecli/dist/zulu/chunk-riLt5CoU.js:52:179392)",
  "  ]",
  "}",
].join("\n");

test("isComateStderrNoise detects Langfuse SDK warning lines", () => {
  assert.equal(
    isComateStderrNoise("2026-11-20T04:27:50.118Z [Langfuse SDK] [WARN] Span attribute langfuse.trace.metadata is not a stringified object."),
    true,
  );
  assert.equal(isComateStderrNoise("Error during graceful exit:"), false);
  assert.equal(isComateStderrNoise("Error: upstream timeout"), false);
});

test("StderrTail filters split Langfuse warning chunks and preserves real errors", () => {
  const tail = new StderrTail(4000);
  tail.push("2026-11-20T04:27:50.118Z [Langfuse SDK] ");
  tail.push("[WARN] Span attribute langfuse.trace.metadata is not a stringified object.\r\n");
  tail.push("Error: real failure\r\n");
  tail.push("2026-11-20T04:27:51.000Z [Langfuse SDK] [WARN] trailing warning without newline");

  assert.equal(tail.text(), "Error: real failure");
});

test("StderrTail drops oldest whole lines when exceeding maxChars", () => {
  const tail = new StderrTail(24);
  tail.push("line-1-oldest\n");
  tail.push("line-2-middle\n");
  tail.push("line-3-newest\n");

  assert.equal(tail.text(), "line-3-newest");

  const multi = new StderrTail(30);
  multi.push("alpha-line\nbeta-line\ngamma-line\n");
  assert.equal(multi.text(), "beta-line\ngamma-line");
});

test("isGracefulExitCleanupError matches post-turn provider cleanup failures only", () => {
  assert.equal(isGracefulExitCleanupError(WINDOWS_CLEANUP_STDERR), true);
  assert.equal(
    isGracefulExitCleanupError("Error during graceful exit:\nError: Exit cleanup timed out"),
    true,
  );

  assert.equal(isGracefulExitCleanupError("Error: upstream timeout"), false);
  assert.equal(
    isGracefulExitCleanupError("Error: No license or token provided.\nTips：可进入如流群（12199111）获得帮助"),
    false,
  );
  assert.equal(isGracefulExitCleanupError("Error during graceful exit:\nError: something else"), false);
  assert.equal(
    isGracefulExitCleanupError(
      "Unhandled rejection: Boom\nError during graceful exit:\nAggregateError: agent-core provider cleanup failed (1)",
    ),
    false,
  );
  assert.equal(
    isGracefulExitCleanupError(
      "Uncaught exception: Boom\nError during graceful exit:\nAggregateError: ProcessSupervisor shutdown failed (1)",
    ),
    false,
  );
  assert.equal(
    isGracefulExitCleanupError(
      "Error: Conversation failed or cancelled\nError during graceful exit:\nAggregateError: agent-core provider cleanup failed (2)",
    ),
    false,
  );
  assert.equal(
    isGracefulExitCleanupError(
      "Warning: pending action for conv-1 is stale (older than 24h); resuming anyway.\n" + WINDOWS_CLEANUP_STDERR,
    ),
    true,
  );
});
