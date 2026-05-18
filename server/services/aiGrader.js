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
const DEFAULT_GRADE_TIMEOUT_MS = 20000;
const DEFAULT_GRADING_SOURCE_CHAR_LIMIT = 1200;
const DEFAULT_GRADING_ANSWER_CHAR_LIMIT = 2500;

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

function limitText(value, maxLength) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function standardPointsOf(question) {
  const keyPoints = Array.isArray(question.keyPoints) ? question.keyPoints.map(normalizeText).filter(Boolean) : [];
  if (keyPoints.length) return keyPoints;

  return normalizeText(question.explanation || question.evidenceQuote || question.sourceText)
    .split(/[。！？；.!?;]\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8)
    .slice(0, 6);
}

function termsOf(text) {
  const normalized = normalizeText(text);
  const chinese = normalized.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  const english = normalized.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set([...chinese, ...english])].filter((item) => item.length >= 2);
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
    const terms = termsOf(point).filter((term) => term.length >= 2);
    const hits = terms.filter((term) => userAnswer.includes(term));
    const needed = Math.max(1, Math.ceil(Math.min(terms.length, 4) * 0.5));
    if (hits.length >= needed) coveredPoints.push(point);
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
    extractedPoints: termsOf(userAnswer).slice(0, 6),
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
  const evidenceQuote = limitText(question.evidenceQuote || "", 320);
  const explanation = limitText(question.explanation || "", 700);
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
    "- evidenceQuote must start from the beginning of a complete sentence and end at a sentence boundary. Do not start with a half sentence.",
    "- advice must be short Chinese feedback.",
    "- Return JSON only.",
    `Mode: ${mode || "relaxed"}`,
    `Question type: ${question.type}`,
    `Question: ${question.title}`,
    "Standard keyPoints:",
    JSON.stringify(standardPointsOf(question), null, 2),
    `Reference explanation: ${explanation}`,
    `Evidence quote: ${evidenceQuote}`,
    `Source text excerpt: ${sourceText}`,
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
      max_tokens: Number(process.env.DEEPSEEK_GRADE_MAX_TOKENS || 900),
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
  const covered = Array.isArray(grade.coveredPoints) ? grade.coveredPoints.map(normalizeText).filter(Boolean) : [];
  const missed = Array.isArray(grade.missedPoints) ? grade.missedPoints.map(normalizeText).filter(Boolean) : [];
  const accuracy = Math.max(0, Math.min(100, Math.round(Number(grade.accuracy) || 0)));

  return {
    accuracy,
    isCorrect: Boolean(grade.isCorrect) && accuracy >= 70,
    coveredPoints: covered,
    missedPoints: missed.length ? missed : keyPoints.filter((point) => !covered.includes(point)),
    extractedPoints: Array.isArray(grade.extractedPoints) ? grade.extractedPoints.map(normalizeText).filter(Boolean).slice(0, 8) : [],
    advice: normalizeText(grade.advice) || "\u8bf7\u5bf9\u7167\u539f\u6587\u8981\u70b9\u8865\u5145\u7b54\u6848\u3002",
    evidenceQuote: normalizeText(grade.evidenceQuote || question.evidenceQuote).slice(0, 260),
    sourceText: question.sourceText,
    sourceLocation: SOURCE_LOCATION,
  };
}

function reconcileGradeWithFallback(modelGrade, fallback) {
  const modelCovered = Array.isArray(modelGrade.coveredPoints) ? modelGrade.coveredPoints.length : 0;
  const modelMissed = Array.isArray(modelGrade.missedPoints) ? modelGrade.missedPoints.length : 0;
  const fallbackCovered = Array.isArray(fallback.coveredPoints) ? fallback.coveredPoints.length : 0;

  const modelLooksEmpty = modelCovered === 0 && modelMissed > 0;
  const fallbackLooksConfident = fallback.accuracy >= 70 && fallbackCovered > 0;

  if (!modelLooksEmpty || !fallbackLooksConfident) return modelGrade;

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
}
