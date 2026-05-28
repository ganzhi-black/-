import { cosineSimilarity } from "./embeddings.js";

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeVisitorId(visitorId) {
  return String(visitorId || "anonymous-public").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80) || "anonymous-public";
}

function firstUnansweredIndex(questions, sessionAnswers) {
  const answeredIndexes = new Set(sessionAnswers.map((answer) => answer.questionIndex));
  const nextIndex = questions.findIndex((_, index) => !answeredIndexes.has(index));
  return nextIndex >= 0 ? nextIndex : Math.max(0, questions.length - 1);
}

export function createMemoryStore() {
  const users = [];
  const authSessions = [];
  const subjects = [];
  const documents = [];
  const chunks = [];
  const savedQuestions = [];
  const practiceSessions = [];
  const answers = [];
  const mistakes = [];
  const analyticsEvents = [];

  return {
    claimVisitorData({ visitorId, userId }) {
      const ownerId = normalizeVisitorId(visitorId);
      if (!visitorId || !userId || ownerId === userId) return { claimed: false };

      const collections = [subjects, documents, chunks, savedQuestions, practiceSessions, answers, mistakes, analyticsEvents];
      let claimedCount = 0;
      for (const collection of collections) {
        for (const item of collection) {
          if (item.visitorId === ownerId) {
            item.visitorId = userId;
            claimedCount += 1;
          }
        }
      }
      return { claimed: claimedCount > 0, counts: { records: claimedCount } };
    },

    claimSubjectData({ subjectIds, userId }) {
      const subjectIdSet = new Set((subjectIds || []).filter(Boolean));
      if (!subjectIdSet.size || !userId) return { claimed: false };

      const collections = [subjects, documents, chunks, savedQuestions, practiceSessions, answers, mistakes];
      let claimedCount = 0;
      for (const collection of collections) {
        for (const item of collection) {
          if (subjectIdSet.has(item.subjectId || item.id) && item.visitorId !== userId) {
            item.visitorId = userId;
            claimedCount += 1;
          }
        }
      }
      return { claimed: claimedCount > 0, subjectIds: [...subjectIdSet], counts: { records: claimedCount } };
    },

    createUser({ email, passwordHash, nickname }) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      if (users.some((user) => user.email === normalizedEmail)) {
        const error = new Error("Email already exists.");
        error.code = "23505";
        throw error;
      }
      const user = {
        id: uid("usr"),
        email: normalizedEmail,
        password_hash: passwordHash,
        nickname: nickname || normalizedEmail.split("@")[0],
        created_at: new Date().toISOString(),
      };
      users.push(user);
      return user;
    },

    getUserByEmail(email) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      return users.find((user) => user.email === normalizedEmail) || null;
    },

    getUserById(userId) {
      const user = users.find((item) => item.id === userId);
      return user ? { id: user.id, email: user.email, nickname: user.nickname, created_at: user.created_at } : null;
    },

    createAuthSession({ userId, tokenHash, expiresAt, userAgent, ipAddress }) {
      authSessions.push({ id: uid("auth"), user_id: userId, token_hash: tokenHash, expires_at: expiresAt, user_agent: userAgent, ip_address: ipAddress });
    },

    getAuthSession(tokenHash) {
      const session = authSessions.find((item) => item.token_hash === tokenHash && new Date(item.expires_at).getTime() > Date.now());
      if (!session) return null;
      const user = users.find((item) => item.id === session.user_id);
      if (!user) return null;
      return {
        id: user.id,
        session_id: session.id,
        user_id: user.id,
        email: user.email,
        nickname: user.nickname,
        created_at: user.created_at,
      };
    },

    deleteAuthSession(tokenHash) {
      const index = authSessions.findIndex((item) => item.token_hash === tokenHash);
      if (index >= 0) authSessions.splice(index, 1);
    },

    createSubject({ visitorId, name }) {
      const ownerId = normalizeVisitorId(visitorId);
      const subject = {
        id: uid("sub"),
        visitorId: ownerId,
        name,
        createdAt: new Date().toISOString(),
      };
      subjects.unshift(subject);
      return subject;
    },

    listSubjects({ visitorId } = {}) {
      const ownerId = normalizeVisitorId(visitorId);
      return subjects.filter((subject) => subject.visitorId === ownerId).map((subject) => ({
        ...subject,
        documentCount: documents.filter((document) => document.subjectId === subject.id).length,
        chunkCount: chunks.filter((chunk) => chunk.subjectId === subject.id).length,
      }));
    },

    getSubject({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const subject = subjects.find((item) => item.id === subjectId && item.visitorId === ownerId);
      if (!subject) return null;
      const subjectDocuments = documents.filter((document) => document.subjectId === subjectId);
      const latestDocument = subjectDocuments[0];
      return {
        ...subject,
        sourceFileName: latestDocument?.fileName || "",
        sourceFileSize: latestDocument?.size || 0,
        documentCount: subjectDocuments.length,
        chunkCount: chunks.filter((chunk) => chunk.subjectId === subjectId).length,
      };
    },

    deleteSubject({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const index = subjects.findIndex((item) => item.id === subjectId && item.visitorId === ownerId);
      if (index < 0) return false;
      subjects.splice(index, 1);
      for (let i = documents.length - 1; i >= 0; i -= 1) {
        if (documents[i].subjectId === subjectId) documents.splice(i, 1);
      }
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        if (chunks[i].subjectId === subjectId) chunks.splice(i, 1);
      }
      return true;
    },

    createDocument(documentInput) {
      const document = {
        id: uid("doc"),
        visitorId: normalizeVisitorId(documentInput.visitorId),
        ...documentInput,
        createdAt: new Date().toISOString(),
      };
      documents.unshift(document);
      return document;
    },

    getDocumentHashesForSubject({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      return Array.from(
        new Set(
          documents
            .filter((document) => document.visitorId === ownerId && document.subjectId === subjectId && document.contentHash)
            .map((document) => document.contentHash),
        ),
      );
    },

    getPriorQuestionsByDocumentHashes({ visitorId, documentHashes, types, limit = 500 }) {
      if (!documentHashes?.length) return [];
      const ownerId = normalizeVisitorId(visitorId);
      const hashSet = new Set(documentHashes);
      return savedQuestions
        .filter((question) => question.visitorId === ownerId && hashSet.has(question.documentHash) && types.includes(question.type))
        .slice(-limit)
        .reverse()
        .map((question) => ({ title: question.title, type: question.type }));
    },

    addChunks(input) {
      const chunkInputs = Array.isArray(input) ? input : input.chunks;
      const ownerId = normalizeVisitorId(Array.isArray(input) ? undefined : input.visitorId);
      const saved = chunkInputs.map((chunk) => ({
        id: uid("chk"),
        visitorId: ownerId,
        ...chunk,
        createdAt: new Date().toISOString(),
      }));
      chunks.push(...saved);
      return saved;
    },

    searchChunks({ visitorId, subjectId, queryEmbedding, limit = 5 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return chunks
        .filter((chunk) => chunk.visitorId === ownerId && chunk.subjectId === subjectId)
        .map((chunk) => ({
          ...chunk,
          score: Number(cosineSimilarity(queryEmbedding, chunk.embedding).toFixed(4)),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },

    listChunks({ visitorId, subjectId, limit = 1000 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return chunks
        .filter((chunk) => chunk.visitorId === ownerId && chunk.subjectId === subjectId)
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .slice(0, limit);
    },

    saveQuestions({ visitorId, subjectId, questions, documentHash = null }) {
      const ownerId = normalizeVisitorId(visitorId);
      const saved = questions.map((question) => ({
        ...question,
        id: question.id || uid("q"),
        visitorId: ownerId,
        subjectId,
        documentHash,
      }));
      savedQuestions.push(...saved);
      return saved;
    },

    getRecentQuestions({ visitorId, subjectId, types, limit = 30 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return savedQuestions
        .filter((question) => question.visitorId === ownerId && question.subjectId === subjectId && types.includes(question.type))
        .slice(-limit)
        .reverse();
    },

    listQuestionsForSubject({ visitorId, subjectId, limit = 500 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return savedQuestions
        .filter((question) => question.visitorId === ownerId && question.subjectId === subjectId)
        .slice(-limit)
        .reverse();
    },

    deleteQuestionForSubject({ visitorId, subjectId, questionId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const index = savedQuestions.findIndex((question) => question.visitorId === ownerId && question.subjectId === subjectId && question.id === questionId);
      if (index < 0) return false;
      savedQuestions.splice(index, 1);

      for (let answerIndex = answers.length - 1; answerIndex >= 0; answerIndex -= 1) {
        if (answers[answerIndex].visitorId === ownerId && answers[answerIndex].subjectId === subjectId && answers[answerIndex].questionId === questionId) {
          answers.splice(answerIndex, 1);
        }
      }

      for (let mistakeIndex = mistakes.length - 1; mistakeIndex >= 0; mistakeIndex -= 1) {
        if (mistakes[mistakeIndex].visitorId === ownerId && mistakes[mistakeIndex].subjectId === subjectId && mistakes[mistakeIndex].questionId === questionId) {
          mistakes.splice(mistakeIndex, 1);
        }
      }

      for (const session of practiceSessions.filter((item) => item.visitorId === ownerId && item.subjectId === subjectId)) {
        session.questions = (session.questions || []).filter((question) => question.id !== questionId);
        session.questionIds = (session.questionIds || []).filter((id) => id !== questionId);
      }

      return true;
    },

    getQuestionsByIds({ visitorId, subjectId, questionIds }) {
      const ownerId = normalizeVisitorId(visitorId);
      const questionIdSet = new Set(questionIds || []);
      return savedQuestions
        .filter((question) => question.visitorId === ownerId && question.subjectId === subjectId && questionIdSet.has(question.id))
        .sort((left, right) => questionIds.indexOf(left.id) - questionIds.indexOf(right.id));
    },

    createPracticeSession({ visitorId, session }) {
      practiceSessions.push({
        ...session,
        visitorId: normalizeVisitorId(visitorId),
        questionIds: session.questions.map((question) => question.id),
        completedAt: null,
        summary: null,
      });
      return session;
    },

    getPracticeSession({ visitorId, sessionId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const session = practiceSessions.find((item) => item.visitorId === ownerId && item.id === sessionId);
      if (!session) return null;
      const sessionAnswers = answers.filter((answer) => answer.visitorId === ownerId && answer.sessionId === sessionId);
      return {
        ...session,
        answers: sessionAnswers,
        currentIndex: firstUnansweredIndex(session.questions, sessionAnswers),
      };
    },

    saveAnswer({ visitorId, sessionId, question, answer, result }) {
      const ownerId = normalizeVisitorId(visitorId);
      for (let index = answers.length - 1; index >= 0; index -= 1) {
        if (answers[index].visitorId === ownerId && answers[index].sessionId === sessionId && answers[index].questionId === question.id) {
          answers.splice(index, 1);
        }
      }
      const session = practiceSessions.find((item) => item.visitorId === ownerId && item.id === sessionId);
      const questionIndex = session?.questions?.findIndex((item) => item.id === question.id) ?? 0;
      const record = {
        id: uid("ans"),
        visitorId: ownerId,
        sessionId,
        questionId: question.id,
        subjectId: question.subjectId,
        questionIndex: questionIndex >= 0 ? questionIndex : 0,
        question,
        userAnswer: answer,
        result,
        createdAt: new Date().toISOString(),
      };
      answers.push(record);

      const index = mistakes.findIndex((item) => item.visitorId === ownerId && item.questionId === question.id);
      if (!result.isCorrect) {
        if (index >= 0) {
          mistakes[index] = { ...mistakes[index], lastAnswerId: record.id, attempts: mistakes[index].attempts + 1, updatedAt: new Date().toISOString() };
        } else {
          mistakes.push({ id: uid("m"), visitorId: ownerId, subjectId: question.subjectId, questionId: question.id, lastAnswerId: record.id, attempts: 1 });
        }
      } else if (index >= 0) {
        mistakes.splice(index, 1);
      }

      return { id: record.id, createdAt: record.createdAt };
    },

    deleteSessionAnswer({ visitorId, sessionId, questionId }) {
      const ownerId = normalizeVisitorId(visitorId);
      let deleted = false;
      for (let index = answers.length - 1; index >= 0; index -= 1) {
        if (answers[index].visitorId === ownerId && answers[index].sessionId === sessionId && answers[index].questionId === questionId) {
          answers.splice(index, 1);
          deleted = true;
        }
      }
      return deleted;
    },

    finishPracticeSession({ visitorId, sessionId, summary }) {
      const ownerId = normalizeVisitorId(visitorId);
      const session = practiceSessions.find((item) => item.visitorId === ownerId && item.id === sessionId);
      if (session) {
        session.completedAt = new Date().toISOString();
        session.summary = summary;
      }
    },

    listMistakes({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      return mistakes
        .filter((mistake) => mistake.visitorId === ownerId && (!subjectId || mistake.subjectId === subjectId))
        .map((mistake) => {
          const answer = answers.find((item) => item.id === mistake.lastAnswerId);
          const question = savedQuestions.find((item) => item.id === mistake.questionId) || answer?.question || {};
          return {
            id: mistake.id,
            subjectId: mistake.subjectId,
            question,
            lastAnswer: answer?.userAnswer || "",
            lastResult: answer?.result || {},
            lastAccuracy: answer?.result?.accuracy ?? 0,
            attempts: mistake.attempts,
            createdAt: answer?.createdAt || mistake.updatedAt,
            updatedAt: mistake.updatedAt,
          };
        });
    },

    deleteMistake({ visitorId, mistakeId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const index = mistakes.findIndex((item) => item.visitorId === ownerId && item.id === mistakeId);
      if (index < 0) return false;
      mistakes.splice(index, 1);
      return true;
    },

    getAdminMetrics() {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const todayTime = startOfToday.getTime();
      const isToday = (value) => new Date(value).getTime() >= todayTime;
      const recentEvents = analyticsEvents.filter((event) => new Date(event.createdAt).getTime() >= sevenDaysAgo);
      const completedSessions = practiceSessions.filter((session) => session.completedAt);
      const averageAccuracy = completedSessions.length
        ? Math.round(completedSessions.reduce((sum, session) => sum + Number(session.summary?.rate || 0), 0) / completedSessions.length)
        : 0;
      const eventCounts = recentEvents.reduce((counts, event) => {
        counts.set(event.eventName, (counts.get(event.eventName) || 0) + 1);
        return counts;
      }, new Map());
      const activeUsersToday = new Set(analyticsEvents.filter((event) => isToday(event.createdAt) && event.visitorId).map((event) => event.visitorId));

      return {
        generatedAt: new Date().toISOString(),
        dataTrust: {
          allUsers: users.length,
          realRegisteredUsers: users.filter((user) => user.email && !/^(codex-test-|metrics-test-).*@example\.com$/i.test(user.email)).length,
          legacyUsersExcluded: users.filter((user) => !user.email || user.nickname?.startsWith("visitor:")).length,
          testUsersExcluded: users.filter((user) => /^(codex-test-|metrics-test-).*@example\.com$/i.test(user.email || "")).length,
        },
        totals: {
          users: users.length,
          subjects: subjects.length,
          documents: documents.length,
          questions: savedQuestions.length,
          sessions: practiceSessions.length,
          answers: answers.length,
          mistakes: mistakes.length,
        },
        today: {
          registeredUsers: users.filter((user) => isToday(user.created_at)).length,
          activeUsers: activeUsersToday.size,
          uploads: documents.filter((document) => isToday(document.createdAt)).length,
          practiceStarted: practiceSessions.filter((session) => isToday(session.createdAt)).length,
          practiceCompleted: practiceSessions.filter((session) => session.completedAt && isToday(session.completedAt)).length,
          answers: answers.filter((answer) => isToday(answer.createdAt)).length,
          events: analyticsEvents.filter((event) => isToday(event.createdAt)).length,
        },
        practice: {
          totalSessions: practiceSessions.length,
          completedSessions: completedSessions.length,
          completionRate: practiceSessions.length ? Math.round((completedSessions.length / practiceSessions.length) * 100) : 0,
          averageAccuracy,
        },
        userFunnel: [
          { name: "注册用户", value: users.length, conversionRate: 100 },
          { name: "上传用户", value: new Set(documents.map((item) => item.visitorId)).size, conversionRate: users.length ? Math.round((new Set(documents.map((item) => item.visitorId)).size / users.length) * 100) : 0 },
          { name: "开练用户", value: new Set(practiceSessions.map((item) => item.visitorId)).size, conversionRate: documents.length ? Math.round((new Set(practiceSessions.map((item) => item.visitorId)).size / Math.max(1, new Set(documents.map((item) => item.visitorId)).size)) * 100) : 0 },
          { name: "完成用户", value: new Set(completedSessions.map((item) => item.visitorId)).size, conversionRate: practiceSessions.length ? Math.round((new Set(completedSessions.map((item) => item.visitorId)).size / Math.max(1, new Set(practiceSessions.map((item) => item.visitorId)).size)) * 100) : 0 },
          { name: "答题用户", value: new Set(answers.map((item) => item.visitorId)).size, conversionRate: completedSessions.length ? Math.round((new Set(answers.map((item) => item.visitorId)).size / Math.max(1, new Set(completedSessions.map((item) => item.visitorId)).size)) * 100) : 0 },
        ],
        behaviorVolume: {
          uploads: documents.length,
          questions: savedQuestions.length,
          practiceStarted: practiceSessions.length,
          practiceCompleted: completedSessions.length,
          answers: answers.length,
          mistakes: mistakes.length,
          uploadClicks: analyticsEvents.filter((event) => event.eventName === "upload_clicked").length,
          uploadSuccessEvents: analyticsEvents.filter((event) => event.eventName === "upload_succeeded").length,
          uploadFailures: analyticsEvents.filter((event) => event.eventName === "upload_failed").length,
          mistakeViews: analyticsEvents.filter((event) => event.eventName === "mistakes_viewed").length,
          mistakeRetries: analyticsEvents.filter((event) => event.eventName === "mistake_retry_started").length,
          mistakeEntryClicks: analyticsEvents.filter((event) => event.eventName?.includes("mistakes_clicked")).length,
        },
        scenarioMetricGroups: [
          {
            id: "upload",
            title: "上传链路",
            primaryMetric: "用户数、次数、成功与失败",
            checks: [
              { label: "上传按钮点击", value: analyticsEvents.filter((event) => event.eventName === "upload_clicked").length },
              { label: "上传成功事件", value: analyticsEvents.filter((event) => event.eventName === "upload_succeeded").length },
              { label: "上传失败事件", value: analyticsEvents.filter((event) => event.eventName === "upload_failed").length },
            ],
          },
          {
            id: "practice",
            title: "练习链路",
            primaryMetric: "开练用户、生成题量与练习次数",
            checks: [
              { label: "生成题目数", value: savedQuestions.length },
              { label: "开始练习次数", value: practiceSessions.length },
              { label: "完成练习次数", value: completedSessions.length },
            ],
          },
          {
            id: "completion",
            title: "练习完成",
            primaryMetric: "完成率、答题量与学习质量",
            checks: [
              { label: "练习完成率", value: `${practiceSessions.length ? Math.round((completedSessions.length / practiceSessions.length) * 100) : 0}%` },
              { label: "提交答案数", value: answers.length },
              { label: "平均正确率", value: `${averageAccuracy}%` },
            ],
          },
          {
            id: "mistakes",
            title: "错题链路",
            primaryMetric: "错题产生、访问与复练",
            checks: [
              { label: "产生错题用户", value: new Set(mistakes.map((item) => item.visitorId)).size },
              { label: "错题访问次数", value: analyticsEvents.filter((event) => event.eventName === "mistakes_viewed").length },
              { label: "错题复练次数", value: analyticsEvents.filter((event) => event.eventName === "mistake_retry_started").length },
            ],
          },
        ],
        mistakeEntrySources: [],
        funnel: [
          { name: "注册用户", value: users.length },
          { name: "上传资料", value: documents.length },
          { name: "开始练习", value: practiceSessions.length },
          { name: "完成练习", value: completedSessions.length },
          { name: "提交答案", value: answers.length },
        ],
        eventBreakdown: Array.from(eventCounts.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 12),
        dailyActivity: Array.from({ length: 7 }, (_, index) => {
          const day = new Date(Date.now() - (6 - index) * 24 * 60 * 60 * 1000);
          const label = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          return {
            date: label,
            activeUsers: new Set(
              analyticsEvents
                .filter((event) => new Date(event.createdAt).toDateString() === day.toDateString() && event.visitorId)
                .map((event) => event.visitorId),
            ).size,
            events: analyticsEvents.filter((event) => new Date(event.createdAt).toDateString() === day.toDateString()).length,
            answers: answers.filter((answer) => new Date(answer.createdAt).toDateString() === day.toDateString()).length,
          };
        }),
      };
    },

    listAdminEvents({ limit = 50 } = {}) {
      return analyticsEvents
        .slice()
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, Math.min(100, Math.max(1, Number(limit) || 50)))
        .map((event) => ({
          id: event.id,
          eventName: event.eventName,
          pagePath: event.pagePath || "",
          sessionId: event.sessionId || "",
          properties: event.properties || {},
          createdAt: event.createdAt,
          user: {
            email: "",
            nickname: event.visitorId || "",
          },
        }));
    },

    saveAnalyticsEvent({ visitorId, eventName, sessionId, pagePath, properties, userAgent }) {
      analyticsEvents.push({
        id: uid("evt"),
        visitorId: visitorId ? normalizeVisitorId(visitorId) : null,
        eventName,
        sessionId,
        pagePath,
        properties: properties || {},
        userAgent,
        createdAt: new Date().toISOString(),
      });
    },
  };
}
