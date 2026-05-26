import { cosineSimilarity, embedTexts } from "./embeddings.js";

const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["accuracy", "isCorrect", "coveredPoints", "missedPoints", "extractedPoints", "advice", "evidenceQuote"],
  properties: {
    accuracy: { type: "integer", minimum: 0, maximum: 100 },
    isCorrect: { type: "boolean" },
    coveredPoints: { type: "array", items: { type: "string" } },
    missedPoints: { type: "array", items: { type: "string" } },
    extractedPoints: { type: "array", items: { type: "string" } },
    advice: { type: "string" },
    evidenceQuote: { type: "string" },
  },
};

const SYSTEM_PROMPT =
  "You are a strict but fair exam grader. Grade only against the given standard points and source text. Accept semantically equivalent answers, especially speech-to-text paraphrases, but do not reward vague, random, unrelated, or fabricated answers.";

const SOURCE_LOCATION = "\u539f\u6587\u51fa\u5904";
const DEFAULT_GRADE_TIMEOUT_MS = 15000;
const DEFAULT_GRADING_SOURCE_CHAR_LIMIT = 360;
const DEFAULT_GRADING_ANSWER_CHAR_LIMIT = 2500;
const DEFAULT_FAST_EMBEDDING_TIMEOUT_MS = 1000;

