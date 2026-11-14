import assert from "node:assert/strict";
import { test } from "node:test";

import { parseModelList } from "../dist/models.js";

const SAMPLE = `* Auto（自动选择）  (auto)
  Deepseek V4 Flash  (deepseek-v4-flash_a8668ea86c3d40e7ad1f8ee45715d447)
  GLM-5.1  (glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9)
  GLM-5.2  (glm-5.2_50c584482e9d47edbbe47938a88b56b1)
`;

test("parses the `model list --ids` table", () => {
  const models = parseModelList(SAMPLE);
  assert.equal(models.length, 4);
  assert.deepEqual(models[0], { value: "auto", name: "Auto（自动选择）" });
  assert.deepEqual(models[2], {
    value: "glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9",
    name: "GLM-5.1",
  });
});

test("skips the leading marker and blank lines", () => {
  const models = parseModelList(`\n${SAMPLE}\n\n`);
  assert.equal(models.length, 4);
  assert.ok(models.every((m) => m.value && m.name));
});

test("de-duplicates repeated ids", () => {
  const models = parseModelList(`${SAMPLE}  GLM-5.1  (glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9)\n`);
  assert.equal(models.filter((m) => m.value === "glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9").length, 1);
});

test("returns nothing for output without ids", () => {
  assert.deepEqual(parseModelList("  Auto（自动选择）\n  GLM-5.1\n"), []);
  assert.deepEqual(parseModelList(""), []);
});
test("token estimate counts CJK per character and latin per four", async () => {
  const { estimateTokens } = await import("../dist/eventParser.js");
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens("ok"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
  // Mixed: 2 CJK + 8 latin -> 2 + 2
  assert.equal(estimateTokens("你好abcdefgh"), 4);
});
