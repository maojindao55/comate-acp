const LANGFUSE_WARN_LINE = /\[Langfuse SDK\]\s*\[WARN\]/i;
const GRACEFUL_EXIT_HEADER = /Error during graceful exit:/i;
const CLEANUP_ERROR_MARKER =
  /(?:agent-core provider cleanup failed|ProcessSupervisor shutdown failed|RuntimeLifecycle\s*释放失败|disposeOnce|Exit cleanup timed out)/i;
const UNCAUGHT_FATAL_MARKER = /Unhandled rejection:|Uncaught exception:/i;

/** Returns true for known noisy warning lines emitted by `comatecli` on stderr. */
export function isComateStderrNoise(line: string): boolean {
  return LANGFUSE_WARN_LINE.test(line);
}

/**
 * Line-buffered rolling tail of `comatecli` stderr that strips noisy SDK
 * warnings before they can crowd out actionable error messages.
 */
export class StderrTail {
  private readonly maxChars: number;
  private readonly lines: string[] = [];
  private lineChars = 0;
  private pending = "";

  constructor(maxChars = 4000) {
    this.maxChars = Math.max(0, maxChars);
  }

  push(chunk: string): void {
    if (!chunk || this.maxChars === 0) return;
    const parts = `${this.pending}${chunk}`.split(/\r?\n/);
    this.pending = parts.pop() ?? "";
    for (const line of parts) {
      if (isComateStderrNoise(line)) continue;
      const bounded = line.length > this.maxChars ? line.slice(-this.maxChars) : line;
      this.lines.push(bounded);
      this.lineChars += bounded.length;
      while (this.lines.length > 1 && this.lineChars + this.lines.length - 1 > this.maxChars) {
        const dropped = this.lines.shift()!;
        this.lineChars -= dropped.length;
      }
    }
  }

  text(): string {
    if (this.maxChars === 0) return "";
    const activeLines = [...this.lines];
    if (this.pending && !isComateStderrNoise(this.pending)) {
      activeLines.push(this.pending);
    }
    const joined = activeLines.join("\n").trim();
    return joined.length > this.maxChars ? joined.slice(-this.maxChars) : joined;
  }
}

/**
 * Returns true when `comatecli` stderr reflects a post-turn shutdown cleanup
 * failure rather than an execution or runtime exception.
 */
export function isGracefulExitCleanupError(detail: string): boolean {
  const match = detail.match(GRACEFUL_EXIT_HEADER);
  if (!match || match.index === undefined) return false;
  if (!CLEANUP_ERROR_MARKER.test(detail) || UNCAUGHT_FATAL_MARKER.test(detail)) return false;
  const beforeHeader = detail.slice(0, match.index);
  return !/^\s*(?:Error:|Unhandled rejection:|Uncaught exception:)/im.test(beforeHeader);
}
