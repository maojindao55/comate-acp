import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { spawnComate } from "./spawn.js";

export interface ModelOption {
  /** Value passed to `comatecli run -m`. */
  value: string;
  /** Human-readable label shown by the ACP client. */
  name: string;
}

/** `comatecli model list --ids` prints: `  GLM-5.1  (glm-5.1_a231cc…)` */
const MODEL_LINE = /^\s*(?:[*-]\s*)?(.+?)\s+\(([^()]+)\)\s*$/;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface ModelCache {
  fetchedAt: number;
  executable: string;
  models: ModelOption[];
}

/**
 * Model list, cached on disk.
 *
 * The catalogue lives behind the Comate service, so it can change without a CLI
 * upgrade; a stale list is served immediately and refreshed in the background.
 */
export class ModelCatalog {
  private readonly file: string;
  private models: ModelOption[] = [];
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly executable: string,
    baseDir?: string,
  ) {
    const root = baseDir ?? process.env.COMATE_ACP_HOME ?? join(homedir(), ".comate-acp");
    this.file = join(root, "models.json");
    this.models = this.read();
  }

  /** Options for the ACP `model` config option. Always at least the default. */
  options(): ModelOption[] {
    return this.models.length ? this.models : [{ value: "", name: "默认模型（Auto）" }];
  }

  /** Refreshes the list if the cache is stale; safe to call on every session. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private isFresh(): boolean {
    const cached = this.read();
    return cached.length > 0 && Date.now() - (this.readFetchedAt() ?? 0) < CACHE_TTL_MS;
  }

  private readFetchedAt(): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<ModelCache>;
      return typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetch(): Promise<void> {
    if (this.isFresh()) return;

    const models = await this.list();
    if (!models.length) return;

    this.models = models;
    const payload: ModelCache = { fetchedAt: Date.now(), executable: this.executable, models };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(temp, this.file);
  }

  private read(): ModelOption[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<ModelCache>;
      if (parsed.executable !== this.executable) return [];
      if (!Array.isArray(parsed.models)) return [];
      return parsed.models.filter(
        (entry): entry is ModelOption =>
          Boolean(entry) && typeof entry.value === "string" && typeof entry.name === "string",
      );
    } catch {
      return [];
    }
  }

  private list(): Promise<ModelOption[]> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnComate(this.executable, ["model", "list", "--ids"], {
          env: process.env,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        resolve([]);
        return;
      }

      let stdout = "";
      let settled = false;
      const done = (value: ModelOption[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done([]);
      }, FETCH_TIMEOUT_MS);

      child.stdout!.setEncoding("utf-8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", () => done([]));
      child.on("close", () => done(parseModelList(stdout)));
    });
  }
}

export function parseModelList(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const line of stdout.split("\n")) {
    const match = MODEL_LINE.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    const value = match[2].trim();
    if (!name || !value || seen.has(value)) continue;
    seen.add(value);
    models.push({ value, name });
  }
  return models;
}