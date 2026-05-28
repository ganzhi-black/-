const DEFAULT_ALLOWED_HEADERS = "Content-Type, X-Visitor-Id";
const DEFAULT_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://qimoshua-li7dtcdmw-ganzhi-blacks-projects.vercel.app",
  "https://qimoshua-s8i2fbihf-ganzhi-blacks-projects.vercel.app",
  "https://qimoshua.top",
  "https://www.qimoshua.top",
  "https://*.vercel.app",
];

export function parseConfiguredOrigins(value = "") {
  return String(value)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function effectiveCorsOrigins(value = "") {
  const configured = parseConfiguredOrigins(value);
  return [...new Set([...configured, ...DEFAULT_ALLOWED_ORIGINS])];
}

export function isAllowedOrigin(origin, configuredOrigins = []) {
  if (!origin) return true;
  if (configuredOrigins.length === 0 || configuredOrigins.includes("*")) return true;
  if (configuredOrigins.includes(origin)) return true;

  try {
    const originUrl = new URL(origin);
    return configuredOrigins.some((allowedOrigin) => {
      if (!allowedOrigin.includes("*.")) return false;
      const allowedUrl = new URL(allowedOrigin.replace("*.", ""));
      const suffix = `.${allowedUrl.hostname}`;
      return allowedUrl.protocol === originUrl.protocol && originUrl.hostname.endsWith(suffix);
    });
  } catch {
    return false;
  }
}

export function corsHeadersForRequest({ origin, requestHeaders, configuredOrigins = [] }) {
  if (!origin || !isAllowedOrigin(origin, configuredOrigins)) return null;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": DEFAULT_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": requestHeaders || DEFAULT_ALLOWED_HEADERS,
    Vary: "Origin",
  };
}

export function createCorsOptions(configuredOrigins = []) {
  if (configuredOrigins.length === 0 || configuredOrigins.includes("*")) {
    return {
      origin: true,
      credentials: true,
    };
  }

  return {
    credentials: true,
    origin(origin, callback) {
      if (isAllowedOrigin(origin, configuredOrigins)) return callback(null, true);
      return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
  };
}
