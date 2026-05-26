const QUESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "options", "correctAnswer", "keyPoints", "explanation", "evidenceQuote", "sourceChunkIndexes"],
        properties: {
          type: { type: "string", enum: ["single", "term", "short", "essay"] },
          title: { type: "string" },
          options: {
            anyOf: [
              {
                type: "array",
                minItems: 4,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "text"],
                  properties: {
                    label: { type: "string", enum: ["A", "B", "C", "D"] },
                    text: { type: "string" },
                  },
                },
              },
              { type: "null" },
            ],
          },
          correctAnswer: { anyOf: [{ type: "string" }, { type: "null" }] },
          keyPoints: { type: "array", items: { type: "string" } },
          explanation: { type: "string" },
          evidenceQuote: { type: "string" },
          sourceChunkIndexes: { type: "array", items: { type: "integer", minimum: 0 } },
        },
      },
    },
  },
};

const QUESTION_ITEM_SCHEMA = QUESTION_SCHEMA.properties.questions.items;

const SYSTEM_PROMPT =
  "\u4f60\u662f\u9762\u5411\u671f\u672b\u590d\u4e60\u7684\u51fa\u9898\u8001\u5e08\uff0c\u5fc5\u987b\u4e25\u683c\u6839\u636e\u7528\u6237\u4e0a\u4f20\u7684\u8d44\u6599\u51fa\u9898\uff0c\u4e0d\u8981\u7f16\u9020\u8d44\u6599\u5916\u7684\u77e5\u8bc6\u3002";

const REQUIRED_KEY_POINTS_SENTENCE =
  "\u4ece\u539f\u6587\u4e2d\u63d0\u53d6\u8be5\u9898\u7684\u6240\u6709\u5fc5\u8981\u8981\u70b9\uff0c\u4e0d\u8981\u9057\u6f0f\u3002";

const MAX_QUESTIONS_PER_SESSION = 50;
const QUESTION_MAX_TOKENS_BY_TYPE = {
  single: 400,
  term: 600,
  short: 600,
  essay: 800,
};

