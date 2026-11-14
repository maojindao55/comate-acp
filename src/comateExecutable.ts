import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

/**
 * Absolute path of the comatecli executable, or the bare name when it can only
 * be resolved through PATH at spawn time.
 *
 * Deliberately not probed: `~/.comate/bin/comate`. That is the Comate IDE
 * (VS Code fork) launcher script, and it exits 0 silently when handed CLI
 * arguments, which would look like an empty successful turn.
 */
export function resolveComateExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COMATE_ACP_CMD?.trim();
  if (override) return override;

  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "comatecli"),
    "/usr/local/bin/comatecli",
    "/opt/homebrew/bin/comatecli",
  ];

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }

  const onPath = findOnPath("comatecli", env.PATH ?? "");
  if (onPath) return onPath;

  return "comatecli";
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathValue: string): string | undefined {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}