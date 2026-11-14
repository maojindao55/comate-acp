#!/usr/bin/env node
// Stand-in for comatecli: replays a captured event-stream fixture so the ACP
// layer can be exercised without network, credentials or quota.
//
// Modes (driven by env):
//   FAKE_FIXTURE     fixture file to replay on `run` (required for run)
//   FAKE_EXIT_CODE   exit code for `run` (default 0; 75 = suspended on approval)
//   FAKE_PENDING     pending record JSON to return for `pending --json <cid>`
import { readFileSync } from "node:fs";

const [, , ...args] = process.argv;
const exitCode = Number(process.env.FAKE_EXIT_CODE ?? "0");

if (args[0] === "pending") {
  const record = process.env.FAKE_PENDING ?? `${process.cwd()}/.fake-pending.json`;
  try {
    process.stdout.write(`${readFileSync(record, "utf-8").trim()}\n`);
  } catch {
    process.stdout.write("[]\n");
  }
  process.exit(0);
}

const fixture = process.env.FAKE_FIXTURE;
if (!fixture) {
  process.stderr.write("fake comatecli: FAKE_FIXTURE not set\n");
  process.exit(2);
}

for (const line of readFileSync(fixture, "utf-8").split("\n")) {
  if (line.trim()) process.stdout.write(`${line}\n`);
}
// Noise that must never reach the JSON-RPC pipe.
process.stderr.write(`fake comatecli: unrelated noise (exit ${exitCode})\n`);
process.exit(exitCode);