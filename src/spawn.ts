import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * comatecli ships both as a native binary and as a JS launcher
 * (npm install: bin/zulu-tui.mjs). A launcher is not executable on its own, so
 * it has to be run through the current Node binary.
 */
export function spawnComate(
  executable: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  if (!/\.(mjs|cjs|js)$/i.test(executable)) return spawn(executable, args, options);
  return spawn(process.execPath, [executable, ...args], options);
}