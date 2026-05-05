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

const SYSTEM_PROMPT =
  "\u4f60\u662f\u9762\u5411\u671f\u672b\u590d\u4e60\u7684\u51fa\u9898\u8001\u5e08\uff0c\u5fc5\u987b\u4e25\u683c\u6839\u636e\u7528\u6237\u4e0a\u4f20\u7684\u8d44\u6599\u51fa\u9898\uff0c\u4e0d\u8981\u7f16\u9020\u8d44\u6599\u5916\u7684\u77e5\u8bc6\u3002";

const REQUIRED_KEY_POINTS_SENTENCE =
  "\u4ece\u539f\u6587\u4e2d\u63d0\u53d6\u8be5\u9898\u7684\u6240\u6709\u5fc5\u8981\u8981\u70b9\uff0c\u4e0d\u8981\u9057\u6f0f\u3002";

const MAX_QUESTIONS_PER_SESSION = 50;
const QUESTION_BATCH_SIZE = 8;
const QUESTION_BATCH_CONCURRENCY = 3;

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

function buildPrompt({ sources, requestedTypes, amount, excludedQuestions = [] }) {
  const sourceText = sources
    .map((source, index) => `SOURCE ${index} (chunkId: ${source.id})\n${source.text}`)
    .join("\n\n---\n\n");
  const excludedText = excludedQuestions.length
    ? excludedQuestions
        .slice(0, 200)
        .map((question, index) => `${index + 1}. [${question.type}] ${question.title}`)
        .join("\n")
    : "无";

  return [
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
    `\u8bf7\u751f\u6210 ${amount} \u9053\u671f\u672b\u590d\u4e60\u9898\uff0c\u9898\u578b\u987a\u5e8f\u4e3a\uff1a${requestedTypes.join("\u3001")}\u3002`,
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
    "\u53ea\u8fd4\u56de JSON\uff0c\u4e0d\u8981\u8fd4\u56de Markdown \u6216\u89e3\u91ca\u6027\u6587\u5b57\u3002",
    "JSON schema:",
    JSON.stringify(QUESTION_SCHEMA, null, 2),
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
  const sourceChunkIds = sourceIndexes.length ? sourceIndexes.map((item) => sources[item].id) : fallbackSource ? [fallbackSource.id] : [];
  const sourceText = sourceIndexes.length ? sourceIndexes.map((item) => sources[item].text).join("\n\n") : fallbackSource?.text || "";

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
    keyPoints: Array.isArray(question.keyPoints) ? question.keyPoints.map((item) => String(item).trim()).filter(Boolean) : [],
    explanation: String(question.explanation || "").trim(),
    evidenceQuote: String(question.evidenceQuote || "").trim(),
    sourceChunkIds,
    sourceText,
    sourceLocation: "\u539f\u6587\u51fa\u5904",
  };
}

async function callDeepSeek(prompt) {
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
      max_tokens: 12000,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek question generation failed: ${response.status} ${detail}`);
  }

  return extractDeepSeekOutputText(await response.json());
}

async function callOpenAi(prompt) {
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
          schema: QUESTION_SCHEMA,
        },
      },
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
  const batches = [];
  for (let start = 0; start < safeAmount; start += QUESTION_BATCH_SIZE) {
    const amount = Math.min(QUESTION_BATCH_SIZE, safeAmount - start);
    batches.push({
      start,
      amount,
      requestedTypes: allRequestedTypes.slice(start, start + amount),
      sources: selectBatchSources(sources, start, amount),
    });
  }

  const batchResults = await runQuestionBatches({ provider, batches, excludedQuestions });
  const questions = [];
  for (const question of batchResults.flat()) {
    const normalizedTitle = normalizeQuestionTitle(question.title);
    if (!normalizedTitle || blockedTitles.has(normalizedTitle)) continue;
    blockedTitles.add(normalizedTitle);
    questions.push(question);
  }

  if (!questions.length) throw new Error("Model returned no questions.");
  return questions.slice(0, safeAmount);
}

function selectBatchSources(sources, start, amount) {
  const windowSize = Math.min(sources.length, Math.max(8, amount * 2));
  return Array.from({ length: windowSize }, (_, index) => sources[(start + index) % sources.length]);
}

async function runQuestionBatches({ provider, batches, excludedQuestions }) {
  const results = new Array(batches.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < batches.length) {
      const index = nextIndex;
      nextIndex += 1;
      const batch = batches[index];
      results[index] = await generateQuestionBatch({
        provider,
        sources: batch.sources,
        requestedTypes: batch.requestedTypes,
        amount: batch.amount,
        excludedQuestions,
      });
    }
  }

  const workerCount = Math.min(QUESTION_BATCH_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function generateQuestionBatch({ provider, sources, requestedTypes, amount, excludedQuestions = [] }) {
  const prompt = buildPrompt({ sources, requestedTypes, amount, excludedQuestions });
  let text;
  try {
    text = provider === "deepseek" ? await callDeepSeek(prompt) : await callOpenAi(prompt);
  } catch (error) {
    throw new Error(`${provider} question generation request failed. ${error.message}`);
  }

  try {
    const parsed = parseJson(text);
    const questions = (parsed.questions || [])
      .slice(0, amount)
      .map((question, index) => normalizeQuestion(question, index, sources, requestedTypes[index]));

    if (!questions.length) throw new Error("Model returned no questions.");
    return questions;
  } catch (error) {
    if (amount <= 1) throw error;

    const midpoint = Math.ceil(amount / 2);
    const first = await generateQuestionBatch({
      provider,
      sources,
      requestedTypes: requestedTypes.slice(0, midpoint),
      amount: midpoint,
      excludedQuestions,
    });
    const second = await generateQuestionBatch({
      provider,
      sources,
      requestedTypes: requestedTypes.slice(midpoint),
      amount: amount - midpoint,
      excludedQuestions,
    });
    return [...first, ...second];
  }
}
