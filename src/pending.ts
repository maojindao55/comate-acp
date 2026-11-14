import { spawnComate } from "./spawn.js";

export interface PendingAction {
  status: string;
  conversationId?: string;
  toolId?: string;
  toolName?: string;
  actionType?: string;
  resumeToken?: string;
  cwd?: string;
  payload?: unknown;
}

/**
 * Reads the parked interaction for a conversation.
 *
 * `comatecli pending --json <conversationId>` returns a single object when a
 * record exists, an array when listing, and an empty array when nothing is
 * parked. The adapter needs the toolId/toolName so the ACP permission prompt can
 * name what is actually being asked for.
 */
export function fetchPending(
  executable: string,
  cwd: string,
  conversationId: string,
  timeoutMs = 15_000,
): Promise<PendingAction | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnComate(executable, ["pending", "--json", conversationId], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    let stdout = "";
    let settled = false;
    const done = (value: PendingAction | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(undefined);
    }, timeoutMs);

    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => done(undefined));
    child.on("close", () => {
      const parsed = tryParse(stdout);
      // Listing mode returns an array; a specific conversation returns the record.
      const candidate = Array.isArray(parsed)
        ? parsed.find((entry) => isPendingAction(entry))
        : parsed;
      done(isPendingAction(candidate) ? candidate : undefined);
    });
  });
}

function isPendingAction(value: unknown): value is PendingAction {
  return Boolean(value) && typeof value === "object" && typeof (value as PendingAction).status === "string";
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}