import cors from "cors";
import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import multer from "multer";
import { chunkText } from "./services/chunker.js";
import { corsHeadersForRequest, createCorsOptions, effectiveCorsOrigins } from "./services/corsPolicy.js";
import { embedTexts } from "./services/embeddings.js";
import { extractTextFromFile } from "./services/extractText.js";
import { createDbStore } from "./services/dbStore.js";
import { createMemoryStore } from "./services/memoryStore.js";
import { gradeSingleAnswer, gradeSubjectiveAnswer } from "./services/aiGrader.js";
import { generateQuestionsFromSources } from "./services/aiQuestions.js";
import { createRequestId, logError, logInfo, logWarn } from "./services/logger.js";
import { setupQwenRealtimeAsr } from "./services/qwenRealtimeAsr.js";
import { repairMojibake } from "./services/textRepair.js";
import { transcribeAudioFile } from "./services/transcription.js";

dotenv.config();

const QUESTION_QUERY = "重点 考点 高频考点 题目 试题 简答题 论述题 名词解释 填空题 选择题";
const practiceCursor = new Map();
const KEY_POINT_PATTERN = /重点|重點|高频|高頻|必背|必考|考点|考點|核心|重要|掌握|熟悉|注意/g;
const EXISTING_QUESTION_PATTERN = /模拟试题|模擬試題|练习题|練習題|填空题|選擇題|选择题|简答题|簡答題|论述题|論述題|名词解释|名詞解釋|问答题|問答題|一、|二、|三、|\d+[、.．]/g;
const TERM_QUESTION_PATTERN = /名词解释|名詞解釋|解释下列名词|解釋下列名詞|名词释义|名詞釋義/g;
const TERM_DEFINITION_PATTERNS = [
  /\*\*[^*\n]{2,30}\*\*\s*[：:]\s*[\s\S]{12,}/,
  /(?:^|\n)\s*(?:\d+[、.．]\s*)?[\u4e00-\u9fffA-Za-z《》“”"·]{2,30}\s*[：:]\s*[\u4e00-\u9fff][^。\n]{8,}/m,
  /(?:^|\n)\s*[\u4e00-\u9fffA-Za-z《》“”"·]{2,24}\s*\n\s*(?:是|指|即|又称|所谓|指的是)\S{8,}/m,
  /(?:^|\n)#{2,4}\s*[\u4e00-\u9fffA-Za-z《》“”"·]{2,24}\s*\n\s*(?:是|指|即|又称|所谓|指的是)\S{8,}/m,
];

const CLEAN_QUESTION_QUERY = "\u91cd\u70b9 \u8003\u70b9 \u9ad8\u9891\u8003\u70b9 \u9898\u76ee \u8bd5\u9898 \u7b80\u7b54\u9898 \u8bba\u8ff0\u9898 \u540d\u8bcd\u89e3\u91ca \u586b\u7a7a\u9898 \u9009\u62e9\u9898";
const CLEAN_KEY_POINT_PATTERN = /\u91cd\u70b9|\u91cd\u9ede|\u9ad8\u9891|\u9ad8\u983b|\u5fc5\u80cc|\u5fc5\u8003|\u8003\u70b9|\u8003\u9ede|\u6838\u5fc3|\u91cd\u8981|\u638c\u63e1|\u719f\u6089|\u6ce8\u610f/g;
const CLEAN_EXISTING_QUESTION_PATTERN = /\u6a21\u62df\u8bd5\u9898|\u6a21\u64ec\u8a66\u984c|\u7ec3\u4e60\u9898|\u7df4\u7fd2\u984c|\u586b\u7a7a\u9898|\u9078\u64c7\u984c|\u9009\u62e9\u9898|\u7b80\u7b54\u9898|\u7c21\u7b54\u984c|\u8bba\u8ff0\u9898|\u8ad6\u8ff0\u984c|\u540d\u8bcd\u89e3\u91ca|\u540d\u8a5e\u89e3\u91cb|\u95ee\u7b54\u9898|\u554f\u7b54\u984c|\u4e00\u3001|\u4e8c\u3001|\u4e09\u3001|\d+[\u3001.\uff0e]/g;
const CLEAN_TERM_QUESTION_PATTERN = /\u540d\u8bcd\u89e3\u91ca|\u540d\u8a5e\u89e3\u91cb|\u89e3\u91ca\u4e0b\u5217\u540d\u8bcd|\u89e3\u91cb\u4e0b\u5217\u540d\u8a5e|\u540d\u8bcd\u91ca\u4e49|\u540d\u8a5e\u91cb\u7fa9/g;
const CLEAN_TERM_DEFINITION_PATTERNS = [
  /\*\*[^*\n]{2,30}\*\*\s*[\uff1a:]\s*[\s\S]{12,}/,
  /(?:^|\n)\s*(?:\d+[\u3001.\uff0e]\s*)?[\u4e00-\u9fffA-Za-z\u300a\u300b\u201c\u201d"\u00b7]{2,30}\s*[\uff1a:]\s*[\u4e00-\u9fff][^\u3002\n]{8,}/m,
  /(?:^|\n)\s*[\u4e00-\u9fffA-Za-z\u300a\u300b\u201c\u201d"\u00b7]{2,24}\s*\n\s*(?:\u662f|\u6307|\u5373|\u53c8\u79f0|\u6240\u8c13|\u6307\u7684\u662f)\S{8,}/m,
  /(?:^|\n)#{2,4}\s*[\u4e00-\u9fffA-Za-z\u300a\u300b\u201c\u201d"\u00b7]{2,24}\s*\n\s*(?:\u662f|\u6307|\u5373|\u53c8\u79f0|\u6240\u8c13|\u6307\u7684\u662f)\S{8,}/m,
];

const app = express();
const uploadLimitMb = Number(process.env.UPLOAD_MAX_MB || 80);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadLimitMb * 1024 * 1024 },
});
const useMemoryStore = process.env.USE_MEMORY_STORE === "1";
const store = !useMemoryStore && process.env.DATABASE_URL ? await createDbStore(process.env.DATABASE_URL) : createMemoryStore();

const configuredCorsOrigins = effectiveCorsOrigins(process.env.CORS_ORIGINS || "");
const DEPLOY_VERSION = "cors-debug-2026-05-28-1";

app.use((req, res, next) => {
  res.setHeader("X-Qimoshua-Build", DEPLOY_VERSION);
  const corsHeaders = corsHeadersForRequest({
    origin: req.get("origin"),
    requestHeaders: req.get("access-control-request-headers"),
    configuredOrigins: configuredCorsOrigins,
  });

  if (corsHeaders) {
    for (const [key, value] of Object.entries(corsHeaders)) res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    logInfo("cors_preflight", {
      build: DEPLOY_VERSION,
      origin: req.get("origin") || "",
      path: req.originalUrl || req.url,
      allowed: Boolean(corsHeaders),
      requestHeaders: req.get("access-control-request-headers") || "",
      configuredOriginCount: configuredCorsOrigins.length,
    });
    return res.status(corsHeaders ? 204 : 403).end();
  }

  next();
});

app.use(cors(createCorsOptions(configuredCorsOrigins)));
app.use(express.json({ limit: "2mb" }));

function requestLogBase(req) {
  return {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    userId: req.user?.id || null,
    visitorId: req.visitorId || null,
  };
}

function requestBodyForLog(req) {
  const method = String(req.method || "").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return undefined;
  if (!req.is?.("application/json")) return undefined;
  return req.body && typeof req.body === "object" ? req.body : undefined;
}

app.use((req, res, next) => {
  const startedAt = performance.now();
  req.requestId = req.get("x-request-id") || createRequestId();
  res.setHeader("X-Request-Id", req.requestId);
  req.logStep = (event, details = {}) => {
    logInfo(event, {
      ...requestLogBase(req),
      ...details,
    });
  };

  logInfo("request_started", {
    ...requestLogBase(req),
    query: req.query,
    body: requestBodyForLog(req),
    contentType: req.get("content-type") || "",
    contentLength: req.get("content-length") || "",
  });

  res.on("finish", () => {
    const statusCode = res.statusCode;
    const log = statusCode >= 500 ? logError : statusCode >= 400 ? logWarn : logInfo;
    log("request_finished", {
      ...requestLogBase(req),
      statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });

  next();
});

const SESSION_COOKIE_NAME = "qimoshua_session";
const SESSION_TTL_DAYS = Number(process.env.AUTH_SESSION_DAYS || 30);
const PASSWORD_MIN_LENGTH = 8;

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    String(cookieHeader)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash = "") {
  const [scheme, salt, hash] = storedHash.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function configuredAdminEmails() {
  return String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email) {
  const configuredEmails = configuredAdminEmails();
  return configuredEmails.length > 0 && configuredEmails.includes(String(email || "").trim().toLowerCase());
}

function isTransientBackendError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("connection terminated") ||
    message.includes("connection reset") ||
    message.includes("connection timeout") ||
    message.includes("terminating connection") ||
    error?.code === "ECONNRESET" ||
    error?.code === "ETIMEDOUT"
  );
}

function publicUser(user) {
  const email = user.email || "";
  return {
    id: user.id || user.user_id,
    email,
    nickname: user.nickname,
    createdAt: user.created_at,
    isAdmin: isAdminEmail(email),
  };
}

function sessionCookieOptions() {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const defaultSameSite = process.env.NODE_ENV === "production" ? "none" : "lax";
  const sameSite = String(process.env.AUTH_COOKIE_SAMESITE || defaultSameSite).toLowerCase();
  return {
    httpOnly: true,
    sameSite,
    secure: sameSite === "none" || process.env.NODE_ENV === "production",
    maxAge,
    path: "/",
  };
}

async function createLoginSession(req, res, user) {
  await claimVisitorDataForUser(req, user.id);

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await store.createAuthSession({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: req.get("user-agent"),
    ipAddress: req.ip,
  });
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

async function claimVisitorDataForUser(req, userId) {
  if (store.claimVisitorData) {
    const claimResult = await store.claimVisitorData({
      visitorId: req.get("x-visitor-id"),
      userId,
    });
    if (claimResult?.claimed) {
      req.logStep?.("visitor_data_claimed", {
        userId,
        visitorUserId: claimResult.visitorUserId || null,
        counts: claimResult.counts || {},
      });
    }
  }
}

async function resolveAuth(req, res, next) {
  try {
    const token = parseCookies(req.get("cookie"))[SESSION_COOKIE_NAME];
    if (token) {
      const session = await store.getAuthSession(hashSessionToken(token));
      if (session) {
        req.user = publicUser(session);
        req.visitorId = req.user.id;
        await claimVisitorDataForUser(req, req.user.id);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireAuth(req, res, next) {
  if (process.env.DISABLE_ADMIN_AUTH === "1" && String(req.originalUrl || "").startsWith("/api/admin/")) {
    return next();
  }

  if (!req.user) {
    return res.status(401).json({ error: "请先注册或登录后再使用。" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (process.env.DISABLE_ADMIN_AUTH === "1") return next();

  const configuredEmails = configuredAdminEmails();

  if (configuredEmails.length === 0) {
    return res.status(403).json({ error: "未配置管理员邮箱，数据看板暂不可访问。" });
  }
  if (isAdminEmail(req.user?.email)) return next();

  return res.status(403).json({ error: "你没有查看数据看板的权限。" });
}

app.use(resolveAuth);

function createSessionPayload({ subjectId, mode, questions }) {
  return {
    id: `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    subjectId,
    mode,
    questions,
    answers: [],
    currentIndex: 0,
    retryMistakeIds: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

function prepareQuestionsForImmediateReturn({ questions, subjectId, documentHash = null }) {
  const generatedAt = new Date().toISOString();
  return questions.map((question) => ({
    ...question,
    id: question.id || crypto.randomUUID(),
    subjectId,
    documentHash,
    generatedAt: question.generatedAt || generatedAt,
  }));
}

function normalizeForHash(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function createContentHash(text) {
  return crypto.createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex");
}

function rankSourcesForPractice(sources) {
  const withRank = sources.map((source, index) => {
    const text = source.text || "";
    const hasKeyPoint = CLEAN_KEY_POINT_PATTERN.test(text);
    CLEAN_KEY_POINT_PATTERN.lastIndex = 0;
    const hasExistingQuestion = CLEAN_EXISTING_QUESTION_PATTERN.test(text);
    CLEAN_EXISTING_QUESTION_PATTERN.lastIndex = 0;
    return {
      source,
      index,
      bucket: hasKeyPoint ? 0 : hasExistingQuestion ? 1 : 2,
    };
  });

  return withRank
    .sort((left, right) => left.bucket - right.bucket || left.index - right.index)
    .map((item) => item.source);
}

function hasExplicitTermQuestion(text) {
  const matched = CLEAN_TERM_QUESTION_PATTERN.test(text || "");
  CLEAN_TERM_QUESTION_PATTERN.lastIndex = 0;
  return matched;
}

function hasImplicitTermDefinition(text) {
  return CLEAN_TERM_DEFINITION_PATTERNS.some((pattern) => pattern.test(text || ""));
}

function hasTermMaterial(text) {
  return hasExplicitTermQuestion(text) || hasImplicitTermDefinition(text);
}

async function getPracticeSources({ visitorId, subjectId, amount, types }) {
  const cursorKey = `${visitorId}:${subjectId}:${types.join(",")}`;
  const cursor = practiceCursor.get(cursorKey) || 0;
  const poolSize = Math.max(120, amount * 20);
  const chunkPool = store.listChunks
    ? await store.listChunks({ visitorId, subjectId, limit: poolSize })
    : await store.searchChunks({ visitorId, subjectId, queryEmbedding: (await embedTexts([CLEAN_QUESTION_QUERY]))[0], limit: poolSize });

  const wantsTerm = types.includes("term");
  if (wantsTerm) {
    const hasTermQuestion = chunkPool.some((source) => hasTermMaterial(source.text));

    if (!hasTermQuestion) {
      throw new Error("这份资料没有检测到“名词解释”或“名词+解释”结构，不能生成名词解释题。请取消勾选名词解释，或上传包含概念解释内容的资料。");
    }
  }

  const ranked = wantsTerm
    ? [
        ...chunkPool.filter((source) => hasExplicitTermQuestion(source.text)),
        ...chunkPool.filter((source) => !hasExplicitTermQuestion(source.text) && hasImplicitTermDefinition(source.text)),
        ...rankSourcesForPractice(
          chunkPool.filter((source) => {
            return !hasTermMaterial(source.text);
          }),
        ),
      ]
    : rankSourcesForPractice(chunkPool);
  const windowSize = Math.min(ranked.length, Math.max(8, amount * 2));
  const sources =
    ranked.length > windowSize
      ? Array.from({ length: windowSize }, (_, index) => ranked[(cursor + index) % ranked.length])
      : ranked;

  practiceCursor.set(cursorKey, ranked.length ? (cursor + windowSize) % ranked.length : 0);
  return sources;
}

async function getOrGenerateQuestions({ visitorId, subjectId, types, amount, logStep = null }) {
  const startedAt = performance.now();
  const safeAmount = Math.min(50, Math.max(1, Number(amount) || 5));
  const requestedTypes = Array.isArray(types) && types.length ? types : ["single"];
  const sources = await getPracticeSources({ visitorId, subjectId, amount: safeAmount, types: requestedTypes });
  const retrievedAt = performance.now();
  logStep?.("questions_sources_loaded", {
    subjectId,
    requestedAmount: safeAmount,
    requestedTypes,
    sourceCount: sources.length,
  });
  const documentHashes = store.getDocumentHashesForSubject ? await store.getDocumentHashesForSubject({ visitorId, subjectId }) : [];
  const priorQuestions = store.getPriorQuestionsByDocumentHashes
    ? await store.getPriorQuestionsByDocumentHashes({ visitorId, documentHashes, types: requestedTypes, limit: 500 })
    : [];
  const currentSubjectQuestions = store.getRecentQuestions
    ? await store.getRecentQuestions({ visitorId, subjectId, types: requestedTypes, limit: 500 })
    : [];
  const historyLoadedAt = performance.now();
  logStep?.("questions_history_loaded", {
    subjectId,
    documentHashCount: documentHashes.length,
    priorQuestionCount: priorQuestions.length,
    currentSubjectQuestionCount: currentSubjectQuestions.length,
  });
  const questions = await generateQuestionsFromSources({
    sources,
    types: requestedTypes,
    amount: safeAmount,
    excludedQuestions: [...priorQuestions, ...currentSubjectQuestions],
  });
  const generatedAt = performance.now();
  logStep?.("questions_ai_generated", {
    subjectId,
    generatedQuestionCount: questions.length,
  });
  const savedQuestions = prepareQuestionsForImmediateReturn({
    questions,
    subjectId,
    documentHash: documentHashes[0] || null,
  });
  await store.saveQuestions({ visitorId, subjectId, questions: savedQuestions, documentHash: documentHashes[0] || null });
  const savedAt = performance.now();
  const timings = {
    retrievalMs: Math.round(retrievedAt - startedAt),
    historyMs: Math.round(historyLoadedAt - retrievedAt),
    generationMs: Math.round(generatedAt - historyLoadedAt),
    saveMs: Math.round(savedAt - generatedAt),
    totalMs: Math.round(savedAt - startedAt),
  };

  logInfo("questions_generated", {
    subjectId,
    requestedAmount: safeAmount,
    requestedTypes,
    sourceCount: sources.length,
    generatedQuestionCount: savedQuestions.length,
    timings,
  });

  return {
    questions: savedQuestions,
    sourceChunkCount: sources.length,
    cached: false,
    timings,
  };
}

app.get("/api/health", async (req, res, next) => {
  try {
    if (store.health) await store.health();
    res.json({
      ok: true,
      service: "qimoshua-rag-api",
      mode: useMemoryStore || !process.env.DATABASE_URL ? "memory" : "database",
      build: DEPLOY_VERSION,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/debug/cors", (req, res) => {
  const origin = String(req.query?.origin || req.get("origin") || "").trim();
  res.json({
    build: DEPLOY_VERSION,
    origin,
    configuredOrigins: configuredCorsOrigins,
    computedHeaders: corsHeadersForRequest({
      origin,
      requestHeaders: "content-type,x-visitor-id",
      configuredOrigins: configuredCorsOrigins,
    }),
  });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const nickname = String(req.body?.nickname || "").trim();
    req.logStep("auth_register_requested", { email, hasNickname: Boolean(nickname) });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "请输入有效邮箱。" });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `密码至少需要 ${PASSWORD_MIN_LENGTH} 位。` });
    }

    const user = await store.createUser({
      email,
      passwordHash: hashPassword(password),
      nickname: nickname.slice(0, 30) || email.split("@")[0],
    });
    await createLoginSession(req, res, user);
    req.logStep("auth_register_completed", { userId: user.id, email });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({ error: "这个邮箱已经注册过了。" });
    }
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    req.logStep("auth_login_requested", { email });
    const user = await store.getUserByEmail(email);

    if (!user || !verifyPassword(password, user.password_hash)) {
      req.logStep("auth_login_rejected", { email, reason: "invalid_credentials" });
      return res.status(401).json({ error: "邮箱或密码不正确。" });
    }

    await createLoginSession(req, res, user);
    req.logStep("auth_login_completed", { userId: user.id, email });
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = parseCookies(req.get("cookie"))[SESSION_COOKIE_NAME];
    if (token) await store.deleteAuthSession(hashSessionToken(token));
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    req.logStep("auth_logout_completed", { hadToken: Boolean(token) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "请先登录。" });
  res.json({ user: req.user });
});

app.use("/api", requireAuth);

app.post("/api/subjects", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Subject name is required." });

    const subject = await store.createSubject({ visitorId: req.visitorId, name });
    req.logStep("subject_created", { subjectId: subject.id, name });
    res.status(201).json(subject);
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects", async (req, res, next) => {
  try {
    const subjects = await store.listSubjects({ visitorId: req.visitorId });
    req.logStep("subjects_listed", { subjectCount: subjects.length });
    res.json(subjects);
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects/:subjectId", async (req, res, next) => {
  try {
    const subject = await store.getSubject({ visitorId: req.visitorId, subjectId: req.params.subjectId });
    if (!subject) return res.status(404).json({ error: "Subject not found." });
    req.logStep("subject_loaded", { subjectId: req.params.subjectId });
    res.json(subject);
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects/:subjectId/questions", async (req, res, next) => {
  try {
    if (!store.listQuestionsForSubject) return res.json([]);
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit || 500)));
    const questions = await store.listQuestionsForSubject({ visitorId: req.visitorId, subjectId: req.params.subjectId, limit });
    req.logStep("subject_questions_listed", { subjectId: req.params.subjectId, questionCount: questions.length, limit });
    res.json(questions);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/subjects/:subjectId/questions/:questionId", async (req, res, next) => {
  try {
    if (!store.deleteQuestionForSubject) return res.status(501).json({ error: "Question deletion is not available." });
    const deleted = await store.deleteQuestionForSubject({
      visitorId: req.visitorId,
      subjectId: req.params.subjectId,
      questionId: req.params.questionId,
    });
    if (!deleted) return res.status(404).json({ error: "Question not found." });
    req.logStep("subject_question_deleted", { subjectId: req.params.subjectId, questionId: req.params.questionId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/subjects/:subjectId", async (req, res, next) => {
  try {
    const deleted = await store.deleteSubject({ visitorId: req.visitorId, subjectId: req.params.subjectId });
    if (!deleted) return res.status(404).json({ error: "Subject not found." });
    req.logStep("subject_deleted", { subjectId: req.params.subjectId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/upload", upload.single("file"), async (req, res, next) => {
  try {
    const startedAt = performance.now();
    const subjectId = String(req.body?.subjectId || "").trim();
    if (!subjectId) return res.status(400).json({ error: "subjectId is required." });
    if (!req.file) return res.status(400).json({ error: "file is required." });
    req.logStep("upload_received", {
      subjectId,
      fileName: repairMojibake(req.file.originalname),
      mimeType: req.file.mimetype,
      size: req.file.size,
    });

    const text = await extractTextFromFile(req.file);
    const extractedAt = performance.now();
    req.logStep("upload_text_extracted", {
      subjectId,
      textLength: text.length,
    });
    const contentHash = createContentHash(text);
    const chunks = chunkText(text, { chunkSize: Number(process.env.DOC_CHUNK_SIZE || 800) });
    const chunkedAt = performance.now();
    req.logStep("upload_text_chunked", {
      subjectId,
      chunkCount: chunks.length,
      contentHash,
    });
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
    const embeddedAt = performance.now();
    req.logStep("upload_embeddings_created", {
      subjectId,
      embeddingCount: embeddings.length,
    });

    const document = await store.createDocument({
      visitorId: req.visitorId,
      subjectId,
      fileName: repairMojibake(req.file.originalname),
      mimeType: req.file.mimetype,
      size: req.file.size,
      textLength: text.length,
      contentHash,
    });

    const savedChunks = await store.addChunks({
      visitorId: req.visitorId,
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        subjectId,
        documentId: document.id,
        embedding: embeddings[index],
      })),
    });
    const savedAt = performance.now();
    req.logStep("upload_saved", {
      subjectId,
      documentId: document.id,
      savedChunkCount: savedChunks.length,
    });
    const timings = {
      extractMs: Math.round(extractedAt - startedAt),
      chunkMs: Math.round(chunkedAt - extractedAt),
      embeddingMs: Math.round(embeddedAt - chunkedAt),
      saveMs: Math.round(savedAt - embeddedAt),
      totalMs: Math.round(savedAt - startedAt),
    };

    logInfo("upload_completed", {
      ...requestLogBase(req),
      subjectId,
      fileName: repairMojibake(req.file.originalname),
      textLength: text.length,
      chunkCount: chunks.length,
      timings,
    });

    res.status(201).json({
      document,
      chunkCount: savedChunks.length,
      timings,
      preview: savedChunks.slice(0, 3).map((chunk) => ({
        id: chunk.id,
        text: chunk.text.slice(0, 160),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/retrieval/search", async (req, res, next) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const query = String(req.body?.query || "").trim();
    const limit = Number(req.body?.limit || 5);

    if (!subjectId || !query) return res.status(400).json({ error: "subjectId and query are required." });
    req.logStep("retrieval_search_requested", { subjectId, query, limit });

    const [queryEmbedding] = await embedTexts([query]);
    const matches = await store.searchChunks({ visitorId: req.visitorId, subjectId, queryEmbedding, limit });
    req.logStep("retrieval_search_completed", {
      subjectId,
      matchCount: matches.length,
      topScore: matches[0]?.score ?? null,
    });

    res.json({
      query,
      matches: matches.map((match) => ({
        id: match.id,
        documentId: match.documentId,
        score: match.score,
        text: match.text,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/audio/transcribe", upload.single("audio"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "audio is required." });
    req.logStep("audio_transcribe_requested", {
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
    const result = await transcribeAudioFile(req.file);
    req.logStep("audio_transcribe_completed", {
      textLength: String(result?.text || "").length,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/questions/generate", async (req, res, next) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const types = Array.isArray(req.body?.types) ? req.body.types : [String(req.body?.questionType || "single")];
    const amount = Number(req.body?.amount || 5);

    if (!subjectId) return res.status(400).json({ error: "subjectId is required." });

    const result = await getOrGenerateQuestions({ visitorId: req.visitorId, subjectId, types, amount, logStep: req.logStep });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions", async (req, res, next) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const types = Array.isArray(req.body?.types) ? req.body.types : ["single"];
    const amount = Number(req.body?.amount || 5);
    const mode = String(req.body?.mode || "relaxed");

    if (!subjectId) return res.status(400).json({ error: "subjectId is required." });

    req.logStep("session_create_requested", { subjectId, types, amount, mode });
    const result = await getOrGenerateQuestions({ visitorId: req.visitorId, subjectId, types, amount, logStep: req.logStep });
    const session = createSessionPayload({ subjectId, mode, questions: result.questions });
    if (store.createPracticeSession) {
      await store.createPracticeSession({ visitorId: req.visitorId, session });
    }
    req.logStep("session_create_completed", {
      subjectId,
      sessionId: session.id,
      questionCount: session.questions.length,
    });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/retry", async (req, res, next) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const questionIds = Array.isArray(req.body?.questionIds) ? req.body.questionIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const mode = String(req.body?.mode || "strict");

    if (!subjectId) return res.status(400).json({ error: "subjectId is required." });
    if (!questionIds.length) return res.status(400).json({ error: "questionIds are required." });
    if (!store.getQuestionsByIds) return res.status(501).json({ error: "Retry sessions are not available." });

    const questions = await store.getQuestionsByIds({ visitorId: req.visitorId, subjectId, questionIds });
    if (!questions.length) return res.status(404).json({ error: "Retry questions not found." });

    const session = createSessionPayload({ subjectId, mode, questions });
    session.retryMistakeIds = questionIds;
    if (store.createPracticeSession) {
      await store.createPracticeSession({ visitorId: req.visitorId, session });
    }
    req.logStep("retry_session_created", {
      subjectId,
      sessionId: session.id,
      questionCount: questions.length,
    });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:sessionId", async (req, res, next) => {
  try {
    if (!store.getPracticeSession) return res.status(404).json({ error: "Session not found." });
    const session = await store.getPracticeSession({ visitorId: req.visitorId, sessionId: req.params.sessionId });
    if (!session) return res.status(404).json({ error: "Session not found." });
    req.logStep("session_loaded", { sessionId: req.params.sessionId, questionCount: session.questions?.length || 0 });
    res.json(session);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions/:sessionId/answers/:questionId", async (req, res, next) => {
  try {
    if (!store.deleteSessionAnswer) return res.status(404).json({ error: "Answer not found." });
    await store.deleteSessionAnswer({
      visitorId: req.visitorId,
      sessionId: req.params.sessionId,
      questionId: req.params.questionId,
    });
    req.logStep("session_answer_deleted", { sessionId: req.params.sessionId, questionId: req.params.questionId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/answers/grade", async (req, res, next) => {
  try {
    const startedAt = performance.now();
    const question = req.body?.question;
    const answer = String(req.body?.answer || "").trim();
    const mode = String(req.body?.mode || "relaxed");
    const sessionId = String(req.body?.sessionId || "").trim();

    if (!question?.id || !question?.type) return res.status(400).json({ error: "question is required." });
    if (!answer) return res.status(400).json({ error: "answer is required." });

    const result =
      question.type === "single"
        ? gradeSingleAnswer({ question, answer })
        : await gradeSubjectiveAnswer({ question, answer, mode });
    const gradedAt = performance.now();
    req.logStep("answer_graded", {
      sessionId: sessionId || null,
      questionId: question.id,
      questionType: question.type,
      mode,
      isCorrect: result.isCorrect,
      accuracy: result.accuracy ?? null,
    });

    let savedAnswer = null;
    if (sessionId && store.saveAnswer) {
      savedAnswer = await store.saveAnswer({
        visitorId: req.visitorId,
        sessionId,
        question,
        answer,
        result,
      });
    }
    const savedAt = performance.now();

    logInfo("grade_completed", {
      ...requestLogBase(req),
      sessionId: sessionId || null,
      questionId: question.id,
      questionType: question.type,
      gradeMs: Math.round(gradedAt - startedAt),
      saveMs: Math.round(savedAt - gradedAt),
      totalMs: Math.round(savedAt - startedAt),
    });

    res.json({ result, answerId: savedAnswer?.id || null, createdAt: savedAnswer?.createdAt || null });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:sessionId/finish", async (req, res, next) => {
  try {
    const summary = {
      total: Number(req.body?.total || 0),
      answeredCount: Number(req.body?.answeredCount || 0),
      skippedCount: Number(req.body?.skippedCount || 0),
      correctCount: Number(req.body?.correctCount || 0),
      rate: Number(req.body?.rate || 0),
      mistakeCount: Number(req.body?.mistakeCount || 0),
    };
    if (store.finishPracticeSession) {
      await store.finishPracticeSession({
        visitorId: req.visitorId,
        sessionId: req.params.sessionId,
        summary,
      });
    }
    req.logStep("session_finished", { sessionId: req.params.sessionId, summary });
    res.json({ summary });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mistakes", async (req, res, next) => {
  try {
    const subjectId = String(req.query?.subjectId || "").trim();
    if (!store.listMistakes) return res.json([]);
    const mistakes = await store.listMistakes({ visitorId: req.visitorId, subjectId });
    req.logStep("mistakes_listed", { subjectId: subjectId || null, mistakeCount: mistakes.length });
    res.json(mistakes);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/mistakes/:mistakeId", async (req, res, next) => {
  try {
    if (!store.deleteMistake) return res.status(404).json({ error: "Mistake not found." });
    const deleted = await store.deleteMistake({ visitorId: req.visitorId, mistakeId: req.params.mistakeId });
    if (!deleted) return res.status(404).json({ error: "Mistake not found." });
    req.logStep("mistake_deleted", { mistakeId: req.params.mistakeId });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/metrics", requireAdmin, async (req, res, next) => {
  try {
    if (!store.getAdminMetrics) return res.status(501).json({ error: "Metrics store is not available." });
    const metrics = await store.getAdminMetrics();
    req.logStep("admin_metrics_loaded", {
      totalUsers: metrics?.totals?.users ?? null,
      totalSubjects: metrics?.totals?.subjects ?? null,
      totalSessions: metrics?.totals?.sessions ?? null,
    });
    res.json(metrics);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/events", requireAdmin, async (req, res, next) => {
  try {
    const limit = Number(req.query?.limit || 50);
    if (!store.listAdminEvents) return res.json([]);
    const events = await store.listAdminEvents({ limit });
    req.logStep("admin_events_loaded", { limit, eventCount: events.length });
    res.json(events);
  } catch (error) {
    next(error);
  }
});

app.post("/api/analytics/events", async (req, res, next) => {
  try {
    const eventName = String(req.body?.eventName || "").trim();
    if (!eventName) return res.status(400).json({ error: "eventName is required." });
    if (store.saveAnalyticsEvent) {
      await store.saveAnalyticsEvent({
        visitorId: req.visitorId,
        eventName: eventName.slice(0, 80),
        sessionId: String(req.body?.sessionId || "").slice(0, 120),
        pagePath: String(req.body?.pagePath || "").slice(0, 300),
        properties: req.body?.properties && typeof req.body.properties === "object" ? req.body.properties : {},
        userAgent: req.get("user-agent"),
      });
    }
    req.logStep("analytics_event_saved", {
      eventName,
      sessionId: String(req.body?.sessionId || "").slice(0, 120),
      pagePath: String(req.body?.pagePath || "").slice(0, 300),
    });
    res.status(202).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const statusCode =
    error?.code === "LIMIT_FILE_SIZE" ? 413 : isTransientBackendError(error) ? 503 : error?.statusCode || error?.status || 500;
  logError("request_failed", {
    ...requestLogBase(req),
    statusCode,
    error,
  });
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `File is too large. Please upload a file smaller than ${uploadLimitMb} MB.`,
    });
  }
  if (isTransientBackendError(error)) {
    return res.status(503).json({
      error: "服务连接临时中断，请再试一次。",
    });
  }
  res.status(500).json({
    error: error.message || "Internal server error.",
  });
});

const port = Number(process.env.PORT || 8787);
const server = http.createServer(app);
setupQwenRealtimeAsr(server);

server.listen(port, () => {
  logInfo("server_started", { port, url: `http://localhost:${port}` });
});
