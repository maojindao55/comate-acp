#!/usr/bin/env node
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import crypto from "node:crypto";

import { resolveComateExecutable } from "./comateExecutable.js";
import {
  buildResumeArgs,
  buildRunArgs,
  DEFAULT_MODE_ID,
  EFFORTS,
  MODE_IDS,
  SUSPEND_EXIT_CODE,
  type Effort,
  type ModeId,
} from "./comateArgs.js";
import { createParserState, EventParser, type ParserEvent, type ParserState, type RequiresActionPayload } from "./eventParser.js";
import type { TurnMetrics } from "./eventParser.js";
import { ModelCatalog } from "./models.js";
import { fetchPending } from "./pending.js";
import { SessionStore } from "./sessionStore.js";
import { spawnComate } from "./spawn.js";

const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// stdout is the JSON-RPC pipe. Anything logged must go to stderr.
const DEBUG = Boolean(process.env.DEBUG || process.env.COMATE_ACP_DEBUG);
const logDebug = (...args: unknown[]) => {
  if (DEBUG) console.error("[comate-acp]", ...args);
};
const logError = (...args: unknown[]) => console.error("[comate-acp]", ...args);
console.log = logDebug;

const EXECUTABLE = resolveComateExecutable();
const sessions = new SessionStore();
const models = new ModelCatalog(EXECUTABLE);

// --- session state ---------------------------------------------------------

interface SessionState {
  sessionId: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  effort?: Effort;
  mode: ModeId;
}

function sanitizeCwd(cwd: unknown): string {
  return typeof cwd === "string" && isAbsolute(cwd) && cwd.length > 0 ? cwd : homedir();
}

function emit(client: AgentContext, sessionId: string, update: SessionUpdate): void {
  void client.notify("session/update", { sessionId, update });
}

/** ACP prompts are content-block arrays; comatecli takes a single query string. */
function flattenPrompt(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource_link") parts.push(block.uri ?? "");
    else if (block.type === "resource") parts.push(block.resource?.uri ?? "");
  }
  return parts.filter(Boolean).join("\n\n");
}

function modeState(currentModeId: ModeId): SessionModeState {
  return {
    currentModeId,
    availableModes: MODE_IDS.map((id) => ({ id, name: id, description: modeDescription(id) })),
  };
}

function modeDescription(id: ModeId): string {
  if (id === "Plan") return "先规划再执行";
  if (id === "Goal") return "目标导向";
  return "直接执行";
}

function buildConfigOptions(session: SessionState): SessionConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "模型",
      description: "comatecli -m",
      currentValue: session.model ?? "",
      options: models.options(),
    },
    {
      type: "select",
      id: "effort",
      name: "推理强度",
      description: "comatecli --effort",
      currentValue: session.effort ?? "",
      options: EFFORTS.map((value) => ({ value, name: value })),
    },
  ];
}

// --- turn execution --------------------------------------------------------

interface TurnOutcome {
  conversationId?: string;
  requiresAction?: RequiresActionPayload;
  error?: string;
  /** The client cancelled the turn; the process may exit non-zero from the signal. */
  cancelled?: boolean;
  /** comatecli's own timing counters for this turn. */
  metrics?: TurnMetrics;
  /** Tokens estimated from the streamed text (comatecli reports no count). */
  estimatedOutputTokens?: number;
}

interface TurnOptions {
  session: SessionState;
  args: string[];
  client: AgentContext;
  signal: AbortSignal;
}

/** Child processes currently streaming a turn, keyed by ACP session id. */
const active = new Map<string, ChildProcess>();

/**
 * Sessions the client asked to cancel. `session/cancel` is a notification, so
 * the turn promise is never rejected — but the killed process exits non-zero,
 * and that must not be reported as a failure.
 */
const cancelRequested = new Set<string>();

function applyParserEvent(client: AgentContext, sessionId: string, event: ParserEvent): void {
  switch (event.type) {
    case "thought":
      emit(client, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
        messageId: event.messageId,
      });
      return;
    case "text":
      emit(client, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.text },
        messageId: event.messageId,
      });
      return;
    case "tool_start":
      emit(client, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: event.title,
        kind: event.kind as ToolKind,
        status: "pending",
        rawInput: event.rawInput,
      });
      return;
    case "tool_update":
      emit(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.status,
        rawOutput: event.rawOutput,
      });
      return;
    case "usage":
      emit(client, sessionId, { sessionUpdate: "usage_update", used: event.used, size: event.size });
      return;
    default:
      return;
  }
}

