import test from "node:test";
import assert from "node:assert/strict";
import { createRequestId, sanitizeLogDetails } from "../server/services/logger.js";

test("sanitizeLogDetails 会打码敏感字段并截断长文本", () => {
  const sanitized = sanitizeLogDetails({
    email: "student@example.com",
    password: "secret-password",
    authorization: "Bearer abc",
    cookie: "qimoshua_session=abc",
    nested: {
      token: "session-token",
      answer: "A".repeat(500),
    },
  });

  assert.equal(sanitized.email, "student@example.com");
  assert.equal(sanitized.password, "[redacted]");
  assert.equal(sanitized.authorization, "[redacted]");
  assert.equal(sanitized.cookie, "[redacted]");
  assert.equal(sanitized.nested.token, "[redacted]");
  assert.match(sanitized.nested.answer, /^A{200}\.\.\. \[truncated 300 chars\]$/);
});

test("createRequestId 会返回较短且可追踪的请求 ID", () => {
  assert.match(createRequestId(), /^req_[a-z0-9]+_[a-f0-9]{8}$/);
});
