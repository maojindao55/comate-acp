/** Loaded only into the Comate Node process (and its worker threads). */
import fs = require("node:fs");
import path = require("node:path");
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const config = process.env.COMATE_ACP_MCP_CONFIG;
const targetPaths = process.env.COMATE_ACP_MCP_TARGETS;
if (config && targetPaths) {
  const targets = new Set<string>(JSON.parse(targetPaths));
  const redirect = (input: unknown): unknown => {
    let name = input;
    if (name instanceof URL) {
      if (name.protocol !== "file:") return input;
      name = fileURLToPath(name);
    }
    if (Buffer.isBuffer(name)) name = name.toString();
    return typeof name === "string" && targets.has(path.resolve(name)) ? config : input;
  };
  // Cover the fs APIs used by Comate, fs-extra and its configuration watchers.
  // Writes are deliberately left alone: this is a read-only launch snapshot.
  const patch = (object: object, names: string[]) => {
    const methods = object as Record<string, (...args: unknown[]) => unknown>;
    for (const name of names) {
      const original = methods[name];
      methods[name] = function (input: unknown, ...args: unknown[]) {
        return original.call(this, redirect(input), ...args);
      };
    }
  };
  patch(fs, [
    "readFile", "readFileSync", "stat", "statSync", "lstat", "lstatSync",
    "access", "accessSync", "exists", "existsSync",
  ]);
  patch(fs.promises, ["readFile", "stat", "lstat", "access"]);

  // Update named ESM imports as well as CommonJS/default imports.
  syncBuiltinESMExports();
}
