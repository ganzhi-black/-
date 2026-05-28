const STORAGE_KEY = "qimoshua_v1_state";

const initialState = {
  user: {
    id: "u_mock_001",
    nickname: "备考同学",
    isLoggedIn: true,
  },
  subjects: [],
  sessions: [],
  answers: [],
  mistakes: [],
};

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ...initialState,
      ...parsed,
      user: { ...initialState.user, ...(parsed.user || {}) },
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      answers: Array.isArray(parsed.answers) ? parsed.answers : [],
      mistakes: Array.isArray(parsed.mistakes) ? parsed.mistakes : [],
    };
  } catch {
    return initialState;
  }
}

export function saveState(nextState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  window.dispatchEvent(new Event("qimoshua:state-change"));
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("qimoshua:state-change"));
}

export function updateState(mutator) {
  const current = loadState();
  const draft = structuredClone(current);
  const result = mutator(draft) || draft;
  saveState(result);
  return result;
}