const QUESTION_GENERATION_SKILL = `
# AI 出题 Skill

## 身份
你是一个严格基于学生复习资料的期末出题系统。你只能基于提供的资料片段出题，禁止使用自身知识补充、扩写或猜测。

## 最高优先级规则
1. 一道题只考一个知识点。资料片段包含多个知识点时，只选择其中一个出题。
2. 题型必须匹配内容性质。名词解释类内容禁止出成论述题。
3. 所有题目、答案要点、解析和原文出处都必须能在同一个或相邻的资料片段中找到依据。
4. 优先使用资料中已经标注的重点、必背、必考、高频、考点、注意等内容。
5. 如果资料中已有题目，优先直接复制或轻微规范化原题，不要另起炉灶。
6. evidenceQuote 只截取与本题直接相关的原文，不要贴完整切片；开头必须是一整句话，不能从半句开始。

## 资料结构理解
后端会优先把文件转成 Markdown，并按 Markdown 标题层级切分：
1. 每个二级标题下的内容是一个主要知识切片。
2. 二级标题内容超过 800 字时，再按三级标题拆分。
3. 禁止跨标题合并。不要把上一个标题或下一个标题的内容混进同一道题。
4. 如果某个片段包含多个并列概念，只选择一个概念出题。

## 题型定义与边界

### single 选择题
- 适用内容：定义、时间、人物、作品、分类、特征等有明确对错的事实性知识。
- 必须有 4 个选项 A/B/C/D，且只有 1 个正确答案。
- 干扰项应来自资料中的相近知识点，不能编造资料外内容。
- 题干要具体，不要使用“以下说法正确的是”这种万能题干。

### term 名词解释
- 适用内容：资料明确出现“名词解释/解释下列名词/名词释义”，或出现“短名词 + 解释内容”的结构。
- “短名词 + 解释内容”包括：Markdown 加粗名词后接冒号解释、短标题后接“是/指/即/又称/所谓/指的是”等解释句。
- 如果资料明确标注名词解释，优先按资料标注出题。
- 如果资料没有标注，但能识别到名词后跟解释，也可以出 term。
- 禁止把“什么是 XX”出成 essay；它应是 term 或 short。

### short 简答题
- 适用内容：定义/概念 + 核心要点，或某一对象的特征、原因、分类、组成部分。
- 预期答案通常 200-400 字左右。
- 回答以 2-5 个要点为主，不需要复杂论证展开。
- 如果资料标注“简答题”，优先使用 short。

### essay 论述题
- 适用内容：影响、意义、原因、比较、评价、文学风格、艺术特色等需要分析展开的综合内容。
- 预期答案通常 500 字以上。
- 不能只罗列要点，每个要点后应能展开阐释。
- 如果资料标注“论述题”，优先使用 essay。
- 只有当资料片段明确包含分析、比较、影响、原因、艺术特色、文学风格等内容时，才能出 essay。

## 题型判定决策树
1. 资料是否明确标注题型？
   - 标注名词解释 -> term
   - 标注简答题 -> short
   - 标注论述题 -> essay
2. 是否是短名词后跟解释？
   - 是 -> term，最多转为 short，禁止转为 essay
3. 是否列举特征、分类、原因、组成部分？
   - 是 -> short
4. 是否需要分析影响、意义、比较、评价、文学风格或艺术特色？
   - 是，且原文有足够展开依据 -> essay
5. 以上都不是 -> single 最安全。

## 要点提取规则
1. 从原文中提取该题的所有必要要点，不要遗漏。
2. keyPoints 必须原子化：一个要点只表达一个可评分含义。
3. 简答题通常 2-5 个要点；论述题通常 4-8 个要点，并且要点应能支撑展开论证。
4. 不要把相邻但无关的标题内容合并成答案要点。
5. 如果原文有“第一、第二、第三”“其一、其二”“包括”等枚举结构，必须尽量穷举。

## 自检清单
- 这道题是否只考一个知识点？
- 题型是否匹配？有没有把名词解释误出成论述题？
- 论述题是否真的需要分析展开，而不是简单列点？
- 所有 keyPoints 是否都能在原文中找到？
- evidenceQuote 是否只包含直接相关内容，且从完整句子开始？
- sourceChunkIndexes 是否指向最能支撑本题的 SOURCE？

## 反面案例
错误：请论述什么是“社会主义现实主义”。
原因：“什么是 XX”是名词解释，不是论述题。
正确：解释“社会主义现实主义”的含义及核心主张。

错误：论述“李清照词的艺术特色”和“《词论》的理论贡献”。
原因：一道题混合两个知识点。
正确：拆成两道独立题。

错误：资料只说某作品的作者和年代，却要求分析文学风格。
原因：原文没有风格依据，属于越界出题。

## 输出格式
严格输出 JSON，不要 Markdown，不要解释性文字：
{
  "questions": [
    {
      "type": "single | term | short | essay",
      "title": "题目正文",
      "options": [{"label": "A", "text": "xxx"}, {"label": "B", "text": "xxx"}, {"label": "C", "text": "xxx"}, {"label": "D", "text": "xxx"}] 或 null,
      "correctAnswer": "A/B/C/D 或 null",
      "keyPoints": ["要点1", "要点2"],
      "explanation": "解析",
      "evidenceQuote": "与本题直接相关的原文，80-220 字，必须从完整句子开始",
      "sourceChunkIndexes": [0]
    }
  ]
}
`.trim();

function getProvider() {
  if (process.env.DEEPSEEK_API_KEY || process.env.AI_PROVIDER === "deepseek") return "deepseek";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

function normalizeBaseUrl(value) {
  return String(value || "https://api.deepseek.com").replace(/\/+$/, "");
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON.");
    try {
      return JSON.parse(match[0]);
    } catch (error) {
      throw new Error(`Model returned invalid JSON. ${error.message}`);
    }
  }
}

function normalizeTypeList(types, amount) {
  const picked = Array.isArray(types) && types.length ? types : ["single"];
  return Array.from({ length: amount }).map((_, index) => picked[index % picked.length]);
}

