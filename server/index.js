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
const store = process.env.DATABASE_URL ? await createDbStore(process.env.DATABASE_URL) : createMemoryStore();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

async function getPracticeSources({ subjectId, amount, types }) {
  const cursorKey = `${subjectId}:${types.join(",")}`;
  const cursor = practiceCursor.get(cursorKey) || 0;
  const poolSize = Math.max(120, amount * 20);
  const chunkPool = store.listChunks
    ? await store.listChunks({ subjectId, limit: poolSize })
    : await store.searchChunks({ subjectId, queryEmbedding: (await embedTexts([QUESTION_QUERY]))[0], limit: poolSize });

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

async function getOrGenerateQuestions({ subjectId, types, amount }) {
  const safeAmount = Math.min(50, Math.max(1, Number(amount) || 5));
  const requestedTypes = Array.isArray(types) && types.length ? types : ["single"];
  const sources = await getPracticeSources({ subjectId, amount: safeAmount, types: requestedTypes });
  const documentHashes = store.getDocumentHashesForSubject ? await store.getDocumentHashesForSubject({ subjectId }) : [];
  const priorQuestions = store.getPriorQuestionsByDocumentHashes
    ? await store.getPriorQuestionsByDocumentHashes({ documentHashes, types: requestedTypes, limit: 500 })
    : [];
  const currentSubjectQuestions = store.getRecentQuestions
    ? await store.getRecentQuestions({ subjectId, types: requestedTypes, limit: 500 })
    : [];
  const questions = await generateQuestionsFromSources({
    sources,
    types: requestedTypes,
    amount: safeAmount,
    excludedQuestions: [...priorQuestions, ...currentSubjectQuestions],
  });
  const savedQuestions = await store.saveQuestions({ subjectId, questions, documentHash: documentHashes[0] || null });

  return {
    questions: savedQuestions,
    sourceChunkCount: sources.length,
    cached: false,
  };
}

app.get("/api/health", async (req, res, next) => {
  try {
    if (store.health) await store.health();
    res.json({
      ok: true,
      service: "qimoshua-rag-api",
      mode: process.env.DATABASE_URL ? "database" : "memory",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/subjects", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Subject name is required." });

    const subject = await store.createSubject({ name });
    res.status(201).json(subject);
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects", async (req, res, next) => {
  try {
    res.json(await store.listSubjects());
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects/:subjectId", async (req, res, next) => {
  try {
    const subject = await store.getSubject(req.params.subjectId);
    if (!subject) return res.status(404).json({ error: "Subject not found." });
    res.json(subject);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/subjects/:subjectId", async (req, res, next) => {
  try {
    const deleted = await store.deleteSubject(req.params.subjectId);
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
      subjectId,
      fileName: repairMojibake(req.file.originalname),
      mimeType: req.file.mimetype,
      size: req.file.size,
      textLength: text.length,
      contentHash,
    });

    const savedChunks = await store.addChunks(
      chunks.map((chunk, index) => ({
        ...chunk,
        subjectId,
        documentId: document.id,
        embedding: embeddings[index],
      })),
    );
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
    const matches = await store.searchChunks({ subjectId, queryEmbedding, limit });

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

    const result = await getOrGenerateQuestions({ subjectId, types, amount });
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

    const result = await getOrGenerateQuestions({ subjectId, types, amount });
    res.status(201).json(createSessionPayload({ subjectId, mode, questions: result.questions }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/answers/grade", async (req, res, next) => {
  try {
    const question = req.body?.question;
    const answer = String(req.body?.answer || "").trim();
    const mode = String(req.body?.mode || "relaxed");

    if (!question?.id || !question?.type) return res.status(400).json({ error: "question is required." });
    if (!answer) return res.status(400).json({ error: "answer is required." });

    const result =
      question.type === "single"
        ? gradeSingleAnswer({ question, answer })
        : await gradeSubjectiveAnswer({ question, answer, mode });

    res.json({ result });
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
