export const VECTOR_SIZE = 1536;
const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const DASHSCOPE_EMBEDDING_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
const DEFAULT_EMBEDDING_BATCH_SIZE = 10;
const DEFAULT_EMBEDDING_CONCURRENCY = 3;

function hashToken(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function normalize(vector) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / length);
}

function localEmbedding(text) {
  const vector = Array.from({ length: VECTOR_SIZE }, () => 0);
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[\p{Script=Han}]|[a-z0-9]+/gu) || [];

  for (const token of tokens) {
    const index = hashToken(token) % VECTOR_SIZE;
    vector[index] += 1;
  }

  return normalize(vector);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = Array.from({ length: items.length });
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function embedTexts(texts) {
  const provider = String(process.env.EMBEDDING_PROVIDER || "local").toLowerCase();

  if (provider === "qwen" || provider === "dashscope") {
    return embedWithDashScope(texts);
  }

  if (provider !== "openai" || !process.env.OPENAI_API_KEY) {
    return texts.map(localEmbedding);
  }

  return embedWithOpenAi(texts);
}

async function embedWithOpenAi(texts) {
  let response;
  try {
    response = await fetch(OPENAI_EMBEDDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
        input: texts,
      }),
    });
  } catch (error) {
    console.warn("Embedding request failed; using local development embeddings.", error);
    return texts.map(localEmbedding);
  }

  if (!response.ok) {
    const detail = await response.text();
    console.warn(`Embedding request failed: ${response.status} ${detail}`);
    return texts.map(localEmbedding);
  }

  const payload = await response.json();
  return payload.data
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
}

async function embedWithDashScope(texts) {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_EMBEDDING_API_KEY;
  if (!apiKey) {
    console.warn("DASHSCOPE_API_KEY is missing; using local development embeddings.");
    return texts.map(localEmbedding);
  }

  const endpoint = process.env.QWEN_EMBEDDING_ENDPOINT || DASHSCOPE_EMBEDDING_URL;
  const model = process.env.QWEN_EMBEDDING_MODEL || "text-embedding-v4";
  const dimensions = Number(process.env.QWEN_EMBEDDING_DIM || VECTOR_SIZE);
  const batchSize = Math.max(1, Number(process.env.QWEN_EMBEDDING_BATCH_SIZE || DEFAULT_EMBEDDING_BATCH_SIZE));
  const concurrency = Math.max(1, Number(process.env.QWEN_EMBEDDING_CONCURRENCY || DEFAULT_EMBEDDING_CONCURRENCY));
  const batches = chunkArray(texts, batchSize);

  try {
    const batchEmbeddings = await mapWithConcurrency(batches, concurrency, async (batch) => {
      return requestDashScopeEmbeddingBatch({ endpoint, apiKey, model, dimensions, batch });
    });
    return batchEmbeddings.flat();
  } catch (error) {
    console.warn("DashScope embedding request failed; using local development embeddings.", error);
    return texts.map(localEmbedding);
  }
}

async function requestDashScopeEmbeddingBatch({ endpoint, apiKey, model, dimensions, batch }) {
  let response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: batch,
        dimensions,
        encoding_format: "float",
      }),
    });
  } catch (error) {
    throw new Error(`DashScope embedding network error: ${error.message}`);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DashScope embedding request failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  return payload.data
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
}

export function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let i = 0; i < length; i += 1) {
    score += left[i] * right[i];
  }
  return score;
}
