import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * ACP sessions are ephemeral handles; the durable identity is comatecli's
 * conversation id, which is what `-c` resumes. We persist the mapping so a
 * client that reconnects (or a new ACP session that adopts an old
 * conversation) can keep talking to the same conversation.
 */
export interface StoredSession {
  sessionId: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  mode?: string;
  effort?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreShape {
  version: 1;
  sessions: Record<string, StoredSession>;
}

export class SessionStore {
  private readonly file: string;
  private cache: StoreShape;

  constructor(baseDir?: string) {
    const root = baseDir ?? process.env.COMATE_ACP_HOME ?? join(homedir(), ".comate-acp");
    this.file = join(root, "sessions.json");
    this.cache = this.read();
  }

  get(sessionId: string): StoredSession | undefined {
    return this.cache.sessions[sessionId];
  }

  list(): StoredSession[] {
    return Object.values(this.cache.sessions);
  }

  put(session: StoredSession): void {
    this.cache.sessions[session.sessionId] = session;
    this.flush();
  }

  /** Stores or clears the comate conversation id bound to an ACP session. */
  setConversationId(sessionId: string, conversationId: string | undefined): void {
    const existing = this.cache.sessions[sessionId];
    if (!existing) return;
    existing.conversationId = conversationId;
    existing.updatedAt = Date.now();
    this.flush();
  }

  delete(sessionId: string): void {
    if (!this.cache.sessions[sessionId]) return;
    delete this.cache.sessions[sessionId];
    this.flush();
  }

  /** Drops sessions whose working directory no longer exists. */
  prune(predicate: (session: StoredSession) => boolean): string[] {
    const removed: string[] = [];
    for (const [id, session] of Object.entries(this.cache.sessions)) {
      if (!predicate(session)) continue;
      delete this.cache.sessions[id];
      removed.push(id);
    }
    if (removed.length) this.flush();
    return removed;
  }

  private read(): StoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<StoreShape>;
      if (parsed && parsed.sessions && typeof parsed.sessions === "object") {
        return { version: 1, sessions: parsed.sessions };
      }
    } catch {
      // Missing or corrupt store starts empty; it is a cache, not source of truth.
    }
    return { version: 1, sessions: {} };
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.cache, null, 2), "utf-8");
    renameSync(temp, this.file);
  }
}