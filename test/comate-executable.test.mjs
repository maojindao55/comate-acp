import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveComateExecutable, resolveComateNodeLauncher } from "../dist/comateExecutable.js";
import { spawnComate } from "../dist/spawn.js";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "comate npm 安装 & spaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function npmPackage(root, bin = { comatecli: "./bin/zulu-tui.mjs" }) {
  const pkg = join(root, "node_modules", "@comate", "comatecli");
  const entry = join(pkg, "bin", "zulu-tui.mjs");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@comate/comatecli", bin }));
  writeFileSync(entry, "console.log(JSON.stringify({args:process.argv.slice(2),preload:process.env.COMATE_TEST_PRELOAD??null}))");
  return entry;
}

test("Windows CLI lookup supports Path casing, quoted directories and npm .cmd before extensionless shims", t => {
  const root = workspace(t);
  const first = join(root, "not-installed"); mkdirSync(first);
  mkdirSync(join(first, "comatecli.cmd")); // A directory must not count as a CLI.
  writeFileSync(join(root, "comatecli"), "#!/bin/sh\nexit 1");
  const cmd = join(root, "comatecli.cmd"); writeFileSync(cmd, "@echo off");
  const found = resolveComateExecutable({ Path: `${first};"${root}"` }, { platform: "win32", home: root });
  assert.equal(found, cmd);
});

test("Windows CLI lookup finds the npm user prefix when the desktop PATH is stale", t => {
  const root = workspace(t), prefix = join(root, "AppData", "npm"); mkdirSync(prefix, { recursive: true });
  const cmd = join(prefix, "comatecli.cmd"); writeFileSync(cmd, "@echo off");
  assert.equal(resolveComateExecutable({ APPDATA: join(root, "AppData"), Path: "" }, { platform: "win32", home: root }), cmd);
});

test("Windows CLI lookup supports an explicit npm prefix and keeps COMATE_ACP_CMD authoritative", t => {
  const root = workspace(t), cmd = join(root, "comatecli.cmd"); writeFileSync(cmd, "@echo off");
  assert.equal(resolveComateExecutable({ NPM_CONFIG_PREFIX: root }, { platform: "win32", home: root }), cmd);
  const override = join(root, "custom", "comatecli.exe");
  assert.equal(resolveComateExecutable({ COMATE_ACP_CMD: override, PATH: root }), override);
});

for (const suffix of [".cmd", ".ps1", ""]) {
  for (const preloadEnabled of [false, true]) {
    test(`npm ${suffix || "shell"} shim launches through Node with MCP preload=${preloadEnabled}`, async t => {
      const root = workspace(t);
      const entry = npmPackage(root, suffix === ".ps1" ? "./bin/zulu-tui.mjs" : undefined);
      const shim = join(root, `comatecli${suffix}`);
      writeFileSync(shim, "npm shim: this file must never be executed or parsed as JavaScript");
      assert.equal(resolveComateNodeLauncher(shim), realpathSync(entry));
      const preload = join(root, "preload.cjs");
      writeFileSync(preload, "process.env.COMATE_TEST_PRELOAD='loaded';");
      const args = ["model", "list", "--ids", 'value with spaces & "quotes"'];
      const child = spawnComate(shim, args, { env: { ...process.env, COMATE_TEST_PRELOAD: "" }, stdio: ["ignore", "pipe", "pipe"] }, preloadEnabled ? preload : undefined);
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => stdout += chunk);
      child.stderr.on("data", chunk => stderr += chunk);
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, stderr);
      assert.equal(child.spawnfile, process.execPath);
      assert.deepEqual(JSON.parse(stdout), { args, preload: preloadEnabled ? "loaded" : "" });
    });
  }
}

test("missing or incomplete npm installs give an actionable MCP error", t => {
  const root = workspace(t), shim = join(root, "comatecli.cmd"); writeFileSync(shim, "@echo off");
  assert.throws(() => spawnComate(shim, [], {}, "/preload.cjs"), /npm install -g @comate\/comatecli/);
  const entry = npmPackage(root); rmSync(entry);
  assert.equal(resolveComateNodeLauncher(shim), undefined);
});

test("a native .exe override is not replaced by an adjacent npm install", t => {
  const root = workspace(t); npmPackage(root);
  const exe = join(root, "comatecli.exe"); writeFileSync(exe, "native binary");
  assert.equal(resolveComateNodeLauncher(exe), undefined);
  assert.throws(() => spawnComate(exe, [], {}, "/preload.cjs"), /npm Node.js version/);
});

test("spawnComate defaults ZULU_EDIT_PATCH_MODE to 0 and preserves explicit overrides", async t => {
  const root = workspace(t);
  const probe = join(root, "env-probe.mjs");
  writeFileSync(probe, "process.stdout.write(JSON.stringify({ mode: process.env.ZULU_EDIT_PATCH_MODE ?? null }))");

  const runProbe = async (env) => {
    const child = spawnComate(probe, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };

  const cleanEnv = { ...process.env };
  delete cleanEnv.ZULU_EDIT_PATCH_MODE;
  assert.deepEqual(await runProbe(cleanEnv), { mode: "0" });
  assert.deepEqual(await runProbe({ ...cleanEnv, ZULU_EDIT_PATCH_MODE: "1" }), { mode: "1" });
});