function normalizeQuestionTitle(title) {
  return String(title || "")
    .replace(/[“”"《》〈〉（）()【】\[\]\s，。！？、：:；;,.!?]/g, "")
    .toLowerCase()
    .trim();
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

function textTerms(value) {
  return normalizeText(value).match(/[\u4e00-\u9fff]{2,12}|[A-Za-z0-9]{3,}/g) || [];
}

function answerScopeForQuestion(question, sourceText) {
  const text = normalizeText(sourceText);
  if (!text) return "";
  const evidence = normalizeText(question.evidenceQuote);
  let hit = evidence && text.includes(evidence) ? text.indexOf(evidence) : -1;

  if (hit < 0) {
    const titleTerms = [titleStem(question.title), ...textTerms(titleStem(question.title))]
      .map(normalizeText)
      .filter((item) => item.length >= 4)
      .sort((left, right) => right.length - left.length);
    hit = titleTerms.map((term) => text.indexOf(term)).filter((index) => index >= 0)[0] ?? -1;
  }

  if (hit < 0) return "";

  const before = text.slice(0, hit);
  const startMarkers = [...before.matchAll(/(?:^|\s)(?:\d+[\u3001.\uff0e]|\([^)）]{1,8}\)|\uff08[^)）]{1,8}\uff09)/g)];
  const start = startMarkers.length ? startMarkers[startMarkers.length - 1].index : Math.max(0, hit - 120);
  const after = text.slice(Math.max(hit + 80, start + 120));
  const endMatch = after.match(/(?:^|\s)(?:\d+[\u3001.\uff0e]|\([^)）]{1,8}\)|\uff08[^)）]{1,8}\uff09)/);
  const end = endMatch ? Math.max(hit + 80, start + 120) + endMatch.index : Math.min(text.length, start + 1200);
  return text.slice(start, end);
}

function isMetaKeyPoint(point, questionTitle) {
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

function supportedByScope(point, scopeText) {
  const scope = normalizeText(scopeText);
  if (!scope) return true;
  const text = normalizeText(point);
  if (scope.includes(text)) return true;
  const terms = textTerms(text).filter((term) => !/^(?:\u827a\u672f|\u7279\u8272|\u65b9\u9762|\u5f62\u8c61|\u7ed3\u6784|\u8bed\u8a00)$/.test(term));
  if (!terms.length) return true;
  const hits = terms.filter((term) => scope.includes(term)).length;
  return hits >= Math.max(1, Math.ceil(Math.min(terms.length, 4) * 0.5));
}

function cleanKeyPoints(question, keyPoints, sourceText) {
  const scope = answerScopeForQuestion(question, sourceText);
  const cleaned = [];
  for (const rawPoint of keyPoints) {
    const point = normalizeText(rawPoint).replace(/^[-*\d.\u3001\uff08\uff09()\s]+/, "").trim();
    if (isMetaKeyPoint(point, question.title)) continue;
    if (!supportedByScope(point, scope)) continue;
    if (!cleaned.includes(point)) cleaned.push(point);
  }
  return cleaned.length ? cleaned.slice(0, question.type === "essay" ? 8 : 6) : keyPoints.filter((point) => !isMetaKeyPoint(point, question.title)).slice(0, question.type === "essay" ? 8 : 6);
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/[\u3002\uff01\uff1f\uff1b.!?;]\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
}

function fallbackKeyPoints(question, sourceText) {
  const candidates = [
    ...(Array.isArray(question.keyPoints) ? question.keyPoints : []),
    question.explanation,
    question.evidenceQuote,
    sourceText,
  ]
    .flatMap((item) => splitSentences(item))
    .map((item) => item.replace(/^[-*\d.\u3001\uff08\uff09()\s]+/, "").trim())
    .filter(Boolean);

  return Array.from(new Set(candidates)).slice(0, question.type === "essay" ? 8 : 5);
}

function sentenceExcerpt(text, maxLength = 260) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const sentences = splitSentences(normalized);
  const excerpt = [];
  for (const sentence of sentences) {
    if (excerpt.join("").length + sentence.length > maxLength && excerpt.length) break;
    excerpt.push(sentence);
  }
  return (excerpt.join("\u3002") || normalized.slice(0, maxLength)).slice(0, maxLength).trim();
}

function expandedSourceIndexes(sourceIndexes, sources) {
  const indexes = new Set(sourceIndexes);
  for (const index of sourceIndexes) {
    const source = sources[index];
    if (!source) continue;
    [index - 1, index + 1].forEach((candidateIndex) => {
      const candidate = sources[candidateIndex];
      if (!candidate) return;
      const sameDocument = source.documentId && candidate.documentId && source.documentId === candidate.documentId;
      const adjacentChunk = Math.abs(Number(source.chunkIndex) - Number(candidate.chunkIndex)) === 1;
      if (sameDocument && adjacentChunk) indexes.add(candidateIndex);
    });
  }
  return [...indexes].sort((left, right) => left - right);
}

