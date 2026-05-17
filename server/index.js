import cors from "cors";
import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import multer from "multer";
import { chunkText } from "./services/chunker.js";
import { embedTexts } from "./services/embeddings.js";
import { extractTextFromFile } from "./services/extractText.js";
import { createDbStore } from "./services/dbStore.js";
import { createMemoryStore } from "./services/memoryStore.js";
import { gradeSingleAnswer, gradeSubjectiveAnswer } from "./services/aiGrader.js";
import { generateQuestionsFromSources } from "./services/aiQuestions.js";
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

const app = express();
const uploadLimitMb = Number(process.env.UPLOAD_MAX_MB || 80);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadLimitMb * 1024 * 1024 },
});
const useMemoryStore = process.env.USE_MEMORY_STORE === "1";
const store = !useMemoryStore && process.env.DATABASE_URL ? await createDbStore(process.env.DATABASE_URL) : createMemoryStore();

function createCorsOptions() {
  const configuredOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins.length === 0 || configuredOrigins.includes("*")) {
    return {
      origin: true,
      credentials: true,
    };
  }

  const allowedOrigins = new Set(configuredOrigins);
  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
  };
}

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: "2mb" }));

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
  const sameSite = String(process.env.AUTH_COOKIE_SAMESITE || "lax").toLowerCase();
  return {
    httpOnly: true,
    sameSite,
    secure: sameSite === "none" || process.env.NODE_ENV === "production",
    maxAge,
    path: "/",
  };
}

