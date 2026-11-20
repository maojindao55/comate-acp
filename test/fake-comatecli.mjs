#!/usr/bin/env node
// Stand-in for comatecli: replays a captured event-stream fixture so the ACP
// layer can be exercised without network, credentials or quota.
//
// Modes (driven by env):
//   FAKE_FIXTURE     fixture file to replay on `run` (required for run)
//   FAKE_EXIT_CODE   exit code for `run` (default 0; 75 = suspended on approval)
//   FAKE_PENDING     pending record JSON to return for `pending --json <cid>`
import { appendFileSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [, , ...args] = process.argv;
const exitCode = Number(process.env.FAKE_EXIT_CODE ?? "0");

if (args[0] === "status") {
  const statusCode = Number(process.env.FAKE_STATUS_CODE ?? "0");
  if (process.env.FAKE_STATUS_STDOUT) process.stdout.write(process.env.FAKE_STATUS_STDOUT);
  if (process.env.FAKE_STATUS_STDERR) process.stderr.write(process.env.FAKE_STATUS_STDERR);
  process.exit(statusCode);
}

if (args[0] === "logout") {
  if (process.env.FAKE_LOGOUT_FILE) {
    appendFileSync(process.env.FAKE_LOGOUT_FILE, JSON.stringify({ args }) + "\n");
  }
  const logoutCode = Number(process.env.FAKE_LOGOUT_CODE ?? "0");
  if (process.env.FAKE_LOGOUT_STDERR) process.stderr.write(process.env.FAKE_LOGOUT_STDERR);
  process.exit(logoutCode);
}

if (args[0] === "login") {
  if (process.env.FAKE_LOGIN_ARGS_FILE) {
    appendFileSync(process.env.FAKE_LOGIN_ARGS_FILE, JSON.stringify({ args }) + "\n");
  }
  process.exit(Number(process.env.FAKE_LOGIN_CODE ?? "0"));
}

if (args[0] === "model" && args[1] === "list") {
  if (process.env.FAKE_MODELS_STDOUT) process.stdout.write(process.env.FAKE_MODELS_STDOUT);
  process.exit(Number(process.env.FAKE_MODELS_CODE ?? "0"));
}

if (args[0] === "run" && process.env.FAKE_CALLS_FILE) {
  const cwd = args[args.indexOf("--cwd") + 1];
  const local = join(cwd, ".comate", "mcp.local.json");
  let config;
  try {
    if ((await stat(local)).isFile()) config = JSON.parse(await readFile(local, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify({ pid: process.pid, args, config, overlay: process.env.COMATE_ACP_MCP_CONFIG }) + "\n");
}
if (args[0] === "run" && process.env.FAKE_RUN_DELAY_MS) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_RUN_DELAY_MS)));
}

if (args[0] === "pending") {
  const record = process.env.FAKE_PENDING ?? `${process.cwd()}/.fake-pending.json`;
  try {
    process.stdout.write(`${readFileSync(record, "utf-8").trim()}\n`);
  } catch {
    process.stdout.write("[]\n");
  }
  process.exit(0);
}

if (args[0] === "run" && process.env.FAKE_LIVE_APPROVAL) {
  if (process.env.ZULU_MOBILE_MODE !== "1") throw new Error("stdin router is disabled");
  const frame = { type: "pending-approvals", conversationInfo: { id: "live-conversation", status: "Running" }, pendingApprovals: [{
    conversationId: "live-conversation", toolId: "live-tool", toolName: "use_mcp_tool", approvalKind: "legacy",
    params: { server_name: "host", tool_name: "echo", arguments: "{}" },
  }] };
  process.stdout.write(JSON.stringify(frame) + "\n" + JSON.stringify(frame) + "\n");
  await new Promise(resolve => createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message?.type !== "stdin_action") return;
    appendFileSync(process.env.FAKE_DECISIONS_FILE, JSON.stringify(message) + "\n");
    resolve();
  }));
}

const resuming = args.includes("--approve") || args.includes("--reject");
const fixture = resuming ? process.env.FAKE_RESUME_FIXTURE ?? process.env.FAKE_FIXTURE
  : args.includes("-c") ? process.env.FAKE_CONTINUE_FIXTURE ?? process.env.FAKE_FIXTURE : process.env.FAKE_FIXTURE;
if (!fixture) {
  process.stderr.write("fake comatecli: FAKE_FIXTURE not set\n");
  process.exit(2);
}

for (const line of readFileSync(fixture, "utf-8").split("\n")) {
  if (line.trim()) process.stdout.write(`${line}\n`);
}
if (!resuming && process.env.FAKE_CLOSE_DELAY_MS) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CLOSE_DELAY_MS)));
}
// Noise that must never reach the JSON-RPC pipe.
process.stderr.write(process.env.FAKE_STDERR ?? `fake comatecli: unrelated noise (exit ${exitCode})\n`);
process.exit(resuming && process.env.FAKE_RESUME_FIXTURE ? 0 : exitCode);
