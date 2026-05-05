import pg from "pg";

const DEFAULT_VISITOR_ID = "anonymous-public";
const DEFAULT_CHUNK_INSERT_BATCH_SIZE = 20;

function toVectorSql(vector) {
  return `[${vector.join(",")}]`;
}

function toSubject(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    sourceFileName: row.source_file_name || "",
    sourceFileSize: Number(row.source_file_size || 0),
    documentCount: Number(row.document_count || 0),
    chunkCount: Number(row.chunk_count || 0),
  };
}

function toDocument(row) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.file_size,
    textLength: row.text_length,
    contentHash: row.content_hash || "",
    createdAt: row.created_at,
  };
}

function toChunk(row) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    text: row.chunk_text,
    tokenEstimate: row.token_estimate,
    score: row.score === undefined ? undefined : Number(Number(row.score).toFixed(4)),
    createdAt: row.created_at,
  };
}

function normalizeVisitorId(visitorId) {
  return String(visitorId || DEFAULT_VISITOR_ID).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80) || DEFAULT_VISITOR_ID;
}

async function ensureVisitorUser(pool, visitorId) {
  const nickname = `visitor:${normalizeVisitorId(visitorId)}`;
  const existing = await pool.query("select id from users where nickname = $1 limit 1", [nickname]);
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const created = await pool.query("insert into users (nickname) values ($1) returning id", [nickname]);
  return created.rows[0].id;
}

async function ensureSchema(pool) {
  await pool.query("alter table documents add column if not exists content_hash text");
  await pool.query("alter table questions add column if not exists document_hash text");
  await pool.query("create index if not exists documents_content_hash_idx on documents(content_hash)");
  await pool.query("create index if not exists questions_document_hash_idx on questions(document_hash)");
}

export async function createDbStore(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  });

  await ensureSchema(pool);

  async function getUserId(visitorId) {
    return ensureVisitorUser(pool, visitorId);
  }

  return {
    async health() {
      await pool.query("select 1");
      return { ok: true };
    },

    async createSubject({ visitorId, name }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          insert into subjects (user_id, name)
          values ($1, $2)
          returning id, name, created_at
        `,
        [userId, name],
      );
      return toSubject(result.rows[0]);
    },

    async listSubjects({ visitorId } = {}) {
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select
            s.id,
            s.name,
            s.created_at,
            latest.file_name as source_file_name,
            latest.file_size as source_file_size,
            count(distinct d.id) as document_count,
            count(c.id) as chunk_count
          from subjects s
          left join documents d on d.subject_id = s.id
          left join document_chunks c on c.subject_id = s.id
          left join lateral (
            select file_name, file_size
            from documents
            where subject_id = s.id
            order by created_at desc
            limit 1
          ) latest on true
          where s.user_id = $1
          group by s.id, latest.file_name, latest.file_size
          order by s.created_at desc
        `,
        [userId],
      );
      return result.rows.map(toSubject);
    },

    async getSubject({ visitorId, subjectId }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select
            s.id,
            s.name,
            s.created_at,
            latest.file_name as source_file_name,
            latest.file_size as source_file_size,
            count(distinct d.id) as document_count,
            count(c.id) as chunk_count
          from subjects s
          left join documents d on d.subject_id = s.id
          left join document_chunks c on c.subject_id = s.id
          left join lateral (
            select file_name, file_size
            from documents
            where subject_id = s.id
            order by created_at desc
            limit 1
          ) latest on true
          where s.user_id = $1 and s.id = $2
          group by s.id, latest.file_name, latest.file_size
        `,
        [userId, subjectId],
      );
      return result.rows[0] ? toSubject(result.rows[0]) : null;
    },

    async deleteSubject({ visitorId, subjectId }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query("delete from subjects where user_id = $1 and id = $2", [userId, subjectId]);
      return result.rowCount > 0;
    },

    async createDocument(documentInput) {
      const userId = await getUserId(documentInput.visitorId);
      const result = await pool.query(
        `
          insert into documents (user_id, subject_id, file_name, mime_type, file_size, text_length, content_hash)
          values ($1, $2, $3, $4, $5, $6, $7)
          returning id, subject_id, file_name, mime_type, file_size, text_length, content_hash, created_at
        `,
        [
          userId,
          documentInput.subjectId,
          documentInput.fileName,
          documentInput.mimeType,
          documentInput.size,
          documentInput.textLength,
          documentInput.contentHash,
        ],
      );
      return toDocument(result.rows[0]);
    },

    async getDocumentHashesForSubject({ visitorId, subjectId }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select distinct content_hash
          from documents
          where user_id = $1
            and subject_id = $2
            and content_hash is not null
            and content_hash <> ''
          order by content_hash asc
        `,
        [userId, subjectId],
      );
      return result.rows.map((row) => row.content_hash);
    },

    async getPriorQuestionsByDocumentHashes({ visitorId, documentHashes, types, limit = 500 }) {
      if (!documentHashes?.length) return [];
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select distinct title, type
          from questions
          where user_id = $1
            and document_hash = any($2::text[])
            and type = any($3::text[])
          order by title asc
          limit $4
        `,
        [userId, documentHashes, types, limit],
      );
      return result.rows.map((row) => ({
        title: row.title,
        type: row.type,
      }));
    },

    async addChunks(input) {
      const chunkInputs = Array.isArray(input) ? input : input.chunks;
      if (!chunkInputs.length) return [];
      const userId = await getUserId(Array.isArray(input) ? undefined : input.visitorId);

      const batchSize = Math.max(1, Number(process.env.CHUNK_INSERT_BATCH_SIZE || DEFAULT_CHUNK_INSERT_BATCH_SIZE));
      const savedRows = [];

      for (let start = 0; start < chunkInputs.length; start += batchSize) {
        const batch = chunkInputs.slice(start, start + batchSize);
        const values = [];
        const rows = batch.map((chunk, index) => {
          const offset = index * 7;
          values.push(
            userId,
            chunk.subjectId,
            chunk.documentId,
            chunk.chunkIndex,
            chunk.text,
            chunk.tokenEstimate,
            toVectorSql(chunk.embedding),
          );
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector)`;
        });

        const result = await pool.query(
          `
            insert into document_chunks (
              user_id,
              subject_id,
              document_id,
              chunk_index,
              chunk_text,
              token_estimate,
              embedding
            )
            values ${rows.join(",")}
            returning id, subject_id, document_id, chunk_index, chunk_text, token_estimate, created_at
          `,
          values,
        );

        savedRows.push(...result.rows);
      }

      return savedRows.map(toChunk);
    },

    async getRecentQuestions({ visitorId, subjectId, types, limit = 30 }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select
            id,
            subject_id,
            type,
            title,
            options,
            correct_answer,
            explanation,
            source_chunk_ids,
            created_at
          from questions
          where user_id = $1
            and subject_id = $2
            and type = any($3::text[])
          order by created_at desc
          limit $4
        `,
        [userId, subjectId, types, limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        type: row.type,
        title: row.title,
        options: row.options,
        correctAnswer: row.correct_answer,
        explanation: row.explanation,
        keyPoints: [],
        evidenceQuote: "",
        sourceChunkIds: row.source_chunk_ids || [],
        sourceText: "",
        sourceLocation: "原文出处",
      }));
    },

    async searchChunks({ visitorId, subjectId, queryEmbedding, limit = 5 }) {
      const userId = await getUserId(visitorId);
      try {
        const result = await pool.query(
          `
            select
              id,
              subject_id,
              document_id,
              chunk_index,
              chunk_text,
              token_estimate,
              created_at,
              1 - (embedding <=> $3::vector) as score
            from document_chunks
            where user_id = $1 and subject_id = $2
            order by embedding <=> $3::vector
            limit $4
          `,
          [userId, subjectId, toVectorSql(queryEmbedding), limit],
        );
        if (result.rows.length) return result.rows.map(toChunk);
      } catch (error) {
        console.warn("Vector search failed; falling back to recent chunks.", error.message);
      }

      const fallback = await pool.query(
        `
          select
            id,
            subject_id,
            document_id,
            chunk_index,
            chunk_text,
            token_estimate,
            created_at,
            0 as score
          from document_chunks
          where user_id = $1 and subject_id = $2
          order by chunk_index asc
          limit $3
        `,
        [userId, subjectId, limit],
      );
      return fallback.rows.map(toChunk);
    },

    async listChunks({ visitorId, subjectId, limit = 1000 }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select
            id,
            subject_id,
            document_id,
            chunk_index,
            chunk_text,
            token_estimate,
            created_at,
            0 as score
          from document_chunks
          where user_id = $1 and subject_id = $2
          order by document_id asc, chunk_index asc
          limit $3
        `,
        [userId, subjectId, limit],
      );
      return result.rows.map(toChunk);
    },

    async saveQuestions({ visitorId, subjectId, questions, documentHash = null }) {
      const userId = await getUserId(visitorId);
      const saved = [];
      for (const question of questions) {
        const result = await pool.query(
          `
            insert into questions (
              user_id,
              subject_id,
              type,
              title,
              options,
              correct_answer,
              explanation,
              source_chunk_ids,
              document_hash
            )
            values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid[], $9)
            returning id
          `,
          [
            userId,
            subjectId,
            question.type,
            question.title,
            question.options ? JSON.stringify(question.options) : null,
            question.correctAnswer,
            question.explanation,
            question.sourceChunkIds,
            documentHash,
          ],
        );
        saved.push({
          ...question,
          id: result.rows[0].id,
          subjectId,
        });
      }
      return saved;
    },
  };
}
