import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAuthMethods,
  buildLoginCliArgs,
  COMATE_AUTH_METHOD_ID,
  isComateAuthError,
} from "../dist/auth.js";

test("buildAuthMethods advertises terminal auth only when the client supports it", () => {
  assert.deepEqual(buildAuthMethods(undefined), [
    {
      id: COMATE_AUTH_METHOD_ID,
      name: "Comate 登录",
      description: "在终端运行 `comatecli login` 完成登录；已登录则可忽略。",
    },
  ]);

  assert.deepEqual(buildAuthMethods({ auth: { terminal: true } }), [
    {
      id: COMATE_AUTH_METHOD_ID,
      type: "terminal",
      args: ["--login"],
      name: "Comate 登录",
      description: "在内置终端运行 `comatecli login` 完成登录。",
    },
  ]);
});

test("isComateAuthError recognizes Comate missing/invalid credential errors without matching generic failures", () => {
  assert.equal(isComateAuthError("Error: No license or token provided.\nTips：可进入如流群"), true);
  assert.equal(isComateAuthError("Please enter a valid license."), true);
  assert.equal(isComateAuthError("Please enter a valid token."), true);
  assert.equal(isComateAuthError("未获取到认证信息"), true);
  assert.equal(isComateAuthError("尚未登录，请先运行 comatecli login"), true);

  assert.equal(isComateAuthError("fake comatecli: unrelated noise (exit 1)"), false);
  assert.equal(isComateAuthError("context length exceeded: too many tokens"), false);
});

test("buildLoginCliArgs translates --login into comatecli login args", () => {
  assert.deepEqual(buildLoginCliArgs(["--login"]), ["login"]);
  assert.deepEqual(buildLoginCliArgs(["--login", "--platform", "saas"]), [
    "login",
    "--platform",
    "saas",
  ]);
});
