import type { AuthMethod, ClientCapabilities } from "@agentclientprotocol/sdk";
import { spawnComate } from "./spawn.js";

export const COMATE_AUTH_METHOD_ID = "comate-login";

const AUTH_ERROR_PATTERNS = [
  /no license or token provided/i,
  /please enter a valid (?:license|token)/i,
  /platform token validation failed/i,
  /未获取到认证信息/,
  /无该用户\s*token\s*存在/,
  /未登录|尚未登录/,
  /请先.*comatecli login/i,
];

/**
 * Advertises interactive terminal login when the client supports ACP terminal
 * authentication, falling back to the agent method hint for other clients.
 */
export function buildAuthMethods(clientCapabilities?: ClientCapabilities | null): AuthMethod[] {
  if (clientCapabilities?.auth?.terminal === true) {
    return [
      {
        id: COMATE_AUTH_METHOD_ID,
        type: "terminal",
        args: ["--login"],
        name: "Comate 登录",
        description: "在内置终端运行 `comatecli login` 完成登录。",
      },
    ];
  }
  return [
    {
      id: COMATE_AUTH_METHOD_ID,
      name: "Comate 登录",
      description: "在终端运行 `comatecli login` 完成登录；已登录则可忽略。",
    },
  ];
}

/** Returns true when `comatecli` stderr indicates missing or invalid credentials. */
export function isComateAuthError(detail: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(detail));
}

/** Extracts `comatecli login` arguments from a `comate-acp --login` invocation. */
export function buildLoginCliArgs(argv: readonly string[]): string[] {
  return ["login", ...argv.filter((arg) => arg !== "--login")];
}

export interface ComateCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runComateSubcommand(
  executable: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<ComateCommandResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnComate(executable, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore kill failures after timeout */
      }
      finish(() => reject(new Error(`comatecli ${args[0] ?? ""} 超时`)));
    }, timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-4000);
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

/** Verifies whether `comatecli` currently has valid local credentials. */
export async function checkComateAuthStatus(
  executable: string,
  timeoutMs = 15_000,
): Promise<{ authenticated: boolean; detail?: string }> {
  try {
    const result = await runComateSubcommand(executable, ["status"], timeoutMs);
    if (result.code === 0) return { authenticated: true };
    const detail = (result.stderr || result.stdout).trim() || undefined;
    return { authenticated: false, detail };
  } catch (error) {
    return { authenticated: false, detail: (error as Error).message };
  }
}

/** Clears local `comatecli` credentials via `comatecli logout`. */
export async function logoutComate(
  executable: string,
  timeoutMs = 15_000,
): Promise<void> {
  const result = await runComateSubcommand(executable, ["logout"], timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`comatecli logout 退出码 ${result.code ?? -1}${detail ? `: ${detail}` : ""}`);
  }
}
