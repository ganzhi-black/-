import { api as mockApi } from "./mockApi.js";
import { loadState, updateState } from "./storage.js";
import { repairText } from "../utils/textRepair.js";

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "");
const DEFAULT_PRODUCTION_API_BASE_URL = "https://web-production-60950.up.railway.app";
const MOCK_FALLBACK_ENABLED = !import.meta.env.PROD || import.meta.env.VITE_ENABLE_MOCK_FALLBACK === "true";
const DEFAULT_RETRY_COUNT = 2;
const RETRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 523, 524]);

function localApiBaseUrl() {
  if (typeof window === "undefined") return "http://localhost:8787";
  const hostname = window.location.hostname || "localhost";
  return `http://${hostname}:8787`;
}

export const API_BASE_URL = configuredApiBaseUrl || (import.meta.env.PROD ? DEFAULT_PRODUCTION_API_BASE_URL : localApiBaseUrl());
const configuredRealtimeAsrUrl = import.meta.env.VITE_REALTIME_ASR_URL?.trim();
const VISITOR_ID_KEY = "qimoshua:visitor-id";

function createVisitorId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `visitor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function getVisitorId() {
  try {
    const existing = window.localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;

    const visitorId = createVisitorId();
    window.localStorage.setItem(VISITOR_ID_KEY, visitorId);
    return visitorId;
  } catch {
    return createVisitorId();
  }
}

async function requestOnce(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Visitor-Id", getVisitorId());
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
      credentials: "include",
      signal: controller?.signal || options.signal,
    });
  } catch (error) {
    const nextError = new Error(
      error?.name === "AbortError"
        ? "\u670d\u52a1\u54cd\u5e94\u65f6\u95f4\u8f83\u957f\uff0c\u8bf7\u7a0d\u7b49\u7247\u523b\u3002"
        : "\u670d\u52a1\u6b63\u5728\u6062\u590d\uff0c\u8bf7\u7a0d\u7b49\u7247\u523b\u3002",
    );
    nextError.retryable = error?.name !== "AbortError";
    throw nextError;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(readableApiError(payload.error || `Request failed: ${response.status}`));
    error.status = response.status;
    error.retryable = RETRY_STATUS_CODES.has(response.status) || isTransientErrorMessage(payload.error);
    throw error;
  }

  return payload;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientErrorMessage(message) {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("connection terminated") ||
    lower.includes("connection reset") ||
    lower.includes("connection timeout") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service connection") ||
    lower.includes("service unavailable") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("networkerror") ||
    lower.includes("failed to fetch")
  );
}

function retryDelay(attempt) {
  return 700 + attempt * 900;
}

function readableApiError(message) {
  const text = String(message || "");
  if (isTransientErrorMessage(text)) {
    return "\u670d\u52a1\u6b63\u5728\u6062\u590d\uff0c\u8bf7\u7a0d\u7b49\u7247\u523b\u3002";
  }
  return text;
}

async function request(path, options = {}) {
  const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : DEFAULT_RETRY_COUNT;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestOnce(path, options);
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable || (!error?.status && !options.timeoutMs) || isTransientErrorMessage(error?.message);
      if (!retryable || attempt >= retries) break;
      await wait(retryDelay(attempt));
    }
  }

  throw lastError;
}

export function track(eventName, properties = {}) {
  try {
    void request("/api/analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName,
        pagePath: window.location.hash || window.location.pathname,
        sessionId: properties.sessionId || "",
        properties,
      }),
    }).catch((error) => {
      console.warn("Analytics event skipped:", error.message);
    });
  } catch (error) {
    console.warn("Analytics event skipped:", error.message);
  }
}

export async function transcribeAudio(audioBlob) {
  const formData = new FormData();
  const extension = audioBlob.type.includes("mp4") ? "mp4" : "webm";
  formData.append("audio", audioBlob, `answer.${extension}`);

  return request("/api/audio/transcribe", {
    method: "POST",
    body: formData,
  });
}

export function createRealtimeAudioSocket() {
  if (configuredRealtimeAsrUrl) {
    return new WebSocket(configuredRealtimeAsrUrl);
  }

  const socketHttpBaseUrl = API_BASE_URL || window.location.origin;
  const wsBaseUrl = socketHttpBaseUrl.replace(/^http/i, (protocol) => (protocol.toLowerCase() === "https" ? "wss" : "ws"));
  return new WebSocket(`${wsBaseUrl}/api/audio/realtime`);
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSubject(subject) {
  return {
    ...subject,
    sourceFileName: repairText(subject.sourceFileName || ""),
    sourceFileSize: subject.sourceFileSize || 0,
    chunkCount: subject.chunkCount || 0,
    generatedQuestionCount: subject.generatedQuestionCount || 0,
    status: "ready",
    lastPracticeAt: subject.lastPracticeAt || null,
    mistakeCount: subject.mistakeCount || 0,
  };
}

function normalizeSession(session) {
  return {
    ...session,
    questions: Array.isArray(session?.questions) ? session.questions : [],
    answers: Array.isArray(session?.answers) ? session.answers : [],
    retryMistakeIds: Array.isArray(session?.retryMistakeIds) ? session.retryMistakeIds : [],
    skippedQuestionIndexes: Array.isArray(session?.skippedQuestionIndexes) ? session.skippedQuestionIndexes : [],
    currentIndex: Number.isFinite(Number(session?.currentIndex)) ? Number(session.currentIndex) : 0,
  };
}

function questionsFromLocalSubjectSessions(subjectId) {
  const state = loadState();
  const skippedIds = new Set();
  const questions = [];
  const seen = new Set();

  for (const session of state.sessions.filter((item) => item.subjectId === subjectId)) {
    const sessionQuestions = Array.isArray(session.questions) ? session.questions : [];
    const skippedIndexes = new Set(session.skippedQuestionIndexes || []);
    sessionQuestions.forEach((question, index) => {
      if (skippedIndexes.has(index) && question?.id) skippedIds.add(question.id);
      if (!question?.id || seen.has(question.id)) return;
      seen.add(question.id);
      questions.push({
        ...question,
        subjectId,
        createdAt: question.generatedAt || session.createdAt,
      });
    });
  }

  return questions.map((question) => ({
    ...question,
    wasSkipped: skippedIds.has(question.id),
  }));
}

function mergeSubjectQuestions(remoteQuestions, localQuestions) {
  const byId = new Map();
  for (const question of localQuestions) byId.set(question.id, question);
  for (const question of remoteQuestions) {
    const local = byId.get(question.id);
    byId.set(question.id, {
      ...question,
      wasSkipped: Boolean(local?.wasSkipped),
      createdAt: question.createdAt || question.generatedAt || local?.createdAt,
    });
  }
  return [...byId.values()].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function cachedSession(sessionId) {
  const session = loadState().sessions.find((item) => item.id === sessionId);
  return session ? normalizeSession(session) : null;
}

function storeSession(session, { preserveLocalProgress = false } = {}) {
  const normalized = normalizeSession(session);
  updateState((draft) => {
    const index = draft.sessions.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      const current = draft.sessions[index];
      const currentAnswers = Array.isArray(current.answers) ? current.answers : [];
      const incomingAnswers = Array.isArray(normalized.answers) ? normalized.answers : [];
      draft.sessions[index] = {
        ...current,
        ...normalized,
        answers: incomingAnswers.length >= currentAnswers.length ? incomingAnswers : currentAnswers,
        currentIndex: preserveLocalProgress ? current.currentIndex : normalized.currentIndex,
        skippedQuestionIndexes: preserveLocalProgress ? current.skippedQuestionIndexes || [] : normalized.skippedQuestionIndexes,
      };
    } else {
      draft.sessions.unshift(normalized);
    }
  });
  return normalized;
}

function countGeneratedQuestions(state, subjectId) {
  return state.sessions
    .filter((session) => session.subjectId === subjectId)
    .reduce((total, session) => total + (Array.isArray(session.questions) ? session.questions.length : 0), 0);
}

function upsertMistake(draft, question, result, answer) {
  const index = draft.mistakes.findIndex((item) => item.question.id === question.id);
  const subjectId = question.subjectId || result.subjectId;
  const entry = {
    id: index >= 0 ? draft.mistakes[index].id : uid("m"),
    subjectId,
    question: { ...question, subjectId },
    lastAnswer: answer,
    lastResult: result,
    lastAccuracy: result.accuracy,
    attempts: index >= 0 ? draft.mistakes[index].attempts + 1 : 1,
    createdAt: index >= 0 ? draft.mistakes[index].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (index >= 0) draft.mistakes[index] = entry;
  else draft.mistakes.unshift(entry);
}

function removeMistake(draft, questionId) {
  draft.mistakes = draft.mistakes.filter((item) => item.question.id !== questionId);
}

function inferMistakeSubjectId(state, mistake) {
  if (mistake.subjectId) return mistake.subjectId;
  const session = state.sessions.find((item) => item.questions?.some((question) => question.id === mistake.question?.id));
  return session?.subjectId || mistake.question?.subjectId || "";
}

function normalizeMistakes(state, validSubjectIds = null) {
  return state.mistakes
    .map((mistake) => {
      const subjectId = inferMistakeSubjectId(state, mistake);
      return {
        ...mistake,
        subjectId,
        question: {
          ...mistake.question,
          subjectId,
        },
      };
    })
    .filter((mistake) => mistake.subjectId && (!validSubjectIds || validSubjectIds.has(mistake.subjectId)));
}

async function deleteSubject(subjectId) {
  return request(`/api/subjects/${subjectId}`, {
    method: "DELETE",
  });
}

async function uploadDocument({ subjectId, file }) {
  const formData = new FormData();
  formData.append("subjectId", subjectId);
  formData.append("file", file);

  return request("/api/documents/upload", {
    method: "POST",
    body: formData,
  });
}

export const api = {
  async register({ email, password, nickname }) {
    const payload = await request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, nickname }),
    });
    await track("register_succeeded");
    return payload.user;
  },

  async login({ email, password }) {
    const payload = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    await track("login_succeeded");
    return payload.user;
  },

  async logout() {
    await request("/api/auth/logout", {
      method: "POST",
    });
  },

  async getCurrentUser() {
    const payload = await request("/api/auth/me");
    return payload.user;
  },

  async getAdminMetrics() {
    return request("/api/admin/metrics");
  },

  async getAdminEvents(limit = 50) {
    return request(`/api/admin/events?limit=${encodeURIComponent(limit)}`);
  },

  async getDashboard() {
    try {
      const subjects = await request("/api/subjects");
      const fallback = await mockApi.getDashboard();
      const normalizedSubjects = subjects.map(normalizeSubject);
      const subjectIds = new Set(normalizedSubjects.map((subject) => subject.id));
      const state = loadState();
      const mistakes = normalizeMistakes(state, subjectIds);
      const mistakeCounts = mistakes.reduce((counts, mistake) => {
        counts.set(mistake.subjectId, (counts.get(mistake.subjectId) || 0) + 1);
        return counts;
      }, new Map());
      return {
        ...fallback,
        subjects: normalizedSubjects.map((subject) => ({
          ...subject,
          mistakeCount: mistakeCounts.get(subject.id) || 0,
          generatedQuestionCount: countGeneratedQuestions(state, subject.id),
        })),
        totalMistakes: mistakes.length,
      };
    } catch (error) {
      console.warn("Dashboard endpoint failed:", error);
      if (MOCK_FALLBACK_ENABLED) return mockApi.getDashboard();
      throw error;
    }
  },

  async createSubject({ name, file }) {
    await track("upload_clicked", {
      fileType: file?.name?.split(".").pop()?.toLowerCase() || "",
      fileSize: file?.size || 0,
    });
    const subject = await request("/api/subjects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    const uploaded = file ? await uploadDocument({ subjectId: subject.id, file }) : null;
    await track("upload_succeeded", {
      subjectId: subject.id,
      fileType: file?.name?.split(".").pop()?.toLowerCase() || "",
      fileSize: file?.size || 0,
      chunkCount: uploaded?.chunkCount || 0,
    });
    window.dispatchEvent(new Event("qimoshua:state-change"));

    return normalizeSubject({
      ...subject,
      sourceFileName: uploaded?.document?.fileName || file?.name || "",
      sourceFileSize: uploaded?.document?.size || file?.size || 0,
      chunkCount: uploaded?.chunkCount || 0,
    });
  },

  async getSubject(subjectId) {
    try {
      return normalizeSubject(await request(`/api/subjects/${subjectId}`));
    } catch (error) {
      console.warn("Subject detail endpoint failed, falling back to subject list:", error);
      try {
        const subjects = await request("/api/subjects");
        const subject = subjects.find((item) => item.id === subjectId);
        if (subject) return normalizeSubject(subject);
      } catch (listError) {
        console.warn("Subject list fallback failed:", listError);
      }
      if (!MOCK_FALLBACK_ENABLED) throw error;
      return mockApi.getSubject(subjectId);
    }
  },

  async getSubjectQuestions(subjectId) {
    const localQuestions = questionsFromLocalSubjectSessions(subjectId);
    try {
      const remoteQuestions = await request(`/api/subjects/${subjectId}/questions`);
      return mergeSubjectQuestions(Array.isArray(remoteQuestions) ? remoteQuestions : [], localQuestions);
    } catch (error) {
      console.warn("Subject question history endpoint failed, falling back to local sessions:", error);
      return localQuestions;
    }
  },

  async deleteSubjectQuestion({ subjectId, questionId }) {
    try {
      await request(`/api/subjects/${subjectId}/questions/${questionId}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.warn("Subject question delete endpoint failed, removing local copy only:", error);
    }

    updateState((draft) => {
      for (const session of draft.sessions.filter((item) => item.subjectId === subjectId)) {
        const removedIndexes = [];
        session.questions = (session.questions || []).filter((question, index) => {
          if (question.id !== questionId) return true;
          removedIndexes.push(index);
          return false;
        });
        if (removedIndexes.length && Array.isArray(session.skippedQuestionIndexes)) {
          const removedIndexSet = new Set(removedIndexes);
          session.skippedQuestionIndexes = session.skippedQuestionIndexes
            .filter((index) => !removedIndexSet.has(index))
            .map((index) => index - removedIndexes.filter((removedIndex) => removedIndex < index).length);
        }
      }
      draft.answers = (draft.answers || []).filter((answer) => answer.questionId !== questionId);
      draft.mistakes = (draft.mistakes || []).filter((mistake) => mistake.question?.id !== questionId && mistake.questionId !== questionId);
    });
  },

  async deleteSubject(subjectId) {
    await deleteSubject(subjectId);
    updateState((draft) => {
      const removedQuestionIds = new Set(
        draft.sessions
          .filter((item) => item.subjectId === subjectId)
          .flatMap((item) => item.questions?.map((question) => question.id) || []),
      );
      draft.subjects = draft.subjects.filter((item) => item.id !== subjectId);
      draft.sessions = draft.sessions.filter((item) => item.subjectId !== subjectId);
      draft.answers = draft.answers.filter((item) => item.subjectId !== subjectId);
      draft.mistakes = draft.mistakes.filter(
        (item) => item.subjectId !== subjectId && item.question?.subjectId !== subjectId && !removedQuestionIds.has(item.question?.id),
      );
    });
    window.dispatchEvent(new Event("qimoshua:state-change"));
  },

  async createSession({ subjectId, types, amount, mode, retryQuestions = [] }) {
    if (retryQuestions.length > 0) {
      await track("mistake_retry_started", {
        subjectId,
        amount: retryQuestions.length,
      });
      const session = await request("/api/sessions/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          questionIds: retryQuestions.map((item) => item.question?.id).filter(Boolean),
          mode,
        }),
      });
      const normalizedSession = normalizeSession(session);
      updateState((draft) => {
        draft.sessions.unshift(normalizedSession);
      });
      return normalizedSession;
    }

    try {
      const expectedAmount = Math.min(50, Math.max(1, Number(amount) || 1));
      const sessionPayload = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId, types, amount: expectedAmount, mode }),
      };
      let session = await request("/api/sessions", sessionPayload);
      if ((Array.isArray(session?.questions) ? session.questions.length : 0) < expectedAmount) {
        console.warn("Generated session returned fewer questions than requested; retrying once.", {
          requested: expectedAmount,
          received: Array.isArray(session?.questions) ? session.questions.length : 0,
        });
        session = await request("/api/sessions", sessionPayload);
      }
      await track("practice_started", {
        sessionId: session.id,
        subjectId,
        types,
        amount,
        mode,
      });

      const normalizedSession = normalizeSession(session);

      updateState((draft) => {
        draft.sessions.unshift(normalizedSession);
        const subject = draft.subjects.find((item) => item.id === subjectId);
        if (subject) subject.lastPracticeAt = new Date().toISOString();
      });

      return normalizedSession;
    } catch (error) {
      console.warn("Session creation endpoint failed:", error);
      throw new Error("\u670d\u52a1\u6b63\u5728\u6062\u590d\uff0c\u8bf7\u7a0d\u7b49\u7247\u523b\u540e\u81ea\u52a8\u91cd\u8bd5\u3002");
    }
  },

  async getSession(sessionId, options = {}) {
    const cached = cachedSession(sessionId);
    if (cached && !options.forceRefresh) {
      void request(`/api/sessions/${sessionId}`)
        .then((session) => storeSession(session, { preserveLocalProgress: true }))
        .catch((error) => console.warn("Session background refresh failed:", error));
      return cached;
    }

    try {
      return storeSession(await request(`/api/sessions/${sessionId}`), { preserveLocalProgress: Boolean(options.preserveLocalProgress) });
    } catch (error) {
      console.warn("Session endpoint failed:", error);
      if (!MOCK_FALLBACK_ENABLED) throw error;
      return mockApi.getSession(sessionId);
    }
  },

  async submitAnswer({ sessionId, questionIndex, answer, sessionSnapshot = null }) {
    const rawSession = sessionSnapshot || loadState().sessions.find((item) => item.id === sessionId);
    if (!rawSession) {
      if (!MOCK_FALLBACK_ENABLED) {
        throw new Error("练习数据没有加载完成，请返回题目页重新进入。");
      }
      return mockApi.submitAnswer({ sessionId, questionIndex, answer });
    }
    const session = normalizeSession(rawSession);

    const question = session.questions[questionIndex];
    if (!question) throw new Error("没有找到当前题目，请返回题目页重新进入。");
    const { result, answerId, createdAt } = await request("/api/answers/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        question,
        answer,
        mode: session.mode,
      }),
      timeoutMs: 35000,
    });

    const answerRecord = {
      id: answerId || uid("ans"),
      sessionId,
      questionId: question.id,
      subjectId: question.subjectId || session.subjectId,
      questionIndex,
      question: { ...question, subjectId: question.subjectId || session.subjectId },
      userAnswer: answer,
      result,
      isRetry: session.retryMistakeIds.length > 0,
      createdAt: createdAt || new Date().toISOString(),
    };
    await track("answer_submitted", {
      sessionId,
      subjectId: question.subjectId || session.subjectId,
      questionId: question.id,
      type: question.type,
      isCorrect: result.isCorrect,
      accuracy: result.accuracy ?? null,
    });

    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      if (!current) return;
      current.answers = Array.isArray(current.answers) ? current.answers : [];
      current.answers = current.answers.filter((item) => item.questionIndex !== questionIndex);
      current.answers.push(answerRecord);
      draft.answers.push(answerRecord);
      if (result.isCorrect) removeMistake(draft, question.id);
      else upsertMistake(draft, { ...question, subjectId: question.subjectId || session.subjectId }, result, answer);
    });

    return answerRecord;
  },

  async deleteSessionAnswer({ sessionId, questionId }) {
    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      if (!current) return;
      current.answers = (current.answers || []).filter((item) => item.questionId !== questionId);
      draft.answers = (draft.answers || []).filter((item) => !(item.sessionId === sessionId && item.questionId === questionId));
    });
    void request(`/api/sessions/${sessionId}/answers/${questionId}`, {
      method: "DELETE",
    }).catch((error) => console.warn("Delete answer sync failed:", error));
  },

  async finishSession(sessionId) {
    const state = loadState();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return mockApi.finishSession(sessionId);

    const skippedCount = new Set(session.skippedQuestionIndexes || []).size;
    const answeredCount = session.answers.length;
    const correctCount = session.answers.filter((item) => item.result.isCorrect).length;
    const mistakeCount = session.answers.filter((item) => !item.result.isCorrect).length;
    const summary = {
      total: session.questions.length,
      answeredCount,
      skippedCount,
      correctCount,
      rate: answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0,
      mistakeCount,
    };

    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      current.completedAt = new Date().toISOString();
      current.summary = summary;
    });
    void request(`/api/sessions/${sessionId}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    })
      .then(() => {
        track("practice_finished", {
          sessionId,
          subjectId: session.subjectId,
          ...summary,
        });
      })
      .catch((error) => console.warn("Finish session sync failed:", error));

    return summary;
  },
  async getMistakes(subjectId) {
    try {
      const query = subjectId ? `?subjectId=${encodeURIComponent(subjectId)}` : "";
      const mistakes = await request(`/api/mistakes${query}`);
      await track("mistakes_viewed", { subjectId: subjectId || "" });
      if (mistakes.length) return mistakes;
    } catch (error) {
      console.warn("Mistakes endpoint failed, falling back to local state:", error);
    }
    const state = loadState();
    const dashboard = await this.getDashboard();
    const subjectIds = new Set(dashboard.subjects.map((subject) => subject.id));
    const normalized = normalizeMistakes(state, subjectIds);

    return normalized.filter((item) => item.subjectId && (!subjectId || item.subjectId === subjectId));
  },

  async deleteMistake(mistakeId) {
    await request(`/api/mistakes/${mistakeId}`, {
      method: "DELETE",
    });
    updateState((draft) => {
      draft.mistakes = draft.mistakes.filter((item) => item.id !== mistakeId);
    });
    window.dispatchEvent(new Event("qimoshua:state-change"));
  },
};
