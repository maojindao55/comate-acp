import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { comateMcpSettings, createMcpOverlay, validateMcpServers } from "../dist/mcp.js";
import { spawnComate } from "../dist/spawn.js";

const server = (name, value = "secret") => ({
  name, command: process.execPath, args: ["echo.mjs"], env: [{ name: "TOKEN", value }],
});

function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), "comate-acp-mcp-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("ACP transports map to Comate's native MCP settings", () => {
  const config = comateMcpSettings([
    server("freebuddy_browser"),
    { type: "http", name: "http", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "token" }] },
    { type: "sse", name: "sse", url: "https://example.com/sse", headers: [] },
  ], "/repo");
  assert.deepEqual(config.freebuddy_browser, {
    transportType: "stdio", command: process.execPath, args: ["echo.mjs"], env: { TOKEN: "secret" }, cwd: "/repo",
  });
  assert.equal(config.http.transportType, "streamableHttp");
  assert.deepEqual(config.http.headers, { Authorization: "token" });
  assert.equal(config.sse.transportType, "sse");
});

test("unsupported ACP transport and duplicate names are rejected", () => {
  assert.throws(() => validateMcpServers([{ type: "acp", name: "acp", serverId: "id" }]), /ACP transport/);
  assert.throws(() => validateMcpServers([server("same"), server("same")]), /unique/);
  const input = [server("copy")];
  const copy = validateMcpServers(input);
  input[0].env[0].value = "changed";
  assert.equal(copy[0].env[0].value, "secret");
});

test("overlay preserves JSONC local settings and isolates concurrent sessions", (t) => {
  const cwd = workspace(t);
  mkdirSync(join(cwd, ".comate"));
  const local = join(cwd, ".comate", "mcp.local.json");
  const original = '{ // user comment\n "mcpServers": {"keep": {"command":"keep"}, "host": {"command":"old"}}, "extra":true, }';
  writeFileSync(local, original);
  const first = createMcpOverlay([server("host", "one")], cwd);
  const second = createMcpOverlay([server("host", "two")], cwd);
  t.after(first.dispose); t.after(second.dispose);
  assert.notEqual(first.env.COMATE_ACP_MCP_CONFIG, second.env.COMATE_ACP_MCP_CONFIG);
  const config = JSON.parse(readFileSync(first.env.COMATE_ACP_MCP_CONFIG, "utf8"));
  assert.equal(config.mcpServers.keep.command, "keep");
  assert.equal(config.extra, true);
  assert.equal(config.mcpServers.host.env.TOKEN, "one");
  assert.equal(JSON.parse(readFileSync(second.env.COMATE_ACP_MCP_CONFIG, "utf8")).mcpServers.host.env.TOKEN, "two");
  assert.equal(readFileSync(local, "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal(statSync(first.env.COMATE_ACP_MCP_CONFIG).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(first.env.COMATE_ACP_MCP_CONFIG)).mode & 0o777, 0o700);
  }
  first.dispose();
  assert.equal(existsSync(first.env.COMATE_ACP_MCP_CONFIG), false);
  assert.equal(existsSync(second.env.COMATE_ACP_MCP_CONFIG), true);
});

test("empty injection leaves configuration untouched; invalid JSONC fails explicitly", (t) => {
  const cwd = workspace(t);
  assert.equal(createMcpOverlay([], cwd), undefined);
  assert.equal(existsSync(join(cwd, ".comate")), false);
  mkdirSync(join(cwd, ".comate"));
  const local = join(cwd, ".comate", "mcp.local.json");
  for (const text of ['{"mcpServers":', '{"mcpServers": []}', 'null']) {
    writeFileSync(local, text);
    assert.throws(() => createMcpOverlay([server("host")], cwd), /Invalid MCP/);
    assert.equal(readFileSync(local, "utf8"), text);
  }
});

test("preload redirects sync, callback and promise reads, including workers and symlink cwd", async (t) => {
  const root = workspace(t);
  const cwd = join(root, "real"); mkdirSync(cwd);
  const alias = join(root, "alias"); symlinkSync(cwd, alias, "dir");
  const overlay = createMcpOverlay([server("host")], alias);
  t.after(overlay.dispose);
  const script = join(root, "reader.mjs");
  writeFileSync(script, `
    import assert from 'node:assert/strict';
    import fs, {readFileSync, statSync} from 'node:fs';
    import {readFile, access, stat} from 'node:fs/promises';
    import {Worker, isMainThread} from 'node:worker_threads';
    const targets = JSON.parse(process.env.COMATE_ACP_MCP_TARGETS);
    for (const target of targets) {
      assert.ok(fs.existsSync(target));
      assert.ok(statSync(target).isFile());
      assert.ok((await stat(target)).isFile());
      await access(target);
      for (const input of [target, new URL('file://' + target), Buffer.from(target)]) {
        assert.equal(JSON.parse(readFileSync(input, 'utf8')).mcpServers.host.env.TOKEN, 'secret');
        assert.equal(JSON.parse(await readFile(input, 'utf8')).mcpServers.host.env.TOKEN, 'secret');
        await new Promise((resolve, reject) => fs.readFile(input, 'utf8', (error, text) => {
          if (error) return reject(error);
          assert.equal(JSON.parse(text).mcpServers.host.env.TOKEN, 'secret'); resolve();
        }));
      }
    }
    assert.equal(fs.existsSync(targets[0] + '.unrelated'), false);
    if (isMainThread) await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url));
      worker.on('error', reject); worker.on('exit', code => code ? reject(new Error('worker ' + code)) : resolve());
    });
    console.log('read-ok');
  `);
  // Resolve a symlink with no extension, just like /usr/local/bin/comatecli.
  const bin = join(root, "comatecli"); symlinkSync(script, bin);
  const child = spawnComate(bin, [], { cwd: alias, env: { ...process.env, ...overlay.env }, stdio: ["ignore", "pipe", "pipe"] }, overlay.preload);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim().split("\n").length, 2, "main process and worker both read the overlay");
  assert.equal(existsSync(join(cwd, ".comate")), false);
});

test("native executables fail with an actionable error instead of dropping MCP", (t) => {
  const cwd = workspace(t);
  const native = join(cwd, "native"); writeFileSync(native, "not a Node launcher");
  assert.throws(() => spawnComate(native, [], {}, "/preload.cjs"), /npm Node.js version/);
});

