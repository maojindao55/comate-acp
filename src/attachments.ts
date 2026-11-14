import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ACP delivers images as `{ type: "image", mimeType, data }` base64 blocks, but
 * comatecli only accepts `--attach-image <path>`. Blocks that arrive with a uri
 * are used in place; inline data is written to a content-addressed cache so the
 * same image sent again on a later turn maps to the same file.
 */
export interface MaterializedPrompt {
  /** Text of the turn, with non-image resources flattened in. */
  text: string;
  /** Paths to hand to `--attach-image`. */
  images: string[];
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

function cacheDir(): string {
  const root = process.env.COMATE_ACP_HOME ?? join(homedir(), ".comate-acp");
  return join(root, "attachments");
}

function tempDir(): string {
  return process.env.COMATE_ACP_TMPDIR ?? tmpdir();
}

/** Turns a file:// uri into a path, leaving plain paths alone. */
function toPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

export async function materializePrompt(blocks: unknown): Promise<MaterializedPrompt> {
  const text: string[] = [];
  const images: string[] = [];
  if (!Array.isArray(blocks)) return { text: "", images };

  for (const entry of blocks) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }

    if (block.type === "image" || block.type === "audio") {
      const path = await materialize(block, block.type === "image" ? "image" : "audio");
      if (path) images.push(path);
      continue;
    }

    if (block.type === "resource_link" && typeof block.uri === "string") {
      text.push(block.uri);
      continue;
    }

    if (block.type === "resource") {
      const resource = block.resource as Record<string, unknown> | undefined;
      if (resource && typeof resource.uri === "string") text.push(resource.uri);
    }
  }

  return { text: text.filter(Boolean).join("\n\n"), images };
}

async function materialize(block: Record<string, unknown>, kind: "image" | "audio"): Promise<string | undefined> {
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";

  if (typeof block.uri === "string" && block.uri) {
    const path = toPath(block.uri);
    return existsSync(path) ? path : undefined;
  }

  if (typeof block.data !== "string" || !block.data) return undefined;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(block.data, "base64");
  } catch {
    return undefined;
  }
  if (!buffer.length) return undefined;

  const ext = EXT_BY_MIME[mimeType] ?? (kind === "image" ? ".img" : ".bin");
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const dir = cacheDir();
  const file = join(dir, `${digest}${ext}`);

  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    // Exclusive-ish write: a concurrent turn with the same bytes writes the
    // same content, so an overwrite would be harmless anyway.
    writeFileSync(file, buffer);
  }
  return file;
}

/** Where inline attachments land, exposed for diagnostics. */
export function attachmentCacheDir(): string {
  return cacheDir() ?? tempDir();
}