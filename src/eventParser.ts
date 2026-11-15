/**
 * Reducer for comatecli's `event-stream` output.
 *
 * The stream is NOT a pure delta feed. It mixes three shapes:
 *
 *  - `conversation-messages`   full conversation snapshot (every message, every element)
 *  - `partial-message-data`    full snapshot of one message (carries tokenUsage)
 *  - `partial-message-elements` incremental children for one message
 *
 * Text elements repeat their whole accumulated `content` on every frame, so we
 * track how much of each element we already forwarded and only emit the suffix.
 * Tool elements are snapshots of a state machine, so we emit one `tool_call`
 * and then a `tool_call_update` whenever `toolState` changes.
 */

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ParserEvent =
  | { type: "thought"; messageId: string; text: string }
  | { type: "text"; messageId: string; text: string }
  | { type: "tool_start"; messageId: string; toolCallId: string; title: string; kind: string; rawInput: unknown }
  | { type: "tool_update"; messageId: string; toolCallId: string; status: ToolStatus; rawOutput?: unknown }
  | { type: "usage"; used: number; size: number }
  | { type: "turn_metrics"; firstTokenLatencyMs?: number; modelCallDurationMs?: number }
  | { type: "requires_action"; payload: RequiresActionPayload }
  | { type: "live_approval"; payload: RequiresActionPayload }
  | { type: "turn_end"; status: "completed" | "failed" | "cancelled"; conversationId?: string }
  | { type: "error"; message: string };

/** `performanceMetrics` reported by comatecli for the current turn. */
export interface TurnMetrics {
  firstTokenLatencyMs?: number;
  modelCallDurationMs?: number;
}

export interface RequiresActionPayload {
  conversationId?: string;
  toolId?: string;
  toolName?: string;
  actionType?: string;
  resumeToken?: string;
  payload?: unknown;
}

interface ElementState {
  emitted: number;
  ended: boolean;
}

interface ToolState {
  status: ToolStatus;
  started: boolean;
}

/** Cross-turn bookkeeping, so a resumed turn does not replay what was sent. */
export interface ParserState {
  emittedLength: Map<string, number>;
  endedElements: Set<string>;
  tools: Map<string, { status: ToolStatus; started: boolean }>;
  /** Messages already finished; a later sighting of one is a replay. */
  closedMessages: Set<string>;
  /** Latest performance counters, carried across turns of one session. */
  turnMetrics?: TurnMetrics;
  lastUsage?: { used: number; size: number };
}

export function createParserState(): ParserState {
  return {
    emittedLength: new Map(),
    endedElements: new Set(),
    tools: new Map(),
    closedMessages: new Set(),
  };
}

const TERMINAL_MESSAGE_STATUS = new Set(["success", "failed", "cancelled", "executed"]);

const TOOL_STATE_TO_STATUS: Record<string, ToolStatus> = {
  pending: "pending",
  executing: "in_progress",
  executed: "completed",
  failed: "failed",
};

export class EventParser {
  private readonly emittedLength: Map<string, number>;
  private readonly endedElements: Set<string>;
  private readonly tools: Map<string, ToolState>;
  private readonly closedMessages: Set<string>;
  /** Generated characters this turn, split by script, for the token estimate. */
  private cjkChars = 0;
  private otherChars = 0;

  constructor(
    private readonly emit: (event: ParserEvent) => void,
    private readonly state: ParserState = createParserState(),
  ) {
    // The same conversation is replayed in full when a suspended turn resumes,
    // so the bookkeeping has to outlive a single process to avoid re-sending
    // elements the client already has.
    this.emittedLength = state.emittedLength;
    this.endedElements = state.endedElements;
    this.tools = state.tools;
    this.closedMessages = state.closedMessages;
  }

  /** Consumes one parsed JSON object from the event stream. */
  ingest(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const frame = raw as Record<string, unknown>;
    const kind = frame.type;

    const info = frame.conversationInfo as Record<string, unknown> | undefined;
    if (!this.observedConversationId && typeof info?.id === "string") {
      this.observedConversationId = info.id;
    }
    if (!this.observedConversationId && kind === "conv_ready" && typeof frame.conversationId === "string") {
      this.observedConversationId = frame.conversationId;
    }

    switch (kind) {
      case "conversation-messages":
        this.ingestMessageList(frame.messages);
        return;
      case "partial-message-data": {
        this.ingestMessageList(frame.messages);
        this.ingestUsage(frame.messages);
        return;
      }
      case "partial-message-elements": {
        const messageData = frame.messageData as Record<string, unknown> | undefined;
        if (!messageData) return;
        const id = messageData.id as string | undefined;
        // Deltas for a message we already finished belong to a replayed turn.
        if (id && this.state.closedMessages.has(id)) return;
        if (id) this.ingestElements(id, messageData.elements);
        return;
      }
      case "requires_action":
        // Two frame shapes carry this type: a conversation snapshot (ids only in
        // conversationInfo) and a bare action record. Read both.
        this.emit({
          type: "requires_action",
          payload: {
            conversationId: (frame.conversationId as string | undefined)
              ?? (frame.conversationInfo as Record<string, unknown> | undefined)?.id as string | undefined,
            toolId: frame.toolId as string | undefined,
            toolName: frame.toolName as string | undefined,
            actionType: frame.actionType as string | undefined,
            resumeToken: frame.resumeToken as string | undefined,
            payload: frame.payload,
          },
        });
        return;
      case "pending-approvals": {
        if (!Array.isArray(frame.pendingApprovals)) return;
        for (const entry of frame.pendingApprovals) {
          if (!entry || typeof entry !== "object") continue;
          const action = entry as Record<string, unknown>;
          if (action.toolName !== "use_mcp_tool" || action.approvalKind !== "legacy" || typeof action.toolId !== "string") continue;
          const conversationId = typeof action.conversationId === "string" ? action.conversationId : this.observedConversationId;
          if (!conversationId || (this.observedConversationId && conversationId !== this.observedConversationId)) continue;
          this.emit({ type: "live_approval", payload: {
            conversationId, toolId: action.toolId, toolName: "use_mcp_tool", payload: action.params,
          } });
        }
        return;
      }
      case "conversation-status": {
        const info = frame.conversationInfo as Record<string, unknown> | undefined;
        const status = info?.status;
        const conversationId = info?.id as string | undefined;
        if (status === "Completed") this.endTurn("completed", conversationId);
        else if (status === "Failed") this.endTurn("failed", conversationId);
        else if (status === "Cancelled") this.endTurn("cancelled", conversationId);
        return;
      }
      default:
        // Unknown future frames carry no turn output.
        return;
    }
  }

  private ingestMessageList(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    for (const entry of messages) {
      if (!entry || typeof entry !== "object") continue;
      const message = entry as Record<string, unknown>;
      const id = message.id as string | undefined;
      if (!id) continue;

      const isHistory = this.state.closedMessages.has(id);
      // Terminal states vary: a normal finish is `success`, but a turn whose
      // stream was cut short is recorded as `cancelled`. Either way the message
      // is done and any later sighting of it is a replay.
      if (TERMINAL_MESSAGE_STATUS.has(message.status as string)) this.state.closedMessages.add(id);
      if (isHistory) continue;

      this.ingestElements(id, message.elements);
    }
  }

  private ingestUsage(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    for (const entry of messages) {
      if (!entry || typeof entry !== "object") continue;
      const message = entry as Record<string, unknown>;
      this.ingestPerformance(message.performanceMetrics);
      const usage = message.tokenUsage;
      if (!usage || typeof usage !== "object") continue;
      const record = usage as Record<string, unknown>;
      const used = toNumber(record.contextUsed);
      const size = toNumber(record.contextLimit);
      // tokenUsage is repeated on every snapshot of the same turn; clients only
      // need to hear about a change.
      if (used > 0 && size > 0 && (used !== this.state.lastUsage?.used || size !== this.state.lastUsage?.size)) {
        this.state.lastUsage = { used, size };
        this.emit({ type: "usage", used, size });
      }
      return;
    }
  }

  private ingestPerformance(metrics: unknown): void {
    if (!metrics || typeof metrics !== "object") return;
    const record = metrics as Record<string, unknown>;
    const ttft = toPositive(record.firstTokenLatency);
    const total = toPositive(record.totalDuration);
    if (ttft === undefined && total === undefined) return;

    // These grow with the turn; keep the widest observation of each.
    const next: TurnMetrics = {
      firstTokenLatencyMs: ttft ?? this.state.turnMetrics?.firstTokenLatencyMs,
      modelCallDurationMs: total ?? this.state.turnMetrics?.modelCallDurationMs,
    };
    const prev = this.state.turnMetrics;
    if (prev?.firstTokenLatencyMs === next.firstTokenLatencyMs
      && prev?.modelCallDurationMs === next.modelCallDurationMs) return;
    this.state.turnMetrics = next;
    this.emit({ type: "turn_metrics", ...next });
  }

  private ingestElements(messageId: string, elements: unknown): void {
    if (!Array.isArray(elements)) return;
    const id = messageId || "unknown";
    for (const entry of elements) {
      if (!entry || typeof entry !== "object") continue;
      const children = (entry as Record<string, unknown>).children;
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        if (!child || typeof child !== "object") continue;
        this.ingestElement(id, child as Record<string, unknown>);
      }
    }
  }

  private ingestElement(messageId: string, element: Record<string, unknown>): void {
    const elementId = element.id as string | undefined;
    if (!elementId) return;

    if (element.type === "TOOL") {
      this.ingestTool(messageId, elementId, element);
      return;
    }

    if (element.type !== "TEXT" && element.type !== "REASON") return;
    if (this.endedElements.has(elementId)) return;

    const content = typeof element.content === "string" ? element.content : "";
    const alreadySent = this.emittedLength.get(elementId) ?? 0;
    if (content.length <= alreadySent) {
      if (element.end === true) this.endedElements.add(elementId);
      return;
    }

    const delta = content.slice(alreadySent);
    this.emittedLength.set(elementId, content.length);
    if (element.end === true) this.endedElements.add(elementId);

    if (!delta) return;
    for (const char of delta) {
      if (CJK_CHAR.test(char)) this.cjkChars += 1;
      else this.otherChars += 1;
    }
    if (element.type === "REASON") this.emit({ type: "thought", messageId, text: delta });
    else this.emit({ type: "text", messageId, text: delta });
  }

  private ingestTool(messageId: string, toolCallId: string, element: Record<string, unknown>): void {
    const toolName = typeof element.toolName === "string" ? element.toolName : "tool";
    const rawState = typeof element.toolState === "string" ? element.toolState : "pending";
    const status = TOOL_STATE_TO_STATUS[rawState] ?? "pending";

    let state = this.tools.get(toolCallId);
    if (!state) {
      state = { status, started: true };
      this.tools.set(toolCallId, state);
      this.emit({
        type: "tool_start",
        messageId,
        toolCallId,
        title: describeTool(toolName, element.params),
        kind: mapToolKind(toolName),
        rawInput: element.params,
      });
      if (status === "pending") return;
    }

    if (state.status === status) return;
    state.status = status;
    this.emit({
      type: "tool_update",
      messageId,
      toolCallId,
      status,
      rawOutput: element.result,
    });
  }

  /** Conversation id from any frame; the first snapshot already carries it. */
  get conversationId(): string | undefined {
    return this.observedConversationId;
  }

  private observedConversationId: string | undefined;

  /** Estimated tokens generated this turn, reasoning included. */
  estimatedOutputTokens(): number {
    if (!this.cjkChars && !this.otherChars) return 0;
    return this.cjkChars + Math.ceil(this.otherChars / LATIN_CHARS_PER_TOKEN);
  }

  /** True once a terminal `conversation-status` frame was seen. */
  get finished(): boolean {
    return this.turnEnded;
  }

  private turnEnded = false;

  private endTurn(status: "completed" | "failed" | "cancelled", conversationId?: string): void {
    this.turnEnded = true;
    this.emit({ type: "turn_end", status, conversationId });
  }
}

/**
 * Estimates a token count from streamed text.
 *
 * comatecli reports context occupancy but never the per-turn output count, and
 * FreeBuddy refuses to estimate tokens itself. CJK text is roughly one token
 * per character; latin text averages about four characters per token.
 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const LATIN_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / LATIN_CHARS_PER_TOKEN);
}

export function mapToolKind(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes("run_command") || name.includes("exec") || name.includes("shell")) return "execute";
  if (name.includes("write") || name.includes("edit") || name.includes("patch") || name.includes("apply")) return "edit";
  if (name.includes("read") || name.includes("view") || name.includes("cat")) return "read";
  if (name.includes("search") || name.includes("grep") || name.includes("glob")) return "search";
  if (name.includes("delete") || name.includes("remove")) return "delete";
  if (name.includes("move") || name.includes("rename")) return "move";
  if (name.includes("fetch") || name.includes("web")) return "fetch";
  return "other";
}

function describeTool(toolName: string, params: unknown): string {
  if (params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    for (const key of ["description", "command", "path", "filePath", "query"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return truncate(value.trim(), 80);
    }
  }
  return toolName;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toPositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