/**
 * Runs one headless comatecli turn and resolves when the turn ends, suspends for
 * a permission decision, or the process dies.
 *
 * The process exit code is the authority on how the turn ended: comatecli emits
 * `conversation-status: Completed` even when the turn is only parked on a
 * pending approval, so the frame alone cannot be trusted.
 */
function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  const { session, args, client, signal } = options;

  return new Promise<TurnOutcome>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnComate(EXECUTABLE, args, {
        cwd: session.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new RequestError(-32603, `无法启动 comatecli: ${(error as Error).message}`));
      return;
    }

    active.set(session.sessionId, child);
    logDebug("spawn:", EXECUTABLE, args.join(" "));
    let settled = false;
    let linesSeen = 0;
    let conversationId = session.conversationId;
    let stderrTail = "";
    // comatecli emits the suspend twice: first a snapshot-only frame, then the
    // one carrying toolId. Merge them and only stop early once we can name the
    // tool; otherwise the exit code below closes the turn.
    let suspend: RequiresActionPayload | undefined;
    let turnMetrics: TurnMetrics = { ...parserStateFor(session.sessionId).turnMetrics };

    const parser = new EventParser((event) => {
      if (event.type === "usage" || event.type === "thought" || event.type === "text"
        || event.type === "tool_start" || event.type === "tool_update") {
        applyParserEvent(client, session.sessionId, event);
        return;
      }
      if (event.type === "requires_action") {
        if (event.payload.conversationId) conversationId = event.payload.conversationId;
        suspend = { ...suspend, ...event.payload };
        if (suspend.toolId) finish({ conversationId, requiresAction: suspend });
        return;
      }
      if (event.type === "turn_metrics") {
        turnMetrics = { ...turnMetrics, ...event };
        return;
      }
      if (event.type === "turn_end") {
        if (event.conversationId) conversationId = event.conversationId;
        // A suspend also reports Completed; let the exit code decide instead.
        return;
      }
    }, parserStateFor(session.sessionId));

    const finish = (outcome: TurnOutcome) => {
      if (settled) return;
      settled = true;
      active.delete(session.sessionId);
      resolve(outcome);
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      active.delete(session.sessionId);
      reject(new RequestError(-32603, message));
    };

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
      finish({ conversationId, cancelled: true });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        linesSeen += 1;
        parser.ingest(JSON.parse(trimmed));
      } catch {
        logDebug("非 JSON 行，已忽略:", trimmed.slice(0, 200));
      }
    });

    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });

    child.on("error", (error) => fail(`comatecli 启动失败: ${error.message}`));

    child.on("close", (code) => {
      logDebug("close:", { code, linesSeen, settled });
      signal.removeEventListener("abort", onAbort);
      active.delete(session.sessionId);
      if (settled) return;
      // A cancelled turn makes comatecli exit non-zero; that is not a failure.
      const estimatedOutputTokens = parser.estimatedOutputTokens();
      if (cancelled || cancelRequested.has(session.sessionId) || signal.aborted) {
        cancelRequested.delete(session.sessionId);
        finish({ conversationId, cancelled: true, metrics: turnMetrics, estimatedOutputTokens });
        return;
      }
      if (code === SUSPEND_EXIT_CODE) {
        finish({
          conversationId,
          requiresAction: suspend ?? { conversationId },
          metrics: turnMetrics,
          estimatedOutputTokens,
        });
        return;
      }
      if (code === 0) {
        finish({ conversationId, metrics: turnMetrics, estimatedOutputTokens });
        return;
      }
      const detail = stderrTail.trim();
      fail(`comatecli 退出码 ${code}${detail ? `: ${detail}` : ""}`);
    });
  });
}

// --- permissions -----------------------------------------------------------

const MAX_APPROVAL_ROUNDS = 16;

const APPROVE_OPTION_ID = "allow_once";
const REJECT_OPTION_ID = "reject_once";

type Decision = "approve" | "reject" | "cancelled";

/**
 * comatecli parks a turn when a tool needs approval. We surface that as an ACP
 * permission request, then resume the conversation with --approve/--reject.
 */
async function requestDecision(
  client: AgentContext,
  sessionId: string,
  payload: RequiresActionPayload,
): Promise<Decision> {
  let outcome: unknown;
  try {
    outcome = await client.request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: payload.toolId ?? "pending",
        title: payload.toolName ?? "需要确认的操作",
        status: "pending",
      },
      options: [
        { optionId: APPROVE_OPTION_ID, name: "允许", kind: "allow_once" },
        { optionId: REJECT_OPTION_ID, name: "拒绝", kind: "reject_once" },
      ],
    });
  } catch (error) {
    logError("请求权限失败:", (error as Error).message);
    return "cancelled";
  }

  // ACP wraps the choice one level deep: { outcome: { outcome, optionId } }.
  const wrapper = outcome as { outcome?: { outcome?: string; optionId?: string } } | undefined;
  const choice = wrapper?.outcome;
  if (choice?.outcome === "selected") {
    if (choice.optionId === APPROVE_OPTION_ID) return "approve";
    if (choice.optionId === REJECT_OPTION_ID) return "reject";
  }
  return "cancelled";
}

/**
 * comatecli reports per-turn timing but no output-token count, so tokens/s
 * cannot be derived here. Forward what is real: the model call duration and
 * time-to-first-token, which the client renders as their own metrics.
 */
function metricsMeta(
  metrics: TurnMetrics | undefined,
  estimatedOutputTokens?: number,
): { _meta?: { metrics: Record<string, unknown> } } {
  const payload: Record<string, unknown> = { usageScope: "turn" };
  if (metrics?.modelCallDurationMs !== undefined) {
    payload.modelCallDurationMs = metrics.modelCallDurationMs;
  }
  if (metrics?.firstTokenLatencyMs !== undefined) payload.avgTtftMs = metrics.firstTokenLatencyMs;

  // comatecli never reports a per-turn output count, so the client would show
  // no speed at all. Fill it in from the streamed characters; the token count
  // is an estimate, the duration it is divided by is real.
  const duration = metrics?.modelCallDurationMs;
  if (estimatedOutputTokens && duration && duration >= 1) {
    payload.outputTokens = estimatedOutputTokens;
    payload.rawSummary = `outputTokens 由流式文本估算（CJK 1 字/ token，其他 4 字符/ token）；耗时为 comatecli 上报值 ${duration}ms`;
  }

  if (Object.keys(payload).length <= 1) return {};
  return { _meta: { metrics: payload } };
}

/**
 * The `requires_action` frame carries the ids, but when the turn suspends via
 * exit code alone it does not. `comatecli pending` always has the record, so we
 * fall back to it to name the tool in the permission prompt.
 */
async function enrichPending(
  session: SessionState,
  payload: RequiresActionPayload,
): Promise<RequiresActionPayload> {
  if (payload.toolId) return payload;
  const conversationId = payload.conversationId ?? session.conversationId;
  if (!conversationId) return payload;

  const record = await fetchPending(EXECUTABLE, session.cwd, conversationId);
  if (!record) return { ...payload, conversationId };
  return {
    conversationId: record.conversationId ?? conversationId,
    toolId: record.toolId,
    toolName: record.toolName,
    actionType: record.actionType,
    resumeToken: record.resumeToken,
    payload: record.payload ?? payload.payload,
  };
}

// --- agent -----------------------------------------------------------------

/** Per-session parser bookkeeping, kept across turns of the same conversation. */
const parserStates = new Map<string, ParserState>();

function parserStateFor(sessionId: string): ParserState {
  let state = parserStates.get(sessionId);
  if (!state) {
    state = createParserState();
    parserStates.set(sessionId, state);
  }
  return state;
}

function currentSession(sessionId: string): SessionState {
  const stored = sessions.get(sessionId);
  if (!stored) throw new RequestError(-32602, `未知会话 ${sessionId}`);
  return {
    sessionId,
    cwd: stored.cwd,
    conversationId: stored.conversationId,
    model: stored.model,
    effort: stored.effort as Effort | undefined,
    mode: (stored.mode as ModeId | undefined) ?? DEFAULT_MODE_ID,
  };
}

