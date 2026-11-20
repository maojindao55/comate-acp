import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolveComateNodeLauncher } from "./comateExecutable.js";

/**
 * comatecli ships both as a native binary and as a JS launcher
 * (npm install: bin/zulu-tui.mjs). A launcher is not executable on its own, so
 * it has to be run through the current Node binary.
 */
export function spawnComate(
  executable: string,
  args: string[],
  options: SpawnOptions,
  preload?: string,
): ChildProcess {
  const baseEnv = options.env ?? process.env;
  // comatecli headless CLIVirtualEditor omits applyDocumentEdits; ZULU_EDIT_PATCH_MODE=0
  // routes edit_file through saveDocumentWithReplaceContent instead.
  const env: NodeJS.ProcessEnv =
    baseEnv.ZULU_EDIT_PATCH_MODE === undefined
      ? { ...baseEnv, ZULU_EDIT_PATCH_MODE: "0" }
      : baseEnv;
  const spawnOptions = { windowsHide: process.platform === "win32", ...options, env };
  const launcher = resolveComateNodeLauncher(executable, env);
  if (launcher) {
    return spawn(process.execPath, [...(preload ? ["--require", preload] : []), launcher, ...args], spawnOptions);
  }
  if (preload) {
    throw new Error("Client MCP injection requires the npm Node.js version of comatecli. Run npm install -g @comate/comatecli, or set COMATE_ACP_CMD to its bin/zulu-tui.mjs launcher.");
  }
  if (!/\.(mjs|cjs|js)$/i.test(executable)) return spawn(executable, args, spawnOptions);
  return spawn(process.execPath, [executable, ...args], spawnOptions);
}
