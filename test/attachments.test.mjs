import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { materializePrompt } from "../dist/attachments.js";

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("inline image data is written to a path and passed through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comate-acp-att-"));
  process.env.COMATE_ACP_HOME = dir;
  try {
    const { text, images } = await materializePrompt([
      { type: "text", text: "这是什么图" },
      { type: "image", mimeType: "image/png", data: PNG_B64 },
    ]);
    assert.equal(text, "这是什么图");
    assert.equal(images.length, 1);
    assert.ok(existsSync(images[0]), `应生成文件: ${images[0]}`);
    assert.ok(images[0].endsWith(".png"));
    assert.ok(readFileSync(images[0]).length > 0);
  } finally {
    delete process.env.COMATE_ACP_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same bytes map to one cached file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comate-acp-att-"));
  process.env.COMATE_ACP_HOME = dir;
  try {
    const first = await materializePrompt([{ type: "image", mimeType: "image/png", data: PNG_B64 }]);
    const second = await materializePrompt([{ type: "image", mimeType: "image/png", data: PNG_B64 }]);
    assert.deepEqual(first.images, second.images);
  } finally {
    delete process.env.COMATE_ACP_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file uri is used in place, not copied", async () => {
  process.env.COMATE_ACP_HOME = tmpdir();
  try {
    const abs = new URL("./fixtures/pending-record.json", import.meta.url).pathname;
    const { images } = await materializePrompt([{ type: "image", mimeType: "image/png", uri: abs }]);
    assert.deepEqual(images, [abs]);
  } finally {
    delete process.env.COMATE_ACP_HOME;
  }
});

test("unknown mime types still produce a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comate-acp-att-"));
  process.env.COMATE_ACP_HOME = dir;
  try {
    const { images } = await materializePrompt([{ type: "image", data: PNG_B64 }]);
    assert.equal(images.length, 1);
    assert.ok(images[0].endsWith(".img"));
  } finally {
    delete process.env.COMATE_ACP_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("text-only and malformed prompts are unchanged", async () => {
  const { text, images } = await materializePrompt([{ type: "text", text: "hi" }, null, "nope"]);
  assert.equal(text, "hi");
  assert.deepEqual(images, []);
  assert.deepEqual(await materializePrompt(undefined), { text: "", images: [] });
});
