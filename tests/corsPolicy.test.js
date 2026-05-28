import test from "node:test";
import assert from "node:assert/strict";
import {
  corsHeadersForRequest,
  effectiveCorsOrigins,
  isAllowedOrigin,
  parseConfiguredOrigins,
} from "../server/services/corsPolicy.js";

test("effectiveCorsOrigins 会包含当前 Vercel 预览域名和正式域名", () => {
  const origins = effectiveCorsOrigins("");

  assert.equal(isAllowedOrigin("https://qimoshua-li7dtcdmw-ganzhi-blacks-projects.vercel.app", origins), true);
  assert.equal(isAllowedOrigin("https://qimoshua-s8i2fbihf-ganzhi-blacks-projects.vercel.app", origins), true);
  assert.equal(isAllowedOrigin("https://qimoshua.top", origins), true);
  assert.equal(isAllowedOrigin("https://www.qimoshua.top", origins), true);
});

test("parseConfiguredOrigins 会按英文逗号拆分并去掉空白", () => {
  assert.deepEqual(parseConfiguredOrigins(" https://a.com,https://b.com "), ["https://a.com", "https://b.com"]);
});

test("isAllowedOrigin 支持精确域名和通配 vercel.app 域名", () => {
  const origins = effectiveCorsOrigins("https://qimoshua.top,https://*.vercel.app");

  assert.equal(isAllowedOrigin("https://qimoshua.top", origins), true);
  assert.equal(isAllowedOrigin("https://preview-user-project.vercel.app", origins), true);
  assert.equal(isAllowedOrigin("https://evil.example.com", origins), false);
});

test("corsHeadersForRequest 在通配配置下会反射请求来源并允许凭证", () => {
  const headers = corsHeadersForRequest({
    origin: "https://qimoshua-li7dtcdmw-ganzhi-blacks-projects.vercel.app",
    requestHeaders: "content-type,x-visitor-id",
    configuredOrigins: effectiveCorsOrigins("*"),
  });

  assert.equal(headers["Access-Control-Allow-Origin"], "https://qimoshua-li7dtcdmw-ganzhi-blacks-projects.vercel.app");
  assert.equal(headers["Access-Control-Allow-Credentials"], "true");
  assert.equal(headers["Access-Control-Allow-Headers"], "content-type,x-visitor-id");
  assert.equal(headers.Vary, "Origin");
});