function stripMarkdownMarker(line) {
  return String(line || "")
    .replace(/^ {0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s*/, "")
    .trim();
}

function isQuestionLine(line) {
  const text = stripMarkdownMarker(line);
  if (!text || compactText(text).length > 140) return false;

  const numbered = /^(?:\d{1,3}[\u3001\uff0e.)．、]|\(\d{1,3}\)|\uff08\d{1,3}\uff09|[一二三四五六七八九十]{1,4}[\u3001\uff0e.)．、]|\([一二三四五六七八九十]{1,4}\)|\uff08[一二三四五六七八九十]{1,4}\uff09)\s*/.test(text);
  const hasQuestionType = /(?:简答题|论述题|名词解释|选择题|填空题|默写题|判断题|问答题)/.test(text);
  const hasQuestionVerb = /^(?:请)?(?:简述|试述|论述|分析|说明|概括|谈谈|比较|解释|回答|指出|列举)/.test(text);
  const endsLikeQuestion = /[？?]\s*$/.test(text);

  return numbered && (hasQuestionType || hasQuestionVerb || endsLikeQuestion);
}

function inferTypeFromText(text, requestedType) {
  if (/名词解释/.test(text)) return "term";
  if (/选择题/.test(text)) return "single";
  if (/论述题/.test(text)) return "essay";
  if (/简答题|问答题/.test(text)) return "short";
  return ["single", "term", "short", "essay"].includes(requestedType) ? requestedType : "short";
}

function cleanQuestionTitle(line) {
  return stripMarkdownMarker(line)
    .replace(/^(?:\d{1,3}[\u3001\uff0e.)．、]|\(\d{1,3}\)|\uff08\d{1,3}\uff09|[一二三四五六七八九十]{1,4}[\u3001\uff0e.)．、])\s*/, "")
    .replace(/[\uff08(](?:简答题|论述题|名词解释|选择题|填空题|默写题|判断题|问答题)[\uff09)]/g, "")
    .trim();
}

function splitAnswerPointLine(line) {
  return stripMarkdownMarker(line)
    .replace(/^(?:\d{1,2}[\u3001\uff0e.)．、]|\(\d{1,2}\)|\uff08\d{1,2}\uff09|[一二三四五六七八九十]{1,3}[\u3001\uff0e.)．、])\s*/, "")
    .replace(/^[-*]\s*/, "")
    .trim();
}

function extractKeyPointsFromSource(sourceText, titleLine = "") {
  const lines = String(sourceText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const startIndex = Math.max(0, lines.findIndex((line) => line === titleLine));
  const bodyLines = startIndex >= 0 ? lines.slice(startIndex + 1) : lines;
  const points = [];

  for (const line of bodyLines) {
    if (line !== titleLine && isQuestionLine(line)) break;
    const cleaned = splitAnswerPointLine(line);
    if (!cleaned || cleaned.length < 6) continue;
    if (/^(?:答案|解析|答题方向|出题模式|复习方向)[:：]?/.test(cleaned)) continue;
    const looksLikePoint = /^(?:\d{1,2}[\u3001\uff0e.)．、]|\(\d{1,2}\)|\uff08\d{1,2}\uff09|[一二三四五六七八九十]{1,3}[\u3001\uff0e.)．、]|[-*])/.test(stripMarkdownMarker(line));
    if (looksLikePoint || /[：:]/.test(cleaned) || cleaned.length >= 18) points.push(cleaned);
    if (points.length >= 8) break;
  }

  if (points.length) return Array.from(new Set(points));
  return splitSentences(sourceText)
    .filter((sentence) => !isMetaKeyPoint(sentence, titleLine))
    .slice(0, 5);
}

