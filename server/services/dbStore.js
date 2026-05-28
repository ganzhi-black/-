import pg from "pg";
import crypto from "node:crypto";

const DEFAULT_VISITOR_ID = "anonymous-public";
const DEFAULT_CHUNK_INSERT_BATCH_SIZE = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toVectorSql(vector) {
  return `[${vector.join(",")}]`;
}

function isTransientConnectionError(error) {
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

async function queryWithRetry(pool, sql, params = [], retries = 1) {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (retries > 0 && isTransientConnectionError(error)) {
      console.warn("Database connection was interrupted; retrying query once.", error.message);
      return queryWithRetry(pool, sql, params, retries - 1);
    }
    throw error;
  }
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
    generatedQuestionCount: Number(row.generated_question_count || 0),
    lastPracticeAt: row.last_practice_at || null,
    mistakeCount: Number(row.mistake_count || 0),
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

function firstUnansweredIndex(questions, answers) {
  const answeredIndexes = new Set(answers.map((answer) => answer.questionIndex));
  const nextIndex = questions.findIndex((_, index) => !answeredIndexes.has(index));
  return nextIndex >= 0 ? nextIndex : Math.max(0, questions.length - 1);
}

async function ensureVisitorUser(pool, visitorId) {
  if (UUID_PATTERN.test(String(visitorId || ""))) {
    const actualUser = await pool.query("select id from users where id = $1 limit 1", [visitorId]);
    if (actualUser.rows[0]) return actualUser.rows[0].id;
  }

  const nickname = `visitor:${normalizeVisitorId(visitorId)}`;
  const existing = await pool.query("select id from users where nickname = $1 limit 1", [nickname]);
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const created = await pool.query("insert into users (nickname) values ($1) returning id", [nickname]);
  return created.rows[0].id;
}

async function findExistingVisitorUserId(client, visitorId) {
  const nickname = `visitor:${normalizeVisitorId(visitorId)}`;
  const existing = await client.query("select id from users where nickname = $1 limit 1", [nickname]);
  return existing.rows[0]?.id || null;
}

async function ensureSchema(pool) {
  await pool.query("alter table users add column if not exists email text");
  await pool.query("alter table users add column if not exists password_hash text");
  await pool.query("create unique index if not exists users_email_unique_idx on users(lower(email)) where email is not null");
  await pool.query(`
    create table if not exists auth_sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      token_hash text not null unique,
      expires_at timestamptz not null,
      user_agent text,
      ip_address text,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query("create index if not exists auth_sessions_user_idx on auth_sessions(user_id)");
  await pool.query("create index if not exists auth_sessions_expires_idx on auth_sessions(expires_at)");
  await pool.query("alter table documents add column if not exists content_hash text");
  await pool.query("alter table questions add column if not exists document_hash text");
  await pool.query("alter table questions add column if not exists key_points text[] not null default '{}'");
  await pool.query("alter table questions add column if not exists evidence_quote text");
  await pool.query("create index if not exists documents_content_hash_idx on documents(content_hash)");
  await pool.query("create index if not exists questions_document_hash_idx on questions(document_hash)");
  await pool.query(`
    create table if not exists answers (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id) on delete cascade,
      session_id text,
      subject_id uuid references subjects(id) on delete cascade,
      question_id uuid references questions(id) on delete cascade,
      user_answer text not null,
      is_correct boolean,
      accuracy numeric,
      result jsonb,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists practice_sessions (
      id text primary key,
      user_id uuid not null references users(id) on delete cascade,
      subject_id uuid not null references subjects(id) on delete cascade,
      mode text not null default 'relaxed',
      question_types text[] not null default '{}',
      question_ids uuid[] not null default '{}',
      question_count integer not null default 0,
      answered_count integer not null default 0,
      skipped_count integer not null default 0,
      correct_count integer not null default 0,
      wrong_count integer not null default 0,
      accuracy_rate integer not null default 0,
      started_at timestamptz not null default now(),
      completed_at timestamptz
    )
  `);
  await pool.query("create index if not exists practice_sessions_user_idx on practice_sessions(user_id, started_at desc)");
  await pool.query("alter table answers add column if not exists session_id text");
  await pool.query("alter table answers add column if not exists subject_id uuid references subjects(id) on delete cascade");
  await pool.query("alter table answers add column if not exists is_correct boolean");
  await pool.query("alter table answers add column if not exists accuracy numeric");
  await pool.query("alter table answers add column if not exists result jsonb");
  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'answers_session_fk') then
        alter table answers add constraint answers_session_fk
          foreign key (session_id) references practice_sessions(id) on delete cascade;
      end if;
    end $$;
  `);
  await pool.query(`
    create table if not exists mistakes (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id) on delete cascade,
      subject_id uuid references subjects(id) on delete cascade,
      question_id uuid references questions(id) on delete cascade,
      last_answer_id uuid references answers(id) on delete set null,
      attempts integer not null default 1,
      updated_at timestamptz not null default now(),
      unique(user_id, question_id)
    )
  `);
  await pool.query(`
    create table if not exists analytics_events (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id) on delete set null,
      session_id text,
      event_name text not null,
      page_path text,
      properties jsonb not null default '{}',
      user_agent text,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query("create index if not exists analytics_events_created_idx on analytics_events(created_at desc)");
  await pool.query("create index if not exists analytics_events_name_idx on analytics_events(event_name, created_at desc)");
  await pool.query(`
    create table if not exists daily_metrics (
      metric_date date not null,
      metric_name text not null,
      metric_value numeric not null default 0,
      properties jsonb not null default '{}',
      primary key (metric_date, metric_name, properties)
    )
  `);
}

export async function createDbStore(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  });

  pool.on("error", (error) => {
    console.warn("Idle database connection error:", error.message);
  });

  await ensureSchema(pool);

  function isUuid(value) {
    return UUID_PATTERN.test(String(value || ""));
  }

  async function getUserId(visitorId) {
    return ensureVisitorUser(pool, visitorId);
  }

  return {
    async claimVisitorData({ visitorId, userId }) {
      if (!visitorId || !userId || String(visitorId) === String(userId)) {
        return { claimed: false };
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        const visitorUserId = await findExistingVisitorUserId(client, visitorId);
        if (!visitorUserId || String(visitorUserId) === String(userId)) {
          await client.query("commit");
          return { claimed: false };
        }

        await client.query(
          `
            delete from mistakes visitor_mistakes
            using mistakes account_mistakes
            where visitor_mistakes.user_id = $2
              and account_mistakes.user_id = $1
              and account_mistakes.question_id = visitor_mistakes.question_id
          `,
          [userId, visitorUserId],
        );

        const tableNames = [
          "subjects",
          "documents",
          "document_chunks",
          "questions",
          "practice_sessions",
          "answers",
          "mistakes",
          "analytics_events",
        ];
        const counts = {};

        for (const tableName of tableNames) {
          const result = await client.query(`update ${tableName} set user_id = $1 where user_id = $2`, [userId, visitorUserId]);
          counts[tableName] = result.rowCount;
        }

        await client.query("commit");
        return {
          claimed: Object.values(counts).some((count) => count > 0),
          visitorUserId,
          counts,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async claimSubjectData({ subjectIds, userId }) {
      const validSubjectIds = [...new Set((subjectIds || []).filter((id) => isUuid(id)))];
      if (!validSubjectIds.length || !isUuid(userId)) return { claimed: false };

      const client = await pool.connect();
      try {
        await client.query("begin");
        const targetUserResult = await client.query("select id from users where id = $1 limit 1", [userId]);
        if (!targetUserResult.rows[0]) {
          await client.query("commit");
          return { claimed: false, reason: "target_user_missing" };
        }

        const ownerResult = await client.query(
          `
            select distinct s.user_id
            from subjects s
            join users u on u.id = s.user_id
            where s.id = any($1::uuid[])
              and s.user_id <> $2
              and (u.email is null or u.email = '' or u.nickname like 'visitor:%')
          `,
          [validSubjectIds, userId],
        );
        const previousUserIds = ownerResult.rows.map((row) => row.user_id).filter(Boolean);
        if (!previousUserIds.length) {
          await client.query("commit");
          return { claimed: false };
        }

        await client.query(
          `
            delete from mistakes visitor_mistakes
            using mistakes account_mistakes
            where visitor_mistakes.user_id = any($2::uuid[])
              and visitor_mistakes.subject_id = any($3::uuid[])
              and account_mistakes.user_id = $1
              and account_mistakes.question_id = visitor_mistakes.question_id
          `,
          [userId, previousUserIds, validSubjectIds],
        );

        const counts = {};
        const subjectResult = await client.query(
          "update subjects set user_id = $1 where user_id = any($2::uuid[]) and id = any($3::uuid[])",
          [userId, previousUserIds, validSubjectIds],
        );
        counts.subjects = subjectResult.rowCount;

        const subjectScopedTables = ["documents", "document_chunks", "questions", "practice_sessions", "answers", "mistakes"];

        for (const tableName of subjectScopedTables) {
          const result = await client.query(
            `update ${tableName} set user_id = $1 where user_id = any($2::uuid[]) and subject_id = any($3::uuid[])`,
            [userId, previousUserIds, validSubjectIds],
          );
          counts[tableName] = result.rowCount;
        }

        const analyticsResult = await client.query("update analytics_events set user_id = $1 where user_id = any($2::uuid[])", [userId, previousUserIds]);
        counts.analytics_events = analyticsResult.rowCount;

        await client.query("commit");
        return {
          claimed: Object.values(counts).some((count) => count > 0),
          subjectIds: validSubjectIds,
          previousUserIds,
          counts,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async createUser({ email, passwordHash, nickname }) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const result = await pool.query(
        `
          insert into users (email, password_hash, nickname)
          values ($1, $2, $3)
          returning id, email, nickname, created_at
        `,
        [normalizedEmail, passwordHash, nickname || normalizedEmail.split("@")[0]],
      );
      return result.rows[0];
    },

    async getUserByEmail(email) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const result = await pool.query(
        `
          select id, email, password_hash, nickname, created_at
          from users
          where lower(email) = $1
          limit 1
        `,
        [normalizedEmail],
      );
      return result.rows[0] || null;
    },

    async getUserById(userId) {
      const result = await pool.query(
        `
          select id, email, nickname, created_at
          from users
          where id = $1
          limit 1
        `,
        [userId],
      );
      return result.rows[0] || null;
    },

    async createAuthSession({ userId, tokenHash, expiresAt, userAgent, ipAddress }) {
      await pool.query(
        `
          insert into auth_sessions (user_id, token_hash, expires_at, user_agent, ip_address)
          values ($1, $2, $3, $4, $5)
        `,
        [userId, tokenHash, expiresAt, userAgent || "", ipAddress || ""],
      );
    },

    async getAuthSession(tokenHash) {
      const result = await queryWithRetry(
        pool,
        `
          select
            s.id as session_id,
            s.user_id as id,
            s.user_id,
            s.expires_at,
            u.email,
            u.nickname,
            u.created_at
          from auth_sessions s
          join users u on u.id = s.user_id
          where s.token_hash = $1
            and s.expires_at > now()
          limit 1
        `,
        [tokenHash],
      );
      return result.rows[0] || null;
    },

    async deleteAuthSession(tokenHash) {
      await pool.query("delete from auth_sessions where token_hash = $1", [tokenHash]);
    },

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
            count(distinct c.id) as chunk_count,
            coalesce(q_stats.generated_question_count, 0) as generated_question_count,
            practice_stats.last_practice_at,
            coalesce(mistake_stats.mistake_count, 0) as mistake_count
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
          left join lateral (
            select count(distinct q.id) as generated_question_count
            from questions q
            where q.user_id = s.user_id and q.subject_id = s.id
          ) q_stats on true
          left join lateral (
            select max(ps.started_at) as last_practice_at
            from practice_sessions ps
            where ps.user_id = s.user_id and ps.subject_id = s.id
          ) practice_stats on true
          left join lateral (
            select count(distinct m.id) as mistake_count
            from mistakes m
            where m.user_id = s.user_id and m.subject_id = s.id
          ) mistake_stats on true
          where s.user_id = $1
          group by s.id, latest.file_name, latest.file_size, q_stats.generated_question_count, practice_stats.last_practice_at, mistake_stats.mistake_count
          order by s.created_at desc
        `,
        [userId],
      );
      return result.rows.map(toSubject);
    },

    async getSubject({ visitorId, subjectId }) {
      if (!isUuid(subjectId)) return null;
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
            count(distinct c.id) as chunk_count,
            coalesce(q_stats.generated_question_count, 0) as generated_question_count,
            practice_stats.last_practice_at,
            coalesce(mistake_stats.mistake_count, 0) as mistake_count
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
          left join lateral (
            select count(distinct q.id) as generated_question_count
            from questions q
            where q.user_id = s.user_id and q.subject_id = s.id
          ) q_stats on true
          left join lateral (
            select max(ps.started_at) as last_practice_at
            from practice_sessions ps
            where ps.user_id = s.user_id and ps.subject_id = s.id
          ) practice_stats on true
          left join lateral (
            select count(distinct m.id) as mistake_count
            from mistakes m
            where m.user_id = s.user_id and m.subject_id = s.id
          ) mistake_stats on true
          where s.user_id = $1 and s.id = $2
          group by s.id, latest.file_name, latest.file_size, q_stats.generated_question_count, practice_stats.last_practice_at, mistake_stats.mistake_count
        `,
        [userId, subjectId],
      );
      return result.rows[0] ? toSubject(result.rows[0]) : null;
    },

    async deleteSubject({ visitorId, subjectId }) {
      if (!isUuid(subjectId)) return false;
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
      if (!isUuid(subjectId)) return [];
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
      if (!isUuid(subjectId)) return [];
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select
            q.id,
            q.subject_id,
            q.type,
            q.title,
            q.options,
            q.correct_answer,
            q.key_points,
            q.explanation,
            q.evidence_quote,
            q.source_chunk_ids,
            coalesce((
              select string_agg(expanded.chunk_text, E'\n\n' order by expanded.document_id, expanded.chunk_index)
              from (
                select distinct dc.document_id, dc.chunk_index, dc.chunk_text
                from document_chunks selected
                join document_chunks dc
                  on dc.user_id = selected.user_id
                  and dc.subject_id = selected.subject_id
                  and dc.document_id = selected.document_id
                  and dc.chunk_index between selected.chunk_index - 1 and selected.chunk_index + 1
                where selected.id = any(q.source_chunk_ids)
              ) expanded
            ), '') as source_text,
            q.created_at
          from questions q
          where q.user_id = $1
            and q.subject_id = $2
            and q.type = any($3::text[])
          order by q.created_at desc
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
        keyPoints: row.key_points || [],
        evidenceQuote: row.evidence_quote || "",
        sourceChunkIds: row.source_chunk_ids || [],
        sourceText: row.source_text || "",
        sourceLocation: "原文出处",
      }));
    },

    async listQuestionsForSubject({ visitorId, subjectId, limit = 500 }) {
      if (!isUuid(subjectId)) return [];
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        `
          select
            q.id,
            q.subject_id,
            q.type,
            q.title,
            q.options,
            q.correct_answer,
            q.key_points,
            q.explanation,
            q.evidence_quote,
            q.source_chunk_ids,
            coalesce((
              select string_agg(expanded.chunk_text, E'\n\n' order by expanded.document_id, expanded.chunk_index)
              from (
                select distinct dc.document_id, dc.chunk_index, dc.chunk_text
                from document_chunks selected
                join document_chunks dc
                  on dc.user_id = selected.user_id
                  and dc.subject_id = selected.subject_id
                  and dc.document_id = selected.document_id
                  and dc.chunk_index between selected.chunk_index - 1 and selected.chunk_index + 1
                where selected.id = any(q.source_chunk_ids)
              ) expanded
            ), '') as source_text,
            q.created_at
          from questions q
          where q.user_id = $1
            and q.subject_id = $2
          order by q.created_at desc
          limit $3
        `,
        [userId, subjectId, limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        type: row.type,
        title: row.title,
        options: row.options,
        correctAnswer: row.correct_answer,
        explanation: row.explanation,
        keyPoints: row.key_points || [],
        evidenceQuote: row.evidence_quote || "",
        sourceChunkIds: row.source_chunk_ids || [],
        sourceText: row.source_text || "",
        sourceLocation: "原文出处",
        createdAt: row.created_at,
      }));
    },

    async deleteQuestionForSubject({ visitorId, subjectId, questionId }) {
      if (!isUuid(subjectId) || !isUuid(questionId)) return false;
      const userId = await getUserId(visitorId);
      const result = await pool.query(
        "delete from questions where user_id = $1 and subject_id = $2 and id = $3",
        [userId, subjectId, questionId],
      );
      if (result.rowCount > 0) {
        await pool.query(
          `
            update practice_sessions
            set question_ids = array_remove(question_ids, $3::uuid),
                question_count = greatest(question_count - 1, 0)
            where user_id = $1
              and subject_id = $2
              and $3::uuid = any(question_ids)
          `,
          [userId, subjectId, questionId],
        );
      }
      return result.rowCount > 0;
    },

    async getQuestionsByIds({ visitorId, subjectId, questionIds }) {
      if (!isUuid(subjectId)) return [];
      const userId = await getUserId(visitorId);
      if (!questionIds?.length) return [];
      const result = await pool.query(
        `
          select
            q.id,
            q.subject_id,
            q.type,
            q.title,
            q.options,
            q.correct_answer,
            q.key_points,
            q.explanation,
            q.evidence_quote,
            q.source_chunk_ids,
            coalesce((
              select string_agg(expanded.chunk_text, E'\n\n' order by expanded.document_id, expanded.chunk_index)
              from (
                select distinct dc.document_id, dc.chunk_index, dc.chunk_text
                from document_chunks selected
                join document_chunks dc
                  on dc.user_id = selected.user_id
                  and dc.subject_id = selected.subject_id
                  and dc.document_id = selected.document_id
                  and dc.chunk_index between selected.chunk_index - 1 and selected.chunk_index + 1
                where selected.id = any(q.source_chunk_ids)
              ) expanded
            ), '') as source_text,
            q.created_at
          from questions q
          where q.user_id = $1
            and q.subject_id = $2
            and q.id = any($3::uuid[])
          order by array_position($3::uuid[], q.id)
        `,
        [userId, subjectId, questionIds],
      );

      return result.rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        type: row.type,
        title: row.title,
        options: row.options,
        correctAnswer: row.correct_answer,
        explanation: row.explanation,
        keyPoints: row.key_points || [],
        evidenceQuote: row.evidence_quote || "",
        sourceChunkIds: row.source_chunk_ids || [],
        sourceText: row.source_text || row.evidence_quote || "",
        sourceLocation: "原文出处",
      }));
    },

    async searchChunks({ visitorId, subjectId, queryEmbedding, limit = 5 }) {
      if (!isUuid(subjectId)) return [];
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
      if (!isUuid(subjectId)) return [];
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
      if (!questions.length) return [];
      const userId = await getUserId(visitorId);
      const questionRows = questions.map((question) => ({
        ...question,
        id: UUID_PATTERN.test(String(question.id || "")) ? question.id : crypto.randomUUID(),
      }));

      const columns = [
        "id", "user_id", "subject_id", "type", "title", "options",
        "correct_answer", "key_points", "explanation", "evidence_quote",
        "source_chunk_ids", "document_hash",
      ];
      const columnCount = columns.length;
      const castByIndex = { 5: "::jsonb", 7: "::text[]", 10: "::uuid[]" };
      const params = [];
      const rowPlaceholders = questionRows.map((question, index) => {
        const offset = index * columnCount;
        params.push(
          question.id,
          userId,
          subjectId,
          question.type,
          question.title,
          question.options ? JSON.stringify(question.options) : null,
          question.correctAnswer,
          Array.isArray(question.keyPoints) ? question.keyPoints : [],
          question.explanation,
          question.evidenceQuote || "",
          question.sourceChunkIds,
          documentHash,
        );
        const placeholders = Array.from({ length: columnCount }, (_, col) => {
          const p = `$${offset + col + 1}`;
          return castByIndex[col] ? `${p}${castByIndex[col]}` : p;
        });
        return `(${placeholders.join(", ")})`;
      });

      const result = await pool.query(
        `
          insert into questions (${columns.join(", ")})
          values ${rowPlaceholders.join(", ")}
          returning id
        `,
        params,
      );

      return questionRows.map((question, index) => ({
        ...question,
        id: result.rows[index].id,
        subjectId,
      }));
    },

    async createPracticeSession({ visitorId, session }) {
      if (!isUuid(session.subjectId)) return session;
      const userId = await getUserId(visitorId);
      await pool.query(
        `
          insert into practice_sessions (
            id,
            user_id,
            subject_id,
            mode,
            question_types,
            question_ids,
            question_count
          )
          values ($1, $2, $3, $4, $5::text[], $6::uuid[], $7)
        `,
        [
          session.id,
          userId,
          session.subjectId,
          session.mode,
          Array.from(new Set(session.questions.map((question) => question.type))),
          session.questions.map((question) => question.id),
          session.questions.length,
        ],
      );
      return session;
    },

    async getPracticeSession({ visitorId, sessionId }) {
      const userId = await getUserId(visitorId);
      const sessionResult = await pool.query("select * from practice_sessions where user_id = $1 and id = $2 limit 1", [userId, sessionId]);
      const session = sessionResult.rows[0];
      if (!session) return null;

      const questionsResult = await pool.query(
        `
          select
            q.id,
            q.subject_id,
            q.type,
            q.title,
            q.options,
            q.correct_answer,
            q.key_points,
            q.explanation,
            q.evidence_quote,
            q.source_chunk_ids,
            coalesce((
              select string_agg(expanded.chunk_text, E'\n\n' order by expanded.document_id, expanded.chunk_index)
              from (
                select distinct dc.document_id, dc.chunk_index, dc.chunk_text
                from document_chunks selected
                join document_chunks dc
                  on dc.user_id = selected.user_id
                  and dc.subject_id = selected.subject_id
                  and dc.document_id = selected.document_id
                  and dc.chunk_index between selected.chunk_index - 1 and selected.chunk_index + 1
                where selected.id = any(q.source_chunk_ids)
              ) expanded
            ), '') as source_text,
            q.created_at
          from questions q
          where q.user_id = $1
            and q.id = any($2::uuid[])
          order by array_position($2::uuid[], q.id)
        `,
        [userId, session.question_ids],
      );
      const questions = questionsResult.rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        type: row.type,
        title: row.title,
        options: row.options,
        correctAnswer: row.correct_answer,
        explanation: row.explanation,
        keyPoints: row.key_points || [],
        evidenceQuote: row.evidence_quote || "",
        sourceChunkIds: row.source_chunk_ids || [],
        sourceText: row.source_text || "",
        sourceLocation: "原文出处",
      }));
      const questionIndexById = new Map(questions.map((question, index) => [question.id, index]));

      const answersResult = await pool.query(
        `
          select
            id,
            session_id,
            question_id,
            subject_id,
            user_answer,
            result,
            created_at
          from answers
          where user_id = $1
            and session_id = $2
          order by created_at asc
        `,
        [userId, sessionId],
      );
      const answers = answersResult.rows.map((row) => {
        const questionIndex = questionIndexById.get(row.question_id) ?? 0;
        return {
          id: row.id,
          sessionId: row.session_id,
          questionId: row.question_id,
          subjectId: row.subject_id,
          questionIndex,
          question: questions[questionIndex],
          userAnswer: row.user_answer,
          result: row.result,
          createdAt: row.created_at,
        };
      });

      return {
        id: session.id,
        subjectId: session.subject_id,
        mode: session.mode,
        questions,
        answers,
        currentIndex: firstUnansweredIndex(questions, answers),
        retryMistakeIds: [],
        createdAt: session.started_at,
        completedAt: session.completed_at,
        summary: session.completed_at
          ? {
              total: session.question_count,
              answeredCount: session.answered_count,
              skippedCount: session.skipped_count,
              correctCount: session.correct_count,
              rate: session.accuracy_rate,
              mistakeCount: session.wrong_count,
            }
          : null,
      };
    },

    async saveAnswer({ visitorId, sessionId, question, answer, result }) {
      if (!isUuid(question.subjectId)) return { id: `ans_local_${Date.now()}`, createdAt: new Date().toISOString() };
      const userId = await getUserId(visitorId);
      await pool.query(
        `
          insert into questions (
            id,
            user_id,
            subject_id,
            type,
            title,
            options,
            correct_answer,
            key_points,
            explanation,
            evidence_quote,
            source_chunk_ids,
            document_hash
          )
          values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11::uuid[], $12)
          on conflict (id) do nothing
        `,
        [
          question.id,
          userId,
          question.subjectId,
          question.type,
          question.title,
          question.options ? JSON.stringify(question.options) : null,
          question.correctAnswer,
          Array.isArray(question.keyPoints) ? question.keyPoints : [],
          question.explanation || "",
          question.evidenceQuote || "",
          Array.isArray(question.sourceChunkIds) ? question.sourceChunkIds : [],
          question.documentHash || null,
        ],
      );
      await pool.query("delete from answers where user_id = $1 and session_id = $2 and question_id = $3", [userId, sessionId, question.id]);
      const saved = await pool.query(
        `
          insert into answers (
            user_id,
            session_id,
            subject_id,
            question_id,
            user_answer,
            is_correct,
            accuracy,
            result
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          returning id, created_at
        `,
        [
          userId,
          sessionId,
          question.subjectId,
          question.id,
          answer,
          Boolean(result.isCorrect),
          Number(result.accuracy ?? (result.isCorrect ? 1 : 0)),
          JSON.stringify(result),
        ],
      );

      if (!result.isCorrect) {
        await pool.query(
          `
            insert into mistakes (user_id, subject_id, question_id, last_answer_id, attempts)
            values ($1, $2, $3, $4, 1)
            on conflict (user_id, question_id)
            do update set
              last_answer_id = excluded.last_answer_id,
              attempts = mistakes.attempts + 1,
              updated_at = now()
          `,
          [userId, question.subjectId, question.id, saved.rows[0].id],
        );
      } else {
        await pool.query("delete from mistakes where user_id = $1 and question_id = $2", [userId, question.id]);
      }

      return {
        id: saved.rows[0].id,
        createdAt: saved.rows[0].created_at,
      };
    },

    async deleteSessionAnswer({ visitorId, sessionId, questionId }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query("delete from answers where user_id = $1 and session_id = $2 and question_id = $3", [userId, sessionId, questionId]);
      return result.rowCount > 0;
    },

    async finishPracticeSession({ visitorId, sessionId, summary }) {
      const userId = await getUserId(visitorId);
      await pool.query(
        `
          update practice_sessions
          set
            answered_count = $3,
            skipped_count = $4,
            correct_count = $5,
            wrong_count = $6,
            accuracy_rate = $7,
            completed_at = coalesce(completed_at, now())
          where user_id = $1 and id = $2
        `,
        [
          userId,
          sessionId,
          summary.answeredCount,
          summary.skippedCount,
          summary.correctCount,
          summary.mistakeCount,
          summary.rate,
        ],
      );
    },

    async listMistakes({ visitorId, subjectId }) {
      const userId = await getUserId(visitorId);
      const params = [userId];
      const subjectFilter = subjectId ? "and m.subject_id = $2" : "";
      if (subjectId) params.push(subjectId);
      const result = await pool.query(
        `
          select
            m.id,
            m.subject_id,
            m.attempts,
            m.updated_at,
            q.id as question_id,
            q.type,
            q.title,
            q.options,
            q.correct_answer,
            q.key_points,
            q.explanation,
            q.evidence_quote,
            q.source_chunk_ids,
            coalesce((
              select string_agg(expanded.chunk_text, E'\n\n' order by expanded.document_id, expanded.chunk_index)
              from (
                select distinct dc.document_id, dc.chunk_index, dc.chunk_text
                from document_chunks selected
                join document_chunks dc
                  on dc.user_id = selected.user_id
                  and dc.subject_id = selected.subject_id
                  and dc.document_id = selected.document_id
                  and dc.chunk_index between selected.chunk_index - 1 and selected.chunk_index + 1
                where selected.id = any(q.source_chunk_ids)
              ) expanded
            ), '') as source_text,
            a.user_answer,
            a.result,
            a.accuracy,
            a.created_at as answer_created_at
          from mistakes m
          join questions q on q.id = m.question_id
          left join answers a on a.id = m.last_answer_id
          where m.user_id = $1
            ${subjectFilter}
          order by m.updated_at desc
        `,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        question: {
          id: row.question_id,
          subjectId: row.subject_id,
          type: row.type,
          title: row.title,
          options: row.options,
          correctAnswer: row.correct_answer,
          keyPoints: row.key_points || [],
          explanation: row.explanation,
          evidenceQuote: row.evidence_quote || "",
          sourceChunkIds: row.source_chunk_ids || [],
          sourceText: row.source_text || "",
          sourceLocation: "原文出处",
        },
        lastAnswer: row.user_answer || "",
        lastResult: row.result || {},
        lastAccuracy: Number(row.accuracy ?? row.result?.accuracy ?? 0),
        attempts: Number(row.attempts || 1),
        createdAt: row.answer_created_at || row.updated_at,
        updatedAt: row.updated_at,
      }));
    },

    async deleteMistake({ visitorId, mistakeId }) {
      const userId = await getUserId(visitorId);
      const result = await pool.query("delete from mistakes where user_id = $1 and id = $2", [userId, mistakeId]);
      return result.rowCount > 0;
    },

    async getAdminMetrics() {
      const realUserFilter = `
        email is not null
        and email <> ''
        and lower(email) !~ '^(codex-test-|metrics-test-).*@example\\.com$'
      `;
      const [dataTrustResult, totalsResult, todayResult, funnelResult, volumeResult, qualityResult, sourceResult, eventBreakdownResult, dailyActivityResult] = await Promise.all([
        pool.query(`
          select
            count(*)::int as all_users,
            count(distinct lower(email)) filter (where ${realUserFilter})::int as real_registered_users,
            count(*) filter (where email is null or email = '' or nickname like 'visitor:%')::int as legacy_users,
            count(*) filter (where lower(coalesce(email, '')) ~ '^(codex-test-|metrics-test-).*@example\\.com$')::int as test_users
          from users
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select
            (select count(*) from real_users) as users,
            (select count(*) from subjects where user_id in (select id from real_users)) as subjects,
            (select count(*) from documents where user_id in (select id from real_users)) as documents,
            (select count(*) from questions where user_id in (select id from real_users)) as questions,
            (select count(*) from practice_sessions where user_id in (select id from real_users)) as sessions,
            (select count(*) from answers where user_id in (select id from real_users)) as answers,
            (select count(*) from mistakes where user_id in (select id from real_users)) as mistakes
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select
            (select count(*) from real_users ru join users u on u.id = ru.id where u.created_at >= current_date) as registered_users,
            (select count(distinct user_id) from analytics_events where created_at >= current_date and user_id in (select id from real_users)) as active_users,
            (select count(*) from documents where created_at >= current_date and user_id in (select id from real_users)) as uploads,
            (select count(*) from practice_sessions where started_at >= current_date and user_id in (select id from real_users)) as practice_started,
            (select count(*) from practice_sessions where completed_at >= current_date and user_id in (select id from real_users)) as practice_completed,
            (select count(*) from answers where created_at >= current_date and user_id in (select id from real_users)) as answers,
            (select count(*) from analytics_events where created_at >= current_date and user_id in (select id from real_users)) as events
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          ),
          steps as (
            select
              (select count(*) from real_users) as registered_users,
              (select count(distinct user_id) from documents where user_id in (select id from real_users)) as uploaded_users,
              (select count(distinct user_id) from practice_sessions where user_id in (select id from real_users)) as practice_started_users,
              (select count(distinct user_id) from practice_sessions where completed_at is not null and user_id in (select id from real_users)) as practice_completed_users,
              (select count(distinct user_id) from answers where user_id in (select id from real_users)) as answered_users,
              (select count(distinct user_id) from mistakes where user_id in (select id from real_users)) as mistake_users,
              (select count(distinct user_id) from analytics_events where event_name = 'mistakes_viewed' and user_id in (select id from real_users)) as mistake_viewed_users,
              (select count(distinct user_id) from analytics_events where event_name = 'mistake_retry_started' and user_id in (select id from real_users)) as mistake_retry_users
          )
          select * from steps
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select
            (select count(*) from documents where user_id in (select id from real_users)) as uploads,
            (select count(*) from questions where user_id in (select id from real_users)) as questions,
            (select count(*) from practice_sessions where user_id in (select id from real_users)) as practice_started,
            (select count(*) from practice_sessions where completed_at is not null and user_id in (select id from real_users)) as practice_completed,
            (select count(*) from answers where user_id in (select id from real_users)) as answers,
            (select count(*) from mistakes where user_id in (select id from real_users)) as mistakes,
            (select count(*) from analytics_events where event_name = 'upload_clicked' and user_id in (select id from real_users)) as upload_clicks,
            (select count(*) from analytics_events where event_name = 'upload_succeeded' and user_id in (select id from real_users)) as upload_success_events,
            (select count(*) from analytics_events where event_name = 'upload_failed' and user_id in (select id from real_users)) as upload_failures,
            (select count(*) from analytics_events where event_name = 'mistakes_viewed' and user_id in (select id from real_users)) as mistake_views,
            (select count(*) from analytics_events where event_name = 'mistake_retry_started' and user_id in (select id from real_users)) as mistake_retries,
            (select count(*) from analytics_events where event_name like '%mistakes_clicked' and user_id in (select id from real_users)) as mistake_entry_clicks
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select
            (select count(*) from practice_sessions where user_id in (select id from real_users)) as total_sessions,
            (select count(*) from practice_sessions where completed_at is not null and user_id in (select id from real_users)) as completed_sessions,
            (select coalesce(round(100.0 * count(*) filter (where completed_at is not null) / nullif(count(*), 0)), 0)
               from practice_sessions
              where user_id in (select id from real_users)) as completion_rate,
            (select coalesce(round(avg(accuracy_rate) filter (where completed_at is not null)), 0)
               from practice_sessions
              where user_id in (select id from real_users)) as average_accuracy,
            (select coalesce(round(100.0 * count(*) filter (where is_correct = false) / nullif(count(*), 0)), 0)
               from answers
              where user_id in (select id from real_users)) as wrong_answer_rate
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select event_name, count(*) as count, count(distinct user_id) as users
          from analytics_events
          where user_id in (select id from real_users)
            and event_name in (
              'bottom_nav_mistakes_clicked',
              'summary_mistakes_clicked',
              'summary_mistakes_cta_viewed',
              'home_mistakes_clicked',
              'subject_mistakes_clicked',
              'mistakes_viewed',
              'mistake_retry_started'
            )
          group by event_name
          order by count desc, event_name asc
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select event_name, count(*) as count
          from analytics_events
          where created_at >= now() - interval '7 days'
            and user_id in (select id from real_users)
          group by event_name
          order by count desc, event_name asc
          limit 12
        `),
        pool.query(`
          with real_users as (
            select id from users where ${realUserFilter}
          )
          select
            to_char(days.day, 'MM-DD') as date,
            count(distinct e.user_id) filter (where e.user_id is not null) as active_users,
            count(e.id) as events,
            count(a.id) as answers
          from generate_series(current_date - interval '6 days', current_date, interval '1 day') days(day)
          left join analytics_events e
            on e.created_at >= days.day
           and e.created_at < days.day + interval '1 day'
           and e.user_id in (select id from real_users)
          left join answers a
            on a.created_at >= days.day
           and a.created_at < days.day + interval '1 day'
           and a.user_id in (select id from real_users)
          group by days.day
          order by days.day asc
        `),
      ]);

      const dataTrust = dataTrustResult.rows[0];
      const totals = totalsResult.rows[0];
      const today = todayResult.rows[0];
      const funnel = funnelResult.rows[0];
      const volume = volumeResult.rows[0];
      const quality = qualityResult.rows[0];
      const number = (value) => Number(value || 0);
      const rate = (part, whole) => (number(whole) ? Math.round((number(part) / number(whole)) * 100) : 0);
      const funnelSteps = [
        { name: "注册用户", value: number(funnel.registered_users) },
        { name: "上传用户", value: number(funnel.uploaded_users) },
        { name: "开练用户", value: number(funnel.practice_started_users) },
        { name: "完成用户", value: number(funnel.practice_completed_users) },
        { name: "答题用户", value: number(funnel.answered_users) },
      ];

      return {
        generatedAt: new Date().toISOString(),
        dataTrust: {
          allUsers: number(dataTrust.all_users),
          realRegisteredUsers: number(dataTrust.real_registered_users),
          legacyUsersExcluded: number(dataTrust.legacy_users),
          testUsersExcluded: number(dataTrust.test_users),
        },
        totals: {
          users: number(totals.users),
          subjects: number(totals.subjects),
          documents: number(totals.documents),
          questions: number(totals.questions),
          sessions: number(totals.sessions),
          answers: number(totals.answers),
          mistakes: number(totals.mistakes),
        },
        today: {
          registeredUsers: number(today.registered_users),
          activeUsers: number(today.active_users),
          uploads: number(today.uploads),
          practiceStarted: number(today.practice_started),
          practiceCompleted: number(today.practice_completed),
          answers: number(today.answers),
          events: number(today.events),
        },
        practice: {
          totalSessions: number(quality.total_sessions),
          completedSessions: number(quality.completed_sessions),
          completionRate: number(quality.completion_rate),
          averageAccuracy: number(quality.average_accuracy),
          wrongAnswerRate: number(quality.wrong_answer_rate),
        },
        userFunnel: funnelSteps.map((step, index) => ({
          ...step,
          conversionRate: index === 0 ? 100 : rate(step.value, funnelSteps[index - 1].value),
        })),
        behaviorVolume: {
          uploads: number(volume.uploads),
          questions: number(volume.questions),
          practiceStarted: number(volume.practice_started),
          practiceCompleted: number(volume.practice_completed),
          answers: number(volume.answers),
          mistakes: number(volume.mistakes),
          uploadClicks: number(volume.upload_clicks),
          uploadSuccessEvents: number(volume.upload_success_events),
          uploadFailures: number(volume.upload_failures),
          mistakeViews: number(volume.mistake_views),
          mistakeRetries: number(volume.mistake_retries),
          mistakeEntryClicks: number(volume.mistake_entry_clicks),
        },
        scenarioMetricGroups: [
          {
            id: "upload",
            title: "上传链路",
            primaryMetric: "用户数、次数、成功与失败",
            checks: [
              { label: "注册到上传转化率", value: `${rate(funnel.uploaded_users, funnel.registered_users)}%` },
              { label: "上传按钮点击", value: number(volume.upload_clicks) },
              { label: "上传成功事件", value: number(volume.upload_success_events) },
              { label: "上传失败事件", value: number(volume.upload_failures) },
            ],
          },
          {
            id: "practice",
            title: "练习链路",
            primaryMetric: "开练用户、生成题量与练习次数",
            checks: [
              { label: "上传到开练转化率", value: `${rate(funnel.practice_started_users, funnel.uploaded_users)}%` },
              { label: "生成题目数", value: number(volume.questions) },
              { label: "开始练习次数", value: number(volume.practice_started) },
              { label: "完成练习次数", value: number(volume.practice_completed) },
            ],
          },
          {
            id: "completion",
            title: "练习完成",
            primaryMetric: "完成率、答题量与学习质量",
            checks: [
              { label: "练习完成率", value: `${number(quality.completion_rate)}%` },
              { label: "提交答案数", value: number(volume.answers) },
              { label: "平均正确率", value: `${number(quality.average_accuracy)}%` },
              { label: "错答率", value: `${number(quality.wrong_answer_rate)}%` },
            ],
          },
          {
            id: "mistakes",
            title: "错题链路",
            primaryMetric: "错题产生、访问与复练",
            checks: [
              { label: "产生错题用户", value: number(funnel.mistake_users) },
              { label: "访问错题用户", value: number(funnel.mistake_viewed_users) },
              { label: "错题访问次数", value: number(volume.mistake_views) },
              { label: "错题复练次数", value: number(volume.mistake_retries) },
            ],
          },
        ],
        mistakeEntrySources: sourceResult.rows.map((row) => ({
          name: row.event_name,
          count: number(row.count),
          users: number(row.users),
        })),
        eventBreakdown: eventBreakdownResult.rows.map((row) => ({
          name: row.event_name,
          count: number(row.count),
        })),
        dailyActivity: dailyActivityResult.rows.map((row) => ({
          date: row.date,
          activeUsers: number(row.active_users),
          events: number(row.events),
          answers: number(row.answers),
        })),
      };
    },

    async listAdminEvents({ limit = 50 } = {}) {
      const realUserFilter = `
        email is not null
        and email <> ''
        and lower(email) !~ '^(codex-test-|metrics-test-).*@example\\.com$'
      `;
      const result = await pool.query(
        `
          select
            e.id,
            e.event_name,
            e.page_path,
            e.session_id,
            e.properties,
            e.created_at,
            u.email,
            u.nickname
          from analytics_events e
          join users u on u.id = e.user_id
          where ${realUserFilter}
          order by e.created_at desc
          limit $1
        `,
        [Math.min(100, Math.max(1, Number(limit) || 50))],
      );

      return result.rows.map((row) => ({
        id: row.id,
        eventName: row.event_name,
        pagePath: row.page_path || "",
        sessionId: row.session_id || "",
        properties: row.properties || {},
        createdAt: row.created_at,
        user: {
          email: row.email || "",
          nickname: row.nickname || "",
        },
      }));
    },

    async saveAnalyticsEvent({ visitorId, eventName, sessionId, pagePath, properties, userAgent }) {
      const userId = visitorId ? await getUserId(visitorId) : null;
      await pool.query(
        `
          insert into analytics_events (user_id, session_id, event_name, page_path, properties, user_agent)
          values ($1, $2, $3, $4, $5::jsonb, $6)
        `,
        [userId, sessionId || null, eventName, pagePath || "", JSON.stringify(properties || {}), userAgent || ""],
      );
    },
  };
}
