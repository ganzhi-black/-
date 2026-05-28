import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const OLD_RAILWAY_API_URL = "api-production-5b928.up.railway.app";
const CURRENT_RAILWAY_API_URL = "web-production-60950.up.railway.app";

test("frontend production API default points at the current Railway backend", () => {
  const apiService = readFileSync("src/services/api.js", "utf8");

  assert.match(apiService, new RegExp(`https://${CURRENT_RAILWAY_API_URL}`));
  assert.doesNotMatch(apiService, new RegExp(OLD_RAILWAY_API_URL));
  assert.match(apiService, /isRetiredRailwayApiUrl/);
  assert.match(apiService, /api-production-/);
});

test("environment example does not point developers at the retired Railway backend", () => {
  const envExample = readFileSync(".env.example", "utf8");

  assert.match(envExample, new RegExp(CURRENT_RAILWAY_API_URL));
  assert.doesNotMatch(envExample, new RegExp(OLD_RAILWAY_API_URL));
});
