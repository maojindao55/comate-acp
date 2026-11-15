import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

function nodeLauncher(executable: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = isAbsolute(executable) || /[/\\]/.test(executable)
    ? [resolve(executable)]
    : (env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, executable));
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (/\.(mjs|cjs|js)$/i.test(real)) return real;
      return undefined;
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

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
  if (preload) {
    const launcher = nodeLauncher(executable, options.env ?? process.env);
    if (!launcher) {
      throw new Error("Client MCP injection requires the npm Node.js version of comatecli. Install @comate/comatecli and point COMATE_ACP_CMD to its bin/zulu-tui.mjs launcher.");
    }
    return spawn(process.execPath, ["--require", preload, launcher, ...args], options);
  }
  if (!/\.(mjs|cjs|js)$/i.test(executable)) return spawn(executable, args, options);
  return spawn(process.execPath, [executable, ...args], options);
}
