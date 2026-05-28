import crypto from "node:crypto";

const SENSITIVE_KEY_PATTERN = /password|token|secret|authorization|cookie|session|api[-_]?key/i;
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;

export function createRequestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function truncateString(value) {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

export function sanitizeLogDetails(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogDetails(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`... [truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[max depth reached]";
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    const sanitized = {};
    for (const [key, item] of entries) {
      sanitized[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeLogDetails(item, depth + 1);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) sanitized.__truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
    return sanitized;
  }
  return String(value);
}

export function writeLog(level, event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogDetails(details),
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(event, details = {}) {
  writeLog("info", event, details);
}

export function logWarn(event, details = {}) {
  writeLog("warn", event, details);
}

export function logError(event, details = {}) {
  writeLog("error", event, details);
}
