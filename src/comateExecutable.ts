import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] ?? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return envValue(env, "PATH").split(platform === "win32" ? ";" : ":")
    .map(dir => dir.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" && !/\.[^/\\.]+$/.test(name)
    ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, `${name}.ps1`, name]
    : [name];
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the CLI, never the unrelated Comate IDE launcher. */
export function resolveComateExecutable(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; home?: string } = {},
): string {
  const override = env.COMATE_ACP_CMD?.trim();
  if (override) return override;

  const platform = options.platform ?? process.platform;
  const home = options.home ?? ((platform === "win32" ? envValue(env, "USERPROFILE") : "") || homedir());
  const fallbackDirs = platform === "win32"
    ? [
        envValue(env, "npm_config_prefix"),
        join(envValue(env, "APPDATA") || join(home, "AppData", "Roaming"), "npm"),
        join(home, ".local", "bin"),
      ]
    : [join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  for (const dir of [...pathDirs(env, platform), ...fallbackDirs].filter(Boolean)) {
    for (const name of executableNames("comatecli", platform)) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return "comatecli";
}

/** npm uses symlinks on Unix and shell/PowerShell/cmd shims on Windows. */
export function resolveComateNodeLauncher(executable: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = isAbsolute(executable) || /[/\\]/.test(executable)
    ? [resolve(executable)]
    : pathDirs(env, process.platform).flatMap(dir => executableNames(executable, process.platform).map(name => join(dir, name)));
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
    } catch { continue; }
    if (/\.(mjs|cjs|js)$/i.test(real)) return real;
    if (!/^comatecli(?:\.(cmd|bat|ps1))?$/i.test(basename(real))) return undefined;

    // Resolve the package's declared bin next to the npm shim rather than
    // executing a Windows script or interpreting its shell text.
    const packageRoots = [
      join(dirname(real), "node_modules", "@comate", "comatecli"),
      join(dirname(real), "..", "lib", "node_modules", "@comate", "comatecli"),
    ];
    for (const root of packageRoots) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          name?: string; bin?: string | Record<string, string>;
        };
        if (pkg.name !== "@comate/comatecli") continue;
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.comatecli;
        if (typeof bin !== "string") continue;
        const entry = realpathSync(resolve(root, bin));
        if (/\.(mjs|cjs|js)$/i.test(entry) && statSync(entry).isFile()) return entry;
      } catch { /* Try the next npm prefix layout. */ }
    }
    // Keep the first executable's precedence; a native override must not
    // silently select a different installation later on PATH.
    return undefined;
  }
  return undefined;
}