function persist(session: SessionState): void {
  sessions.put({
    sessionId: session.sessionId,
    cwd: session.cwd,
    conversationId: session.conversationId,
    model: session.model,
    effort: session.effort,
    mode: session.mode,
    createdAt: sessions.get(session.sessionId)?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

const app = agent({ name: "comate-acp" })
  .onRequest("initialize", async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "comate-acp", title: "Baidu Comate", version: VERSION },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { embeddedContext: true },
      sessionCapabilities: { list: {}, close: {}, delete: {} },
    },
    authMethods: [
      {
        id: "comate-login",
        name: "Comate 登录",
        description: "在终端运行 `comatecli login` 完成登录；已登录则可忽略。",
      },
    ],
  }))
  .onRequest("session/new", async (ctx) => {
    const sessionId = crypto.randomUUID();
    await models.refresh();
    const session: SessionState = {
      sessionId,
      cwd: sanitizeCwd(ctx.params.cwd),
      mode: DEFAULT_MODE_ID,
    };
    sessions.put({
      sessionId,
      cwd: session.cwd,
      mode: session.mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { sessionId, modes: modeState(session.mode), configOptions: buildConfigOptions(session) };
  })
  .onRequest("session/load", async (ctx) => {
    await models.refresh();
    const stored = sessions.get(ctx.params.sessionId);
    const session: SessionState = {
      sessionId: ctx.params.sessionId,
      cwd: sanitizeCwd(ctx.params.cwd ?? stored?.cwd),
      conversationId: stored?.conversationId,
      model: stored?.model,
      effort: (stored?.effort as Effort | undefined),
      mode: (stored?.mode as ModeId | undefined) ?? DEFAULT_MODE_ID,
    };
    sessions.put({
      sessionId: session.sessionId,
      cwd: session.cwd,
      conversationId: session.conversationId,
      model: session.model,
      effort: session.effort,
      mode: session.mode,
      createdAt: stored?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    return { modes: modeState(session.mode), configOptions: buildConfigOptions(session) };
  })
  .onRequest("session/list", async () => ({
    sessions: sessions.list().map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
  }))
  .onRequest("session/delete", async (ctx) => {
    sessions.delete(ctx.params.sessionId);
  })
  .onRequest("session/close", async (ctx) => {
    const child = active.get(ctx.params.sessionId);
    if (child) child.kill("SIGTERM");
  })
  .onRequest("session/prompt", async (ctx) => {
    const session = currentSession(ctx.params.sessionId);
    const prompt = flattenPrompt(ctx.params.prompt);
    if (!prompt.trim()) throw new RequestError(-32602, "prompt 不能为空");

    let args = buildRunArgs({
      prompt,
      cwd: session.cwd,
      conversationId: session.conversationId,
      model: session.model,
      effort: session.effort,
      mode: session.mode,
      enableInteractiveTools: true,
    });

    for (let round = 0; round < MAX_APPROVAL_ROUNDS; round += 1) {
      const outcome = await runTurn({ session, args, client: ctx.client, signal: ctx.signal });
      if (outcome.conversationId) {
        session.conversationId = outcome.conversationId;
        persist(session);
      }

      if (!outcome.requiresAction) {
        logDebug("turn 结束:", { aborted: ctx.signal.aborted, conversationId: session.conversationId });
        return {
          stopReason: outcome.cancelled || ctx.signal.aborted ? "cancelled" : "end_turn",
          ...metricsMeta(outcome.metrics, outcome.estimatedOutputTokens),
        };
      }

      const requiresAction = await enrichPending(session, outcome.requiresAction);
      const decision = await requestDecision(ctx.client, session.sessionId, requiresAction);
      if (decision === "cancelled") {
        return {
          stopReason: "cancelled",
          ...metricsMeta(outcome.metrics, outcome.estimatedOutputTokens),
        };
      }

      args = buildResumeArgs({
        cwd: session.cwd,
        conversationId: session.conversationId ?? "",
        decision,
        prompt: "继续",
      });
    }

    throw new RequestError(-32603, "审批轮次过多，已中止");
  })
  .onRequest("session/set_mode", async (ctx) => {
    const mode = ctx.params.modeId as ModeId;
    const session = currentSession(ctx.params.sessionId);
    if (!MODE_IDS.includes(mode)) {
      throw new RequestError(-32602, `不支持的模式 ${String(ctx.params.modeId)}`);
    }
    session.mode = mode;
    persist(session);
    emit(ctx.client, session.sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const session = currentSession(ctx.params.sessionId);
    const id = ctx.params.configId as string;
    const value = ctx.params.value;
    if (id === "model") session.model = typeof value === "string" ? value : undefined;
    else if (id === "effort") session.effort = EFFORTS.includes(value as Effort) ? (value as Effort) : undefined;
    persist(session);
    return { configOptions: buildConfigOptions(session) };
  })
  .onNotification("session/cancel", async (ctx) => {
    const { sessionId } = ctx.params;
    const child = active.get(sessionId);
    if (!child) return;
    cancelRequested.add(sessionId);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
  });

// --- stdio -----------------------------------------------------------------

if (process.argv.includes("--login")) {
  // Terminal-auth entry point: hand the terminal to comatecli's own login flow.
  const child = spawnComate(EXECUTABLE, ["login"], { stdio: "inherit" });
  child.on("error", (error) => {
    logError(`启动 comatecli login 失败: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  app.connect(ndJsonStream(Writable.toWeb(process.stdout) as never, Readable.toWeb(process.stdin) as never));
}