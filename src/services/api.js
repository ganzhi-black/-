import { clearState, loadState } from "./storage.js";
import { repairText } from "../utils/textRepair.js";

const DEFAULT_PRODUCTION_API_BASE_URL = "https://web-production-60950.up.railway.app";
const DEFAULT_RETRY_COUNT = 2;
const RETRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 523, 524]);

function isRetiredRailwayApiUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.startsWith("api-production-") && parsed.hostname.endsWith(".up.railway.app");
  } catch {
    return false;
  }
}

function normalizeConfiguredUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized || isRetiredRailwayApiUrl(normalized)) return "";
  return normalized;
}

const configuredApiBaseUrl = normalizeConfiguredUrl(import.meta.env.VITE_API_BASE_URL);

function localApiBaseUrl() {
  if (typeof window === "undefined") return "http://localhost:8787";
  const hostname = window.location.hostname || "localhost";
  return `http://${hostname}:8787`;
}

export const API_BASE_URL = configuredApiBaseUrl || (import.meta.env.PROD ? DEFAULT_PRODUCTION_API_BASE_URL : localApiBaseUrl());
const configuredRealtimeAsrUrl = normalizeConfiguredUrl(import.meta.env.VITE_REALTIME_ASR_URL);
const VISITOR_ID_KEY = "qimoshua:visitor-id";
const VISITOR_ALIAS_KEY = "qimoshua:visitor-id-history";
const MAX_VISITOR_ALIAS_COUNT = 8;

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

function readVisitorAliases() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VISITOR_ALIAS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function writeVisitorAliases(visitorIds) {
  try {
    const uniqueIds = [...new Set(visitorIds.filter(Boolean).map(String))].slice(0, MAX_VISITOR_ALIAS_COUNT);
    window.localStorage.setItem(VISITOR_ALIAS_KEY, JSON.stringify(uniqueIds));
  } catch {
    // Storage is best-effort; the current request still carries X-Visitor-Id.
  }
}

function rememberVisitorAlias(visitorId) {
  if (!visitorId) return;
  writeVisitorAliases([visitorId, ...readVisitorAliases()]);
}

function getVisitorAliases(primaryVisitorId = getVisitorId()) {
  return [...new Set([primaryVisitorId, ...readVisitorAliases()].filter(Boolean).map(String))].slice(0, MAX_VISITOR_ALIAS_COUNT);
}

function getClaimSubjectIds() {
  const state = loadState();
  const ids = [
    ...(state.subjects || []).map((subject) => subject.id),
    ...(state.sessions || []).map((session) => session.subjectId),
    ...(state.answers || []).map((answer) => answer.subjectId),
    ...(state.mistakes || []).flatMap((mistake) => [mistake.subjectId, mistake.question?.subjectId]),
  ];
  return [...new Set(ids.filter(Boolean).map(String))].slice(0, 20);
}

function setVisitorId(visitorId) {
  try {
    const previous = window.localStorage.getItem(VISITOR_ID_KEY);
    if (previous && previous !== visitorId) rememberVisitorAlias(previous);
    if (visitorId) window.localStorage.setItem(VISITOR_ID_KEY, visitorId);
  } catch {
    // Ignore storage failures; the auth cookie still identifies the account.
  }
}

function rememberAuthenticatedUser(user) {
  if (user?.id) setVisitorId(user.id);
  return user;
}

async function requestOnce(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const visitorId = getVisitorId();
  headers.set("X-Visitor-Id", visitorId);
  headers.set("X-Visitor-Aliases", getVisitorAliases(visitorId).join(","));
  headers.set("X-Claim-Subject-Ids", getClaimSubjectIds().join(","));
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
    const user = rememberAuthenticatedUser(payload.user);
    clearState();
    await track("register_succeeded");
    return user;
  },

  async login({ email, password }) {
    const payload = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const user = rememberAuthenticatedUser(payload.user);
    clearState();
    await track("login_succeeded");
    return user;
  },

  async logout() {
    await request("/api/auth/logout", {
      method: "POST",
    });
    clearState();
  },

  async getCurrentUser() {
    const payload = await request("/api/auth/me");
    return rememberAuthenticatedUser(payload.user);
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
      const normalizedSubjects = subjects.map(normalizeSubject);
      return {
        subjects: normalizedSubjects,
        totalMistakes: normalizedSubjects.reduce((total, subject) => total + (Number(subject.mistakeCount) || 0), 0),
      };
    } catch (error) {
      console.warn("Dashboard endpoint failed:", error);
      throw error;
    }
  },

  async refreshAccountData() {
    const dashboard = await this.getDashboard();
    const subjectIds = dashboard.subjects.map((subject) => subject.id).filter(Boolean);
    const results = await Promise.allSettled([this.getMistakes(), ...subjectIds.map((subjectId) => this.getSubjectQuestions(subjectId))]);
    for (const result of results) {
      if (result.status === "rejected") console.warn("Account data refresh skipped one resource:", result.reason);
    }
    window.dispatchEvent(new Event("qimoshua:state-change"));
    return dashboard;
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
      console.warn("Subject detail endpoint failed:", error);
      throw error;
    }
  },

  async getSubjectQuestions(subjectId) {
    try {
      const remoteQuestions = await request(`/api/subjects/${subjectId}/questions`);
      return Array.isArray(remoteQuestions) ? remoteQuestions : [];
    } catch (error) {
      console.warn("Subject question history endpoint failed:", error);
      throw error;
    }
  },

  async deleteSubjectQuestion({ subjectId, questionId }) {
    await request(`/api/subjects/${subjectId}/questions/${questionId}`, {
      method: "DELETE",
    });
    window.dispatchEvent(new Event("qimoshua:state-change"));
  },

  async deleteSubject(subjectId) {
    await deleteSubject(subjectId);
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
      window.dispatchEvent(new Event("qimoshua:state-change"));
      return normalizeSession(session);
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

      window.dispatchEvent(new Event("qimoshua:state-change"));
      return normalizeSession(session);
    } catch (error) {
      console.warn("Session creation endpoint failed:", error);
      throw new Error("\u670d\u52a1\u6b63\u5728\u6062\u590d\uff0c\u8bf7\u7a0d\u7b49\u7247\u523b\u540e\u81ea\u52a8\u91cd\u8bd5\u3002");
    }
  },

  async getSession(sessionId) {
    try {
      return normalizeSession(await request(`/api/sessions/${sessionId}`));
    } catch (error) {
      console.warn("Session endpoint failed:", error);
      throw error;
    }
  },

  async submitAnswer({ sessionId, questionIndex, answer, sessionSnapshot = null }) {
    const rawSession = sessionSnapshot || (await request(`/api/sessions/${sessionId}`));
    if (!rawSession) throw new Error("练习数据没有加载完成，请返回题目页重新进入。");
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

    window.dispatchEvent(new Event("qimoshua:state-change"));
    return answerRecord;
  },

  async deleteSessionAnswer({ sessionId, questionId }) {
    await request(`/api/sessions/${sessionId}/answers/${questionId}`, {
      method: "DELETE",
    });
    window.dispatchEvent(new Event("qimoshua:state-change"));
  },

  async finishSession(sessionId, sessionSnapshot = null) {
    const session = normalizeSession(sessionSnapshot || (await request(`/api/sessions/${sessionId}`)));

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

    await request(`/api/sessions/${sessionId}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    });
    await track("practice_finished", {
      sessionId,
      subjectId: session.subjectId,
      ...summary,
    });

    window.dispatchEvent(new Event("qimoshua:state-change"));
    return summary;
  },
  async getMistakes(subjectId) {
    try {
      const query = subjectId ? `?subjectId=${encodeURIComponent(subjectId)}` : "";
      const mistakes = await request(`/api/mistakes${query}`);
      await track("mistakes_viewed", { subjectId: subjectId || "" });
      return Array.isArray(mistakes) ? mistakes : [];
    } catch (error) {
      console.warn("Mistakes endpoint failed:", error);
      throw error;
    }
  },

  async deleteMistake(mistakeId) {
    await request(`/api/mistakes/${mistakeId}`, {
      method: "DELETE",
    });
    window.dispatchEvent(new Event("qimoshua:state-change"));
  },
};
