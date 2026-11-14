/**
 * Translation from ACP session state to `comatecli run` argv.
 *
 * Every flag here was taken from `comatecli run --help`; nothing is invented.
 */

/** Work modes exposed to the ACP client. `--mode` accepts these verbatim. */
export const MODE_IDS = ["Agent", "Plan", "Goal"] as const;
export type ModeId = (typeof MODE_IDS)[number];
export const DEFAULT_MODE_ID: ModeId = "Agent";

/** Reasoning strength levels accepted by `--effort`. */
export const EFFORTS = ["low", "medium", "high", "extra_high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Exit code we ask comatecli to use when a turn stops to await a permission
 * decision. Picked to be unlikely to collide with comatecli's own failure
 * codes; the suspend itself is also visible as a `requires_action` frame.
 */
export const SUSPEND_EXIT_CODE = 75;

export interface RunArgsInput {
  prompt: string;
  cwd: string;
  conversationId?: string | null;
  model?: string | null;
  effort?: Effort | null;
  thinking?: boolean | null;
  mode?: ModeId;
  systemPromptAppend?: string | null;
  activateSkills?: string[];
  activateCommands?: string[];
  activateSubagents?: string[];
  attachFiles?: string[];
  attachImages?: string[];
  enableCodebaseSearch?: boolean;
  enableInteractiveTools?: boolean;
  /** Emit the raw event stream instead of the default human-readable task view. */
  eventStream?: boolean;
}

/** Builds the argv for one headless turn. */
export function buildRunArgs(input: RunArgsInput): string[] {
  const args = ["run", "-q", input.prompt, "--cwd", input.cwd];

  if (input.eventStream !== false) args.push("-d", "event-stream");
  if (input.conversationId) args.push("-c", input.conversationId);
  if (input.model) args.push("-m", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.thinking === true) args.push("--thinking", "true");
  if (input.thinking === false) args.push("--thinking", "false");
  if (input.mode) args.push("--mode", input.mode);
  if (input.systemPromptAppend) args.push("--append-system-prompt", input.systemPromptAppend);
  if (input.enableCodebaseSearch) args.push("--enable-codebase-search");
  if (input.enableInteractiveTools) args.push("--enable-interactive-tools");

  // Let the ACP client decide on tool permissions instead of comatecli's
  // default auto-approval, and make a parked turn observable via exit code.
  // Without these, a suspend is indistinguishable from a clean finish.
  args.push("--disable-auto-approve");
  args.push("--on-requires-action", "suspend");
  args.push("--requires-action-exit-code", String(SUSPEND_EXIT_CODE));

  pushAll(args, "--activate-skill", input.activateSkills);
  pushAll(args, "--activate-command", input.activateCommands);
  pushAll(args, "--activate-subagent", input.activateSubagents);
  pushAll(args, "--attach-file", input.attachFiles);
  pushAll(args, "--attach-image", input.attachImages);

  return args;
}

/**
 * Builds the argv that resumes a suspended turn once the client answered the
 * permission prompt.
 *
 * `--resume-tool-result` is the documented entry point: it only needs the
 * payload, and comatecli back-fills toolId/toolName/actionType/resumeToken from
 * the pending record.
 */
export function buildResumeArgs(options: {
  cwd: string;
  conversationId: string;
  decision: "approve" | "reject";
  toolResult?: unknown;
  prompt?: string;
  eventStream?: boolean;
}): string[] {
  const args = ["run", "--cwd", options.cwd, "-c", options.conversationId];

  if (options.decision === "approve") args.push("--approve");
  else args.push("--reject");

  if (options.toolResult !== undefined) {
    args.push("--resume-tool-result", JSON.stringify(options.toolResult));
  }
  // comatecli requires a query on resume; fall back to a neutral continuation.
  args.push("-q", options.prompt ?? "继续");
  if (options.eventStream !== false) args.push("-d", "event-stream");

  return args;
}

function pushAll(args: string[], flag: string, values?: string[]): void {
  if (!values) return;
  for (const value of values) {
    if (!value) continue;
    args.push(flag, value);
  }
}