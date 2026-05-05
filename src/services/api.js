import { api as mockApi } from "./mockApi.js";
import { loadState, updateState } from "./storage.js";
import { repairText } from "../utils/textRepair.js";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";
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

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Visitor-Id", getVisitorId());

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
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
  const wsBaseUrl = API_BASE_URL.replace(/^http/i, (protocol) => (protocol.toLowerCase() === "https" ? "wss" : "ws"));
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
      console.warn("Using mock dashboard because backend is unavailable:", error);
      return mockApi.getDashboard();
    }
  },

  async createSubject({ name, file }) {
    const subject = await request("/api/subjects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    const uploaded = file ? await uploadDocument({ subjectId: subject.id, file }) : null;
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
      return mockApi.getSubject(subjectId);
    }
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
      return mockApi.createSession({ subjectId, types, amount, mode, retryQuestions });
    }

    try {
      const session = await request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId, types, amount, mode }),
      });

      updateState((draft) => {
        draft.sessions.unshift(session);
        const subject = draft.subjects.find((item) => item.id === subjectId);
        if (subject) subject.lastPracticeAt = new Date().toISOString();
      });

      return session;
    } catch (error) {
      throw new Error(`AI 出题失败：${error.message}`);
    }
  },

  getSession: mockApi.getSession,

  async submitAnswer({ sessionId, questionIndex, answer }) {
    const session = loadState().sessions.find((item) => item.id === sessionId);
    if (!session) {
      return mockApi.submitAnswer({ sessionId, questionIndex, answer });
    }

    const question = session.questions[questionIndex];
    const { result } = await request("/api/answers/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        answer,
        mode: session.mode,
      }),
    });

    const answerRecord = {
      id: uid("ans"),
      sessionId,
      questionId: question.id,
      subjectId: question.subjectId || session.subjectId,
      questionIndex,
      question: { ...question, subjectId: question.subjectId || session.subjectId },
      userAnswer: answer,
      result,
      isRetry: session.retryMistakeIds?.length > 0,
      createdAt: new Date().toISOString(),
    };

    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      current.answers = current.answers.filter((item) => item.questionIndex !== questionIndex);
      current.answers.push(answerRecord);
      draft.answers.push(answerRecord);
      if (result.isCorrect) removeMistake(draft, question.id);
      else upsertMistake(draft, { ...question, subjectId: question.subjectId || session.subjectId }, result, answer);
    });

    return answerRecord;
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

    return summary;
  },
  async getMistakes(subjectId) {
    const state = loadState();
    const dashboard = await this.getDashboard();
    const subjectIds = new Set(dashboard.subjects.map((subject) => subject.id));
    const normalized = normalizeMistakes(state, subjectIds);

    return normalized.filter((item) => item.subjectId && (!subjectId || item.subjectId === subjectId));
  },
};