function fallbackTitleFromSource(sourceText, requestedType) {
  const lines = String(sourceText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const questionLine = lines.find(isQuestionLine);
  if (questionLine) return { rawLine: questionLine, title: cleanQuestionTitle(questionLine) };

  const heading = [...lines].reverse().find((line) => /^#{1,6}\s+/.test(line)) || lines.find((line) => stripMarkdownMarker(line).length >= 4);
  const base = cleanQuestionTitle(heading || "");
  const prefixByType = {
    term: "解释",
    short: "简述",
    essay: "论述",
    single: "",
  };
  const prefix = prefixByType[requestedType] || "简述";
  return { rawLine: heading || "", title: prefix ? `${prefix}${base}` : base };
}

function fallbackOptionsFromPoints(keyPoints) {
  const correct = keyPoints[0] || "资料中的核心表述";
  const distractors = keyPoints.slice(1, 4);
  while (distractors.length < 3) distractors.push("资料中未直接支持的表述");
  return [correct, ...distractors].slice(0, 4).map((text, index) => ({
    label: ["A", "B", "C", "D"][index],
    text,
  }));
}

function fallbackQuestionsFromSources({ sources, requestedTypes, amount }) {
  const questions = [];
  const usedTitles = new Set();

  for (let index = 0; index < sources.length && questions.length < amount; index += 1) {
    const source = sources[index];
    const requestedType = requestedTypes[questions.length % Math.max(1, requestedTypes.length)] || "short";
    const titleInfo = fallbackTitleFromSource(source.text, requestedType);
    const title = normalizeQuestionTitle(titleInfo.title);
    if (!title || usedTitles.has(title)) continue;

    const rawPoints = extractKeyPointsFromSource(source.text, titleInfo.rawLine);
    const type = inferTypeFromText(titleInfo.rawLine || title, requestedType);
    const keyPoints = cleanKeyPoints({ title, type, keyPoints: rawPoints }, rawPoints, source.text);
    if (!keyPoints.length) continue;

    usedTitles.add(title);
    questions.push(
      normalizeQuestion(
        {
          type,
          title,
          options: type === "single" ? fallbackOptionsFromPoints(keyPoints) : null,
          correctAnswer: type === "single" ? "A" : null,
          keyPoints,
          explanation: keyPoints.join("；"),
          evidenceQuote: sentenceExcerpt(source.text, 220),
          sourceChunkIndexes: [index],
        },
        questions.length,
        sources,
        requestedType,
      ),
    );
  }

  return questions;
}

function buildPrompt({ sources, requestedTypes, amount, excludedQuestions = [] }) {
  const cleanSourceText = sources
    .map((source, index) => `SOURCE ${index} (chunkId: ${source.id})\n${source.text}`)
    .join("\n\n---\n\n");
  const cleanExcludedText = excludedQuestions.length
    ? excludedQuestions
        .slice(0, 200)
        .map((question, index) => `${index + 1}. [${question.type}] ${question.title}`)
        .join("\n")
    : "\u65e0";

  return [
    `Generate ${amount} exam practice questions in this exact requested type order: ${requestedTypes.join(", ")}.`,
    "You are extracting and normalizing questions from the retrieved RAG chunks, not inventing a general quiz.",
    "Highest priority:",
    "1. If a SOURCE contains existing exam questions, practice questions, numbered questions, or labels like \u7b80\u7b54\u9898/\u8bba\u8ff0\u9898/\u540d\u8bcd\u89e3\u91ca/\u9009\u62e9\u9898, copy or lightly normalize those questions first.",
    "2. If a SOURCE marks \u91cd\u70b9/\u8003\u70b9/\u9ad8\u9891/\u5fc5\u80cc/\u5fc5\u8003/\u6838\u5fc3, generate questions only from those marked parts.",
    "3. Only if no existing question is available, generate a question from a single important point in the SOURCE.",
    "4. Never use outside knowledge. Never merge unrelated headings or neighboring chunks into one answer.",
    "5. The title, keyPoints, explanation, evidenceQuote, and sourceChunkIndexes must all be supported by the same SOURCE.",
    "6. For subjective questions, keyPoints are the grading standard. Make them complete, atomic, and directly checkable.",
    "7. keyPoints must be real answer points only. Do not include the question title, a summary like 'includes four aspects', question type labels, answer direction, or content from the next/previous question.",
    "8. When a SOURCE is an existing numbered exam question, treat the lines below it as its answer until the next numbered question starts. Numbered answer points like 1/2/3/4 belong to the current question, not to new questions.",
    "Type rules:",
    "- single: four options A/B/C/D and one correctAnswer.",
    "- term: use for \u540d\u8bcd\u89e3\u91ca or clear term-definition material.",
    "- short: 2-5 keyPoints, suitable for concept/features/reasons/categories.",
    "- essay: 4-8 keyPoints, only when the SOURCE really supports analysis, comparison, causes, influence, or features.",
    "- If requested type conflicts with SOURCE nature, choose the closest safe exam type.",
    "Output JSON only. evidenceQuote should be a short direct excerpt from the SOURCE. sourceChunkIndexes must point to supporting SOURCE indexes.",
    "History questions to avoid:",
    cleanExcludedText,
    "JSON schema:",
    JSON.stringify(QUESTION_SCHEMA, null, 2),
    "RAG SOURCES:",
    cleanSourceText,
  ].join("\n");

  const sourceText = sources
    .map((source, index) => `SOURCE ${index} (chunkId: ${source.id})\n${source.text}`)
    .join("\n\n---\n\n");
  const excludedText = excludedQuestions.length
    ? excludedQuestions
        .slice(0, 200)
        .map((question, index) => `${index + 1}. [${question.type}] ${question.title}`)
        .join("\n")
    : "无";

  if (false) return [
    `请生成 ${amount} 道期末复习题，请尽量按这个题型顺序生成：${requestedTypes.join("、")}。`,
    "如果请求题型与资料内容性质冲突，内容性质优先：例如名词解释内容不能硬出成论述题。",
    "禁止生成“历史已出题目清单”中已经出现过的题目；不要只改几个字、换一个问法后重复考同一个题干。",
    "你必须完整遵循下面的 AI 出题 Skill：",
    QUESTION_GENERATION_SKILL,
    REQUIRED_KEY_POINTS_SENTENCE,
    "历史已出题目清单：",
    excludedText,
    "后端实际校验使用的 JSON schema 如下，字段名必须完全一致：",
    JSON.stringify(QUESTION_SCHEMA, null, 2),
    "资料片段：",
    sourceText,
  ].join("\n");

  return [
    `\u8bf7\u751f\u6210 1 \u9053\u671f\u672b\u590d\u4e60\u9898\uff0c\u9898\u578b\u5c3d\u91cf\u4e3a\uff1a${requestedTypes[0] || "single"}\u3002`,
    "\u53ea\u80fd\u4f7f\u7528\u4e0b\u65b9\u8d44\u6599\u51fa\u9898\uff1b\u4e0d\u8981\u5f15\u5165\u8d44\u6599\u4e2d\u6ca1\u6709\u7684\u77e5\u8bc6\u70b9\u3002",
    REQUIRED_KEY_POINTS_SENTENCE,
    "Priority rules:",
    "1. If the document marks content as key points,重点,重点题,高频,必背,必考,考点, or similar, generate questions from those marked parts first.",
    "2. If the document already contains exam questions,模拟试题,练习题,填空题,选择题,简答题,论述题,名词解释, or numbered questions, preferentially copy or lightly normalize those existing questions instead of inventing new ones.",
    "3. When copying an existing question, preserve its original tested meaning and use the nearby answer/analysis/source text to fill keyPoints and explanation.",
    "4. If no marked key points and no existing questions are found, then generate new questions from concepts, authors, works, styles, features, comparisons, and causes in the source.",
    "The question title, keyPoints, explanation, evidenceQuote, and sourceChunkIndexes must all be supported by the same selected SOURCE text.",
    "Do not ask about literary style, artistic features, influence, causes, or comparison unless the selected SOURCE explicitly contains those points.",
    "If the selected SOURCE is mainly a term definition, generate a definition/concept question instead of a style or analysis question.",
    "Question type rules:",
    "- term means 名词解释. Generate term questions if and only if the selected SOURCE explicitly contains 名词解释/名詞解釋 or an existing term-definition question. If not, do not output type term.",
    "- If the document labels a source question as 名词解释, use type term.",
    "- If the document labels a source question as 简答题/簡答題, use type short.",
    "- If the document labels a source question as 论述题/論述題, use type essay.",
    "- short answer questions should usually be answerable in 200-400 Chinese characters. They are definition/concept plus core points; no complex extended argument is required.",
    "- essay questions should usually require 500+ Chinese characters. They must not be mere point lists; they need explanation, analysis, and elaboration after the points.",
    "- Do not turn short-answer material into essay questions. Only use essay when the source explicitly supports broad analysis, comparison, causes, influence, artistic features, or an existing essay prompt.",
    "For term, short, and essay questions, keyPoints must be complete and atomic: 3-6 separate scoring points, each point should test one clear meaning.",
    "\u4f18\u5148\u9009\u62e9\u8d44\u6599\u4e2d\u9002\u5408\u8003\u8bd5\u7684\u6982\u5ff5\u3001\u4f5c\u8005\u3001\u4f5c\u54c1\u3001\u6d41\u6d3e\u3001\u7279\u5f81\u3001\u5bf9\u6bd4\u5173\u7cfb\u548c\u56e0\u679c\u5173\u7cfb\u3002",
    "single \u5fc5\u987b\u751f\u6210\u56db\u4e2a\u9009\u9879 A/B/C/D\uff0ccorrectAnswer \u53ea\u80fd\u662f A/B/C/D\u3002",
    "term, short \u548c essay \u4e0d\u9700\u8981 options\uff0ccorrectAnswer \u8bbe\u4e3a null\uff0c\u7b54\u6848\u8981\u70b9\u5199\u5728 keyPoints\u3002",
    "\u6bcf\u9053\u9898\u90fd\u5fc5\u987b\u586b\u5199 sourceChunkIndexes\uff0c\u6307\u5411\u6700\u80fd\u652f\u6491\u8be5\u9898\u7684 SOURCE \u7d22\u5f15\u3002",
    "\u6bcf\u9053\u9898\u90fd\u5fc5\u987b\u586b\u5199 evidenceQuote\uff1a\u4ece\u8d44\u6599\u4e2d\u6458\u51fa\u6700\u80fd\u652f\u6491\u7b54\u6848\u7684\u4e00\u5c0f\u6bb5\u539f\u6587\uff0c80 \u5230 220 \u4e2a\u4e2d\u6587\u5b57\u7b26\uff0c\u4e0d\u8981\u6574\u6bb5\u590d\u5236\u3002",
    "evidenceQuote must start from the beginning of a complete sentence and end at a sentence boundary. Do not start with a half sentence.",
    "\u53ea\u8fd4\u56de\u5355\u4e2a JSON \u9898\u76ee\u5bf9\u8c61\uff0c\u4e0d\u8981\u5305\u5728 questions \u6570\u7ec4\u91cc\uff0c\u4e0d\u8981\u8fd4\u56de Markdown \u6216\u89e3\u91ca\u6027\u6587\u5b57\u3002",
    "JSON schema:",
    JSON.stringify(QUESTION_ITEM_SCHEMA, null, 2),
    "\u8d44\u6599\u7247\u6bb5\uff1a",
    sourceText,
  ].join("\n");
}

function normalizeQuestion(question, index, sources, requestedType) {
  const type = ["single", "term", "short", "essay"].includes(question.type) ? question.type : requestedType;
  const sourceIndexes = Array.isArray(question.sourceChunkIndexes)
    ? question.sourceChunkIndexes.filter((item) => Number.isInteger(item) && sources[item])
    : [];
  const fallbackSource = sources[index % Math.max(1, sources.length)];
  const expandedIndexes = sourceIndexes.length ? expandedSourceIndexes(sourceIndexes, sources) : [];
  const sourceChunkIds = expandedIndexes.length ? expandedIndexes.map((item) => sources[item].id) : fallbackSource ? [fallbackSource.id] : [];
  const sourceText = expandedIndexes.length ? expandedIndexes.map((item) => sources[item].text).join("\n\n") : fallbackSource?.text || "";
  const keyPoints = cleanKeyPoints(question, fallbackKeyPoints(question, sourceText), sourceText);
  const evidenceQuote = normalizeText(question.evidenceQuote) || sentenceExcerpt(sourceText || question.explanation);
  const explanation = normalizeText(question.explanation) || keyPoints.join("\uff1b");

  const options =
    type === "single"
      ? (question.options || []).slice(0, 4).map((option, optionIndex) => ({
          label: ["A", "B", "C", "D"][optionIndex],
          text: String(option.text || "").trim(),
        }))
      : null;

  return {
    type,
    title: String(question.title || "").trim(),
    options,
    correctAnswer: type === "single" ? String(question.correctAnswer || "").trim().slice(0, 1) : null,
    keyPoints,
    explanation,
    evidenceQuote,
    sourceChunkIds,
    sourceText,
    sourceLocation: "\u539f\u6587\u51fa\u5904",
  };
}

async function callDeepSeek(prompt, { maxTokens } = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required to generate questions.");

  const baseUrl = normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
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
      max_tokens: Number(maxTokens || process.env.DEEPSEEK_MAX_TOKENS || 6000),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek question generation failed: ${response.status} ${detail}`);
  }

  return extractDeepSeekOutputText(await response.json());
}

async function callOpenAi(prompt, { maxTokens } = {}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
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
          name: "question_generation",
          strict: true,
          schema: QUESTION_ITEM_SCHEMA,
        },
      },
      max_output_tokens: Number(maxTokens || process.env.OPENAI_MAX_OUTPUT_TOKENS || 6000),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI question generation failed: ${response.status} ${detail}`);
  }

  return extractOpenAiOutputText(await response.json());
}

export async function generateQuestionsFromSources({ sources, types, amount, excludedQuestions = [] }) {
  if (!sources.length) throw new Error("No knowledge chunks found for this subject. Upload a document first.");

  const safeAmount = Math.min(MAX_QUESTIONS_PER_SESSION, Math.max(1, Number(amount) || 5));
  const provider = getProvider();

  if (provider === "none") throw new Error("Set DEEPSEEK_API_KEY in .env before generating questions.");

  const allRequestedTypes = normalizeTypeList(types, safeAmount);
  const blockedTitles = new Set(excludedQuestions.map((question) => normalizeQuestionTitle(question.title)).filter(Boolean));
  const generatedResults = await Promise.all(
    allRequestedTypes.map((requestedType, index) =>
      generateSingleQuestion({
        provider,
        sources: selectBatchSources(sources, index, 1),
        requestedType,
        excludedQuestions,
        index,
      }),
    ),
  );

  const questions = [];
  const missingTypes = [];
  for (let index = 0; index < generatedResults.length; index += 1) {
    const question = generatedResults[index];
    if (!question) {
      missingTypes.push(allRequestedTypes[index]);
      continue;
    }
    const normalizedTitle = normalizeQuestionTitle(question.title);
    if (!normalizedTitle || blockedTitles.has(normalizedTitle)) {
      missingTypes.push(allRequestedTypes[index]);
      continue;
    }
    blockedTitles.add(normalizedTitle);
    questions.push(question);
  }

  if (questions.length < safeAmount) {
    const fallbackQuestions = fallbackQuestionsFromSources({
      sources,
      requestedTypes: missingTypes.length ? missingTypes : allRequestedTypes.slice(questions.length),
      amount: safeAmount - questions.length,
    });
    for (const question of fallbackQuestions) {
      const normalizedTitle = normalizeQuestionTitle(question.title);
      if (!normalizedTitle || blockedTitles.has(normalizedTitle)) continue;
      blockedTitles.add(normalizedTitle);
      questions.push(question);
      if (questions.length >= safeAmount) break;
    }
  }

  if (!questions.length) throw new Error("Model returned no questions.");
  return questions.slice(0, safeAmount);
}

function selectBatchSources(sources, start, amount) {
  const windowSize = Math.min(sources.length, Math.max(8, amount * 2));
  return Array.from({ length: windowSize }, (_, index) => sources[(start + index) % sources.length]);
}

function maxTokensForQuestionType(type) {
  return QUESTION_MAX_TOKENS_BY_TYPE[type] || QUESTION_MAX_TOKENS_BY_TYPE.short;
}

async function generateSingleQuestion({ provider, sources, requestedType, excludedQuestions = [], index = 0 }) {
  const prompt = buildPrompt({ sources, requestedTypes: [requestedType], amount: 1, excludedQuestions });
  const maxTokens = maxTokensForQuestionType(requestedType);
  try {
    const text =
      provider === "deepseek"
        ? await callDeepSeek(prompt, { maxTokens })
        : await callOpenAi(prompt, { maxTokens });
    const parsed = parseJson(text);
    const question = Array.isArray(parsed.questions) ? parsed.questions[0] : parsed;
    if (!question || typeof question !== "object") throw new Error("Model did not return a question object.");
    return normalizeQuestion(question, 0, sources, requestedType);
  } catch (error) {
    console.warn(`Question ${index + 1} generation skipped. ${error.message}`);
    return null;
  }
}
