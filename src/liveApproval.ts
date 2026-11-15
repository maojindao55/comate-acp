import type { ChildProcess } from "node:child_process";
import type { RequiresActionPayload } from "./eventParser.js";

/** Comate 2.0's JSON stdin router confirms/rejects MCP tools in the live process. */
export function sendLiveDecision(child: ChildProcess, action: RequiresActionPayload, decision: "approve" | "reject"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin?.writable || !action.toolId || !action.conversationId) {
      reject(new Error("Comate live MCP approval channel is unavailable"));
      return;
    }
    const message = {
      type: "stdin_action", conversationId: action.conversationId, toolId: action.toolId,
      action: "tool-call-action", name: decision === "approve" ? "confirm" : "reject", payload: {},
    };
    child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
  });
}