async function createLoginSession(req, res, user) {
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

async function resolveAuth(req, res, next) {
  try {
    const token = parseCookies(req.get("cookie"))[SESSION_COOKIE_NAME];
    if (token) {
      const session = await store.getAuthSession(hashSessionToken(token));
      if (session) {
        req.user = publicUser(session);
        req.visitorId = req.user.id;
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

function normalizeForHash(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function createContentHash(text) {
  return crypto.createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex");
}

function rankSourcesForPractice(sources) {
  const withRank = sources.map((source, index) => {
    const text = source.text || "";
    const hasKeyPoint = KEY_POINT_PATTERN.test(text);
    KEY_POINT_PATTERN.lastIndex = 0;
    const hasExistingQuestion = EXISTING_QUESTION_PATTERN.test(text);
    EXISTING_QUESTION_PATTERN.lastIndex = 0;
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
  const matched = TERM_QUESTION_PATTERN.test(text || "");
  TERM_QUESTION_PATTERN.lastIndex = 0;
  return matched;
}

function hasImplicitTermDefinition(text) {
  return TERM_DEFINITION_PATTERNS.some((pattern) => pattern.test(text || ""));
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
    : await store.searchChunks({ visitorId, subjectId, queryEmbedding: (await embedTexts([QUESTION_QUERY]))[0], limit: poolSize });

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

async function getOrGenerateQuestions({ visitorId, subjectId, types, amount }) {
  const startedAt = performance.now();
  const safeAmount = Math.min(50, Math.max(1, Number(amount) || 5));
  const requestedTypes = Array.isArray(types) && types.length ? types : ["single"];
  const sources = await getPracticeSources({ visitorId, subjectId, amount: safeAmount, types: requestedTypes });
  const retrievedAt = performance.now();
  const documentHashes = store.getDocumentHashesForSubject ? await store.getDocumentHashesForSubject({ visitorId, subjectId }) : [];
  const priorQuestions = store.getPriorQuestionsByDocumentHashes
    ? await store.getPriorQuestionsByDocumentHashes({ visitorId, documentHashes, types: requestedTypes, limit: 500 })
    : [];
  const currentSubjectQuestions = store.getRecentQuestions
    ? await store.getRecentQuestions({ visitorId, subjectId, types: requestedTypes, limit: 500 })
    : [];
  const historyLoadedAt = performance.now();
  const questions = await generateQuestionsFromSources({
    sources,
    types: requestedTypes,
    amount: safeAmount,
    excludedQuestions: [...priorQuestions, ...currentSubjectQuestions],
  });
  const generatedAt = performance.now();
  const savedQuestions = await store.saveQuestions({ visitorId, subjectId, questions, documentHash: documentHashes[0] || null });
  const savedAt = performance.now();
  const timings = {
    retrievalMs: Math.round(retrievedAt - startedAt),
    historyMs: Math.round(historyLoadedAt - retrievedAt),
    generationMs: Math.round(generatedAt - historyLoadedAt),
    saveMs: Math.round(savedAt - generatedAt),
    totalMs: Math.round(savedAt - startedAt),
  };

  console.log(
    `[questions] subject=${subjectId} amount=${safeAmount} types=${requestedTypes.join(",")} sources=${sources.length} ` +
      `retrieval=${timings.retrievalMs}ms history=${timings.historyMs}ms generation=${timings.generationMs}ms save=${timings.saveMs}ms total=${timings.totalMs}ms`,
  );

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
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const nickname = String(req.body?.nickname || "").trim();

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
    const user = await store.getUserByEmail(email);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "邮箱或密码不正确。" });
    }

    await createLoginSession(req, res, user);
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
    res.status(201).json(subject);
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects", async (req, res, next) => {
  try {
    res.json(await store.listSubjects({ visitorId: req.visitorId }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects/:subjectId", async (req, res, next) => {
  try {
    const subject = await store.getSubject({ visitorId: req.visitorId, subjectId: req.params.subjectId });
    if (!subject) return res.status(404).json({ error: "Subject not found." });
    res.json(subject);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/subjects/:subjectId", async (req, res, next) => {
  try {
    const deleted = await store.deleteSubject({ visitorId: req.visitorId, subjectId: req.params.subjectId });
    if (!deleted) return res.status(404).json({ error: "Subject not found." });
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

    const text = await extractTextFromFile(req.file);
    const extractedAt = performance.now();
    const contentHash = createContentHash(text);
    const chunks = chunkText(text, { chunkSize: Number(process.env.DOC_CHUNK_SIZE || 800) });
    const chunkedAt = performance.now();
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
    const embeddedAt = performance.now();

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
    const timings = {
      extractMs: Math.round(extractedAt - startedAt),
      chunkMs: Math.round(chunkedAt - extractedAt),
      embeddingMs: Math.round(embeddedAt - chunkedAt),
      saveMs: Math.round(savedAt - embeddedAt),
      totalMs: Math.round(savedAt - startedAt),
    };

    console.log(
      `[upload] file="${repairMojibake(req.file.originalname)}" chars=${text.length} chunks=${chunks.length} ` +
        `extract=${timings.extractMs}ms chunk=${timings.chunkMs}ms embedding=${timings.embeddingMs}ms save=${timings.saveMs}ms total=${timings.totalMs}ms`,
    );

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

    const [queryEmbedding] = await embedTexts([query]);
    const matches = await store.searchChunks({ visitorId: req.visitorId, subjectId, queryEmbedding, limit });

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
    res.json(await transcribeAudioFile(req.file));
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

    const result = await getOrGenerateQuestions({ visitorId: req.visitorId, subjectId, types, amount });
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

    const result = await getOrGenerateQuestions({ visitorId: req.visitorId, subjectId, types, amount });
    const session = createSessionPayload({ subjectId, mode, questions: result.questions });
    if (store.createPracticeSession) {
      await store.createPracticeSession({ visitorId: req.visitorId, session });
    }
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
    res.json(session);
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

    console.log(
      `[grade] session=${sessionId || "none"} question=${question.id} type=${question.type} ` +
        `grade=${Math.round(gradedAt - startedAt)}ms save=${Math.round(savedAt - gradedAt)}ms total=${Math.round(savedAt - startedAt)}ms`,
    );

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
    res.json({ summary });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mistakes", async (req, res, next) => {
  try {
    const subjectId = String(req.query?.subjectId || "").trim();
    if (!store.listMistakes) return res.json([]);
    res.json(await store.listMistakes({ visitorId: req.visitorId, subjectId }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/metrics", requireAdmin, async (req, res, next) => {
  try {
    if (!store.getAdminMetrics) return res.status(501).json({ error: "Metrics store is not available." });
    res.json(await store.getAdminMetrics());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/events", requireAdmin, async (req, res, next) => {
  try {
    const limit = Number(req.query?.limit || 50);
    if (!store.listAdminEvents) return res.json([]);
    res.json(await store.listAdminEvents({ limit }));
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
    res.status(202).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `File is too large. Please upload a file smaller than ${uploadLimitMb} MB.`,
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
  console.log(`RAG API listening on http://localhost:${port}`);
});