function getProvider() {
  if (process.env.DEEPSEEK_API_KEY || process.env.AI_PROVIDER === "deepseek") return "deepseek";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

function normalizeBaseUrl(value) {
  return String(value || "https://api.deepseek.com").replace(/\/+$/, "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON.");
    return JSON.parse(match[0]);
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactText(value) {
  return normalizeText(value).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").toLowerCase();
}

function titleStem(title) {
  return normalizeText(title)
    .replace(/^(?:\u8bf7)?(?:\u7b80\u8ff0|\u8bd5\u8ff0|\u8bba\u8ff0|\u5206\u6790|\u6982\u62ec|\u8bf4\u660e|\u8c08\u8c08)/, "")
    .replace(/(?:\u662f\u4ec0\u4e48|\u6709\u54ea\u4e9b|\u8868\u73b0\u5728\u54ea\u4e9b\u65b9\u9762|\u4f53\u73b0\u5728\u54ea\u4e9b\u65b9\u9762)[\u3002\uff1f?]?$/, "")
    .trim();
}

function isMetaPoint(point, questionTitle) {
  const text = normalizeText(point);
  const compactPoint = compactText(text);
  const compactTitle = compactText(titleStem(questionTitle));
  if (!text || text.length < 4) return true;
  if (/[\uff08(]?(?:\u7b80\u7b54\u9898|\u8bba\u8ff0\u9898|\u540d\u8bcd\u89e3\u91ca|\u9009\u62e9\u9898|\u586b\u7a7a\u9898)[\uff09)]?/.test(text)) return true;
  if (/(?:\u7b54\u9898\u65b9\u5411|\u51fa\u9898\u6a21\u5f0f|\u590d\u4e60\u65b9\u5411)/.test(text)) return true;
  if (/(?:\u4f53\u73b0\u5728|\u5305\u62ec|\u5206\u4e3a).{2,40}(?:\u65b9\u9762|\u7c7b|\u70b9)$/.test(text)) return true;
  if (compactTitle.length >= 6 && compactPoint.includes(compactTitle)) return true;
  return false;
}

function limitText(value, maxLength) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function standardPointsOf(question) {
  const keyPoints = Array.isArray(question.keyPoints)
    ? question.keyPoints.map(normalizeText).filter((point) => point && !isMetaPoint(point, question.title))
    : [];
  if (keyPoints.length) return keyPoints;

  return normalizeText(question.explanation || question.evidenceQuote || question.sourceText)
    .split(/[。！？；.!?;]\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8 && !isMetaPoint(item, question.title))
    .slice(0, 6);
}

function charBigrams(text) {
  const chars = String(text || "").replace(/\s+/g, "");
  if (chars.length < 2) return new Set();
  const bigrams = new Set();
  for (let i = 0; i <= chars.length - 2; i += 1) {
    bigrams.add(chars.slice(i, i + 2));
  }
  return bigrams;
}

function bigramOverlap(text, reference) {
  const textBigrams = charBigrams(text);
  const refBigrams = charBigrams(reference);
  if (refBigrams.size === 0) return 0;
  let intersection = 0;
  for (const bigram of textBigrams) {
    if (refBigrams.has(bigram)) intersection += 1;
  }
  return intersection / refBigrams.size;
}

function alignToStandardPoints(points, keyPoints) {
  const aligned = [];
  for (const rawPoint of points || []) {
    const point = normalizeText(rawPoint);
    if (!point) continue;
    const matched = keyPoints.find((keyPoint) => {
      const normalizedKeyPoint = normalizeText(keyPoint);
      return normalizedKeyPoint === point || normalizedKeyPoint.includes(point) || point.includes(normalizedKeyPoint) || bigramOverlap(point, normalizedKeyPoint) >= 0.55;
    });
    if (matched && !aligned.includes(matched)) aligned.push(matched);
  }
  return aligned;
}

function canUseSemanticEmbeddings() {
  const provider = String(process.env.EMBEDDING_PROVIDER || "local").toLowerCase();
  if ((provider === "qwen" || provider === "dashscope") && (process.env.DASHSCOPE_API_KEY || process.env.QWEN_EMBEDDING_API_KEY)) return true;
  if (provider === "openai" && process.env.OPENAI_API_KEY) return true;
  return false;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function buildGradeResult({ question, answer, keyPoints, coveredPoints, missedPoints, accuracy, advice, extra = {} }) {
  const normalizedAnswer = normalizeText(answer);
  return {
    accuracy,
    isCorrect: accuracy >= 70 && missedPoints.length <= Math.max(0, Math.floor(keyPoints.length * 0.3)),
    coveredPoints,
    missedPoints,
    extractedPoints: normalizedAnswer.length > 100 ? [`${normalizedAnswer.slice(0, 100)}...`] : [normalizedAnswer],
    advice,
    evidenceQuote: normalizeText(question.evidenceQuote || question.sourceText).slice(0, 220),
    sourceText: question.sourceText || question.evidenceQuote || "",
    sourceLocation: SOURCE_LOCATION,
    ...extra,
  };
}

async function semanticFastGrade({ question, answer, mode, timeoutMs = DEFAULT_FAST_EMBEDDING_TIMEOUT_MS }) {
  const userAnswer = normalizeText(answer);
  const keyPoints = standardPointsOf(question);
  if (!keyPoints.length || userAnswer.length < 8) return null;
  if (!canUseSemanticEmbeddings()) return null;

  const fallbackCovered = [];
  const fallbackMissed = [];
  for (const point of keyPoints) {
    const overlap = bigramOverlap(userAnswer, point);
    if (overlap >= (mode === "strict" ? 0.35 : 0.25)) fallbackCovered.push(point);
    else fallbackMissed.push(point);
  }

  let vectors;
  try {
    vectors = await withTimeout(embedTexts([userAnswer, ...keyPoints]), timeoutMs, "Fast grading embeddings timed out.");
  } catch {
    return null;
  }

  const answerVector = vectors[0];
  const pointVectors = vectors.slice(1);
  const high = mode === "strict" ? 0.62 : 0.58;
  const low = mode === "strict" ? 0.48 : 0.44;
  const coveredPoints = [];
  const missedPoints = [];
  const uncertainPoints = [];

  keyPoints.forEach((point, index) => {
    const semanticScore = cosineSimilarity(answerVector, pointVectors[index] || []);
    const lexicalScore = bigramOverlap(userAnswer, point);
    if (semanticScore >= high || lexicalScore >= (mode === "strict" ? 0.35 : 0.25)) {
      coveredPoints.push(point);
    } else if (semanticScore <= low && lexicalScore < 0.18) {
      missedPoints.push(point);
    } else {
      uncertainPoints.push(point);
    }
  });

  const finalCovered = coveredPoints.length ? coveredPoints : fallbackCovered;
  const finalMissed = [...missedPoints, ...uncertainPoints.filter((point) => !finalCovered.includes(point))];
  const ratio = keyPoints.length ? finalCovered.length / keyPoints.length : 0;
  const strictPenalty = mode === "strict" ? 8 : 0;
  const accuracy = Math.max(0, Math.min(100, Math.round(ratio * 100 - strictPenalty)));
  const needsModelReview = uncertainPoints.length > Math.max(1, Math.floor(keyPoints.length / 3));

  return buildGradeResult({
    question,
    answer,
    keyPoints,
    coveredPoints: finalCovered,
    missedPoints: finalMissed,
    accuracy,
    advice:
      accuracy >= 70
        ? "\u4e3b\u8981\u8981\u70b9\u5df2\u7ecf\u8986\u76d6\uff0c\u53ef\u4ee5\u5bf9\u7167\u539f\u6587\u8865\u5145\u8868\u8ff0\u5c42\u6b21\u3002"
        : "\u5f53\u524d\u7b54\u6848\u8986\u76d6\u8981\u70b9\u4e0d\u8db3\uff0c\u8bf7\u6309\u9057\u6f0f\u8981\u70b9\u9010\u6761\u8865\u5145\u3002",
    extra: {
      gradingMethod: "semantic-fast",
      needsModelReview,
    },
  });
}

function fallbackGrade({ question, answer, mode }) {
  const userAnswer = normalizeText(answer);
  const keyPoints = standardPointsOf(question);

  if (userAnswer.length < 8) {
    return {
      accuracy: 0,
      isCorrect: false,
      coveredPoints: [],
      missedPoints: keyPoints,
      extractedPoints: userAnswer ? [userAnswer] : [],
      advice: "\u56de\u7b54\u8fc7\u77ed\u6216\u4e0e\u9898\u76ee\u65e0\u5173\uff0c\u5efa\u8bae\u56de\u5230\u539f\u6587\uff0c\u6309\u8981\u70b9\u9010\u6761\u4f5c\u7b54\u3002",
      evidenceQuote: normalizeText(question.evidenceQuote || question.sourceText).slice(0, 220),
      sourceText: question.sourceText,
      sourceLocation: SOURCE_LOCATION,
    };
  }

  const coveredPoints = [];
  const missedPoints = [];

  for (const point of keyPoints) {
    const overlap = bigramOverlap(userAnswer, point);
    const threshold = mode === "strict" ? 0.35 : 0.25;
    if (overlap >= threshold) coveredPoints.push(point);
    else missedPoints.push(point);
  }

  const ratio = keyPoints.length ? coveredPoints.length / keyPoints.length : 0;
  const strictPenalty = mode === "strict" ? 8 : 0;
  const accuracy = Math.max(0, Math.min(100, Math.round(ratio * 100 - strictPenalty)));

  return {
    accuracy,
    isCorrect: accuracy >= 70 && missedPoints.length <= Math.max(0, Math.floor(keyPoints.length * 0.3)),
    coveredPoints,
    missedPoints,
    extractedPoints: userAnswer.length > 100 ? [`${userAnswer.slice(0, 100)}...`] : [userAnswer],
    advice:
      accuracy >= 70
        ? "\u4e3b\u8981\u8981\u70b9\u5df2\u7ecf\u8986\u76d6\uff0c\u4f46\u4ecd\u5efa\u8bae\u5bf9\u7167\u539f\u6587\u8865\u5145\u8868\u8ff0\u5c42\u6b21\u3002"
        : "\u5f53\u524d\u7b54\u6848\u8986\u76d6\u8981\u70b9\u4e0d\u8db3\uff0c\u8bf7\u6309\u9057\u6f0f\u8981\u70b9\u9010\u6761\u8865\u5145\uff0c\u907f\u514d\u6cdb\u6cdb\u800c\u8c08\u3002",
    evidenceQuote: normalizeText(question.evidenceQuote || question.sourceText).slice(0, 220),
    sourceText: question.sourceText,
    sourceLocation: SOURCE_LOCATION,
  };
}

function buildPrompt({ question, answer, mode }) {
  const sourceLimit = Math.max(300, Number(process.env.GRADING_SOURCE_CHAR_LIMIT || DEFAULT_GRADING_SOURCE_CHAR_LIMIT));
  const answerLimit = Math.max(300, Number(process.env.GRADING_ANSWER_CHAR_LIMIT || DEFAULT_GRADING_ANSWER_CHAR_LIMIT));
  const evidenceQuote = limitText(question.evidenceQuote || question.sourceText || "", sourceLimit);
  const explanation = limitText(question.explanation || "", 360);
  const sourceText = limitText(question.sourceText || evidenceQuote, sourceLimit);
  const studentAnswer = limitText(answer, answerLimit);

  return [
    "Grade this subjective exam answer in Chinese.",
    "Rules:",
    "- Use ONLY the standard key points and source text.",
    "- A random, empty, copied-unrelated, or off-topic answer must receive 0-20.",
    "- Accept semantic equivalence: if the student's speech-to-text answer paraphrases a key point with similar meaning, count that key point as covered.",
    "- Do not require exact wording. Synonyms, reordered clauses, spoken-language expressions, and minor speech-recognition wording differences can count if the meaning is clearly the same.",
    "- Do not count a key point as covered when the answer only contains a loose keyword but misses the actual meaning.",
    "- accuracy >= 70 only if most necessary key points are substantively covered.",
    "- Split coveredPoints and missedPoints according to the given standard keyPoints. Do not invent new standard points.",
    "- coveredPoints and missedPoints must be copied or paraphrased only from Standard keyPoints, never from neighboring source sections or other questions.",
    "- Keep the judgment fast. The keyPoints are the grading standard; source excerpt is only supporting evidence.",
    "- evidenceQuote must be short and come from the provided evidence/source if possible.",
    "- advice must be short Chinese feedback.",
    "- Return JSON only.",
    `Mode: ${mode || "relaxed"}`,
    `Question type: ${question.type}`,
    `Question: ${question.title}`,
    "Standard keyPoints:",
    JSON.stringify(standardPointsOf(question), null, 2),
    `Reference explanation: ${explanation}`,
    `Evidence/source excerpt: ${evidenceQuote || sourceText}`,
    `Student answer: ${studentAnswer}`,
    "JSON schema:",
    JSON.stringify(GRADE_SCHEMA, null, 2),
  ].join("\n");
}

async function callDeepSeek(prompt, { signal } = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required to grade answers.");

  const response = await fetch(`${normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL)}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: Math.min(700, Number(process.env.DEEPSEEK_GRADE_MAX_TOKENS || 700)),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek grading failed: ${response.status} ${detail}`);
  }

  return response.json();
}

async function callOpenAi(prompt, { signal } = {}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: SYSTEM_PROMPT,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "answer_grading",
          strict: true,
          schema: GRADE_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI grading failed: ${response.status} ${detail}`);
  }

  return response.json();
}

function extractOpenAiOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

function extractDeepSeekOutputText(payload) {
  return payload.choices?.[0]?.message?.content || "";
}

function normalizeGrade(grade, question) {
  const keyPoints = standardPointsOf(question);
  const covered = alignToStandardPoints(grade.coveredPoints, keyPoints);
  const missed = alignToStandardPoints(grade.missedPoints, keyPoints).filter((point) => !covered.includes(point));
  const accuracy = Math.max(0, Math.min(100, Math.round(Number(grade.accuracy) || 0)));

  return {
    accuracy,
    isCorrect: Boolean(grade.isCorrect) && accuracy >= 70,
    coveredPoints: covered,
    missedPoints: missed.length ? missed : keyPoints.filter((point) => !covered.includes(point)),
    extractedPoints: Array.isArray(grade.extractedPoints) ? grade.extractedPoints.map(normalizeText).filter(Boolean).slice(0, 8) : [],
    advice: normalizeText(grade.advice) || "\u8bf7\u5bf9\u7167\u539f\u6587\u8981\u70b9\u8865\u5145\u7b54\u6848\u3002",
    evidenceQuote: normalizeText(question.evidenceQuote || question.sourceText).slice(0, 260),
    sourceText: question.sourceText,
    sourceLocation: SOURCE_LOCATION,
  };
}

function reconcileGradeWithFallback(modelGrade, fallback) {
  const modelCovered = Array.isArray(modelGrade.coveredPoints) ? modelGrade.coveredPoints.length : 0;
  const modelMissed = Array.isArray(modelGrade.missedPoints) ? modelGrade.missedPoints.length : 0;
  const fallbackCovered = Array.isArray(fallback.coveredPoints) ? fallback.coveredPoints.length : 0;
  const totalPoints = modelCovered + modelMissed || fallbackCovered + (Array.isArray(fallback.missedPoints) ? fallback.missedPoints.length : 0) || 1;
  const fallbackCoverage = fallbackCovered / totalPoints;

  const modelLooksEmpty = modelCovered === 0 && modelMissed > 0;
  const fallbackStronglyConfident = fallback.accuracy >= 75 && fallbackCoverage >= 0.5;

  if (!modelLooksEmpty || !fallbackStronglyConfident) return modelGrade;

  return {
    ...modelGrade,
    accuracy: Math.max(modelGrade.accuracy, fallback.accuracy),
    isCorrect: fallback.isCorrect,
    coveredPoints: fallback.coveredPoints,
    missedPoints: fallback.missedPoints,
    extractedPoints: modelGrade.extractedPoints?.length ? modelGrade.extractedPoints : fallback.extractedPoints,
    advice: "你的回答已经覆盖主要要点，系统已按标准要点进行语义兜底校正。建议再对照原文补充表述层次。",
  };
}

export function gradeSingleAnswer({ question, answer }) {
  const isCorrect = String(answer || "").trim() === String(question.correctAnswer || "").trim();
  return {
    isCorrect,
    accuracy: isCorrect ? 100 : 0,
    coveredPoints: isCorrect ? ["\u5df2\u9009\u62e9\u6b63\u786e\u9009\u9879"] : [],
    missedPoints: isCorrect ? [] : [`\u6b63\u786e\u9009\u9879\u4e3a ${question.correctAnswer}`],
    extractedPoints: [answer ? `\u4f60\u7684\u9009\u62e9\uff1a${answer}` : "\u672a\u9009\u62e9"],
    advice: isCorrect ? "\u5224\u65ad\u6b63\u786e\uff0c\u53ef\u4ee5\u8fdb\u5165\u4e0b\u4e00\u9898\u3002" : "\u8fd9\u9898\u5df2\u7ecf\u52a0\u5165\u9519\u9898\u672c\uff0c\u5efa\u8bae\u67e5\u770b\u539f\u6587\u540e\u91cd\u505a\u3002",
    evidenceQuote: normalizeText(question.evidenceQuote || question.sourceText).slice(0, 220),
    sourceText: question.sourceText,
    sourceLocation: SOURCE_LOCATION,
  };
}

export async function gradeSubjectiveAnswer({ question, answer, mode }) {
  const startedAt = performance.now();
  const fallback = fallbackGrade({ question, answer, mode });
  const timeoutMs = Math.min(DEFAULT_GRADE_TIMEOUT_MS, Math.max(1000, Number(process.env.AI_GRADE_TIMEOUT_MS || DEFAULT_GRADE_TIMEOUT_MS)));
  const fastTimeoutMs = Math.min(DEFAULT_FAST_EMBEDDING_TIMEOUT_MS, Math.max(300, Math.floor(timeoutMs / 3)));
  const fastGrade = await semanticFastGrade({ question, answer, mode, timeoutMs: fastTimeoutMs }).catch(() => null);

  if (getProvider() === "none") return fastGrade || fallback;
  if (fastGrade && !fastGrade.needsModelReview) return fastGrade;

  const elapsed = performance.now() - startedAt;
  const remainingMs = Math.max(0, timeoutMs - elapsed);
  if (fastGrade && remainingMs < 800) return fastGrade;
  if (!fastGrade && remainingMs < 800) return fallback;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const prompt = buildPrompt({ question, answer, mode });
    const provider = getProvider();
    const payload = provider === "deepseek" ? await callDeepSeek(prompt, { signal: controller.signal }) : await callOpenAi(prompt, { signal: controller.signal });
    const text = provider === "deepseek" ? extractDeepSeekOutputText(payload) : extractOpenAiOutputText(payload);
    return reconcileGradeWithFallback(normalizeGrade(parseJson(text), question), fastGrade || fallback);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.warn(timedOut ? `AI grading timed out after ${Math.round(remainingMs)}ms; using fast fallback.` : "AI grading failed; using fast fallback.", error.message);
    const quick = fastGrade || fallback;
    return {
      ...quick,
      advice: quick.advice,
      gradingFallback: true,
      gradingTimedOut: timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }

  /* legacy slow path disabled
  const fallback = fallbackGrade({ question, answer, mode });
  if (getProvider() === "none") return fallback;

  const timeoutMs = Math.max(1000, Number(process.env.AI_GRADE_TIMEOUT_MS || DEFAULT_GRADE_TIMEOUT_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = buildPrompt({ question, answer, mode });
    const provider = getProvider();
    const payload = provider === "deepseek" ? await callDeepSeek(prompt, { signal: controller.signal }) : await callOpenAi(prompt, { signal: controller.signal });
    const text = provider === "deepseek" ? extractDeepSeekOutputText(payload) : extractOpenAiOutputText(payload);
    return reconcileGradeWithFallback(normalizeGrade(parseJson(text), question), fallback);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.warn(timedOut ? `AI grading timed out after ${timeoutMs}ms; using local fallback.` : "AI grading failed; using strict local fallback.", error.message);
    return {
      ...fallback,
      advice: `${fallback.advice}${timedOut ? "（AI 批改响应较慢，本次先用快速评分给出结果。）" : ""}`,
      gradingFallback: true,
      gradingTimedOut: timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
  */
}
