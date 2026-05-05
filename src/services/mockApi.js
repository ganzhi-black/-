import { clamp, uid } from "../utils/format.js";
import { loadState, updateState } from "./storage.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sourceTexts = [
  {
    loc: "第一章 第 3 段",
    text: "期末复习的关键不是重复阅读资料，而是把材料转化为可检验的训练任务，并在反馈中修正遗漏。",
    points: ["把资料转化为训练任务", "通过反馈修正遗漏", "减少无效重复阅读"],
  },
  {
    loc: "第二章 第 2 节",
    text: "镜子型 AI 批改不生成所谓标准答案，而是对照原文要点检查学生回答覆盖了哪些内容、遗漏了哪些内容。",
    points: ["不生成标准答案", "对照原文要点", "区分覆盖和遗漏"],
  },
  {
    loc: "第三章 第 1 节",
    text: "RAG 检索增强生成先从用户资料中找到相关片段，再基于片段生成题目与反馈，降低模型自由发挥带来的幻觉风险。",
    points: ["先检索相关片段", "基于片段生成反馈", "降低幻觉风险"],
  },
  {
    loc: "第四章 第 4 段",
    text: "错题本的价值在于形成闭环：答错自动收集，重做后达到掌握标准则移出，让学生看到可衡量的进步。",
    points: ["答错自动收集", "重做达标后移出", "进步可衡量"],
  },
];

const stems = [
  "下列哪一项最符合资料中的核心观点？",
  "根据材料，产品避免 AI 幻觉的主要方式是什么？",
  "资料中认为期末周学生最需要哪类能力？",
  "关于错题本闭环，下列说法正确的是哪一项？",
];

const distractors = [
  "依赖通用题库覆盖所有学校考试",
  "优先生成完整参考答案供用户背诵",
  "把所有复习资料公开给同班同学",
  "只统计学习时长，不记录答题结果",
  "用装饰性页面提升用户停留时间",
  "固定每门课只生成选择题",
];

const subjectiveStems = {
  short: [
    "请简述镜子型 AI 批改为什么适合大学期末复习。",
    "请说明 RAG 在期末刷中的作用。",
    "请简述错题本如何形成训练闭环。",
  ],
  essay: [
    "请结合资料，论述期末刷与通用大模型相比的核心差异。",
    "请论述语音背书与 AI 要点核对为什么能解决主观题练习低效的问题。",
    "请从用户痛点角度分析资料变题库的价值。",
  ],
};

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffle(list) {
  return [...list].sort(() => Math.random() - 0.5);
}

function makeSingleQuestion(subjectId, index) {
  const source = randomItem(sourceTexts);
  const correct = randomItem(source.points);
  const options = shuffle([correct, ...shuffle(distractors).slice(0, 3)]).map((text, i) => ({
    label: ["A", "B", "C", "D"][i],
    text,
  }));
  return {
    id: uid("q"),
    subjectId,
    type: "single",
    title: `${randomItem(stems)}（${index + 1}）`,
    options,
    correctAnswer: options.find((option) => option.text === correct).label,
    keyPoints: [],
    sourceText: source.text,
    sourceLocation: source.loc,
  };
}

function makeSubjectiveQuestion(subjectId, type, index) {
  const source = randomItem(sourceTexts);
  return {
    id: uid("q"),
    subjectId,
    type,
    title: `${randomItem(subjectiveStems[type === "essay" ? "essay" : "short"])}（${index + 1}）`,
    options: null,
    correctAnswer: null,
    keyPoints: source.points,
    sourceText: source.text,
    sourceLocation: source.loc,
  };
}

function gradeSubjective(question, userText, mode) {
  const points = question.keyPoints.length ? question.keyPoints : randomItem(sourceTexts).points;
  const shuffled = shuffle(points);
  const min = mode === "strict" ? 40 : 52;
  const max = mode === "strict" ? 86 : 92;
  const accuracy = Math.round(min + Math.random() * (max - min));
  const coveredCount = clamp(Math.round((accuracy / 100) * points.length), 1, points.length);
  const covered = shuffled.slice(0, coveredCount);
  const missed = shuffled.slice(coveredCount);
  const snippets = userText
    .split(/[，。；,.、\s]+/)
    .filter(Boolean)
    .slice(0, 4);
  return {
    isCorrect: accuracy >= 70,
    accuracy,
    coveredPoints: covered,
    missedPoints: missed,
    extractedPoints: snippets.length ? snippets : ["已收到你的口头回答"],
    advice:
      accuracy >= 70
        ? "要点覆盖已经达到通过线，建议再补一遍遗漏内容，让表达更稳。"
        : "当前回答还缺少关键支撑点，建议回到原文片段重新背诵后再做一次。",
    sourceText: question.sourceText,
    sourceLocation: question.sourceLocation,
  };
}

function gradeSingle(question, answer) {
  const isCorrect = answer === question.correctAnswer;
  return {
    isCorrect,
    accuracy: isCorrect ? 100 : 0,
    coveredPoints: isCorrect ? ["已选择正确选项"] : [],
    missedPoints: isCorrect ? [] : [`正确选项为 ${question.correctAnswer}`],
    extractedPoints: [answer ? `你的选择：${answer}` : "未选择"],
    advice: isCorrect ? "判断准确，可以进入下一题。" : "这题已经加入错题本，建议查看原文后重做。",
    sourceText: question.sourceText,
    sourceLocation: question.sourceLocation,
  };
}

function upsertMistake(draft, question, result, answer) {
  const index = draft.mistakes.findIndex((item) => item.question.id === question.id);
  const entry = {
    id: index >= 0 ? draft.mistakes[index].id : uid("m"),
    subjectId: question.subjectId,
    question,
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

export const api = {
  async getDashboard() {
    await wait(180);
    const state = loadState();
    const subjectIds = new Set(state.subjects.map((subject) => subject.id));
    const activeMistakes = state.mistakes.filter((item) => subjectIds.has(item.subjectId));
    return {
      user: state.user,
      subjects: state.subjects.map((subject) => ({
        ...subject,
        mistakeCount: activeMistakes.filter((item) => item.subjectId === subject.id).length,
      })),
      totalMistakes: activeMistakes.length,
    };
  },

  async createSubject({ name, file }) {
    await wait(4200);
    const subject = {
      id: uid("sub"),
      name,
      sourceFileName: file?.name || "演示资料.docx",
      sourceFileSize: file?.size || 0,
      chunkCount: Math.floor(18 + Math.random() * 42),
      status: "ready",
      createdAt: new Date().toISOString(),
      lastPracticeAt: null,
    };
    updateState((draft) => {
      draft.subjects.unshift(subject);
    });
    return subject;
  },

  async getSubject(subjectId) {
    await wait(120);
    return loadState().subjects.find((item) => item.id === subjectId);
  },

  async createSession({ subjectId, types, amount, mode, retryQuestions = [] }) {
    await wait(900);
    const pickedTypes = types.length ? types : ["single"];
    const questions =
      retryQuestions.length > 0
        ? retryQuestions.map((item) => item.question)
        : Array.from({ length: amount }).map((_, index) => {
            const type = pickedTypes[index % pickedTypes.length];
            return type === "single" ? makeSingleQuestion(subjectId, index) : makeSubjectiveQuestion(subjectId, type, index);
          });
    const session = {
      id: uid("ses"),
      subjectId,
      mode,
      questions,
      answers: [],
      currentIndex: 0,
      retryMistakeIds: retryQuestions.map((item) => item.id),
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    updateState((draft) => {
      draft.sessions.unshift(session);
      const subject = draft.subjects.find((item) => item.id === subjectId);
      if (subject) subject.lastPracticeAt = new Date().toISOString();
    });
    return session;
  },

  async getSession(sessionId) {
    await wait(80);
    return loadState().sessions.find((item) => item.id === sessionId);
  },

  async submitAnswer({ sessionId, questionIndex, answer }) {
    await wait(700);
    let saved;
    updateState((draft) => {
      const session = draft.sessions.find((item) => item.id === sessionId);
      const question = session.questions[questionIndex];
      const result = question.type === "single" ? gradeSingle(question, answer) : gradeSubjective(question, answer, session.mode);
      const answerRecord = {
        id: uid("ans"),
        sessionId,
        questionId: question.id,
        subjectId: question.subjectId,
        questionIndex,
        question,
        userAnswer: answer,
        result,
        isRetry: session.retryMistakeIds.length > 0,
        createdAt: new Date().toISOString(),
      };
      session.answers = session.answers.filter((item) => item.questionIndex !== questionIndex);
      session.answers.push(answerRecord);
      draft.answers.push(answerRecord);
      if (result.isCorrect) removeMistake(draft, question.id);
      else upsertMistake(draft, question, result, answer);
      saved = answerRecord;
    });
    return saved;
  },

  async finishSession(sessionId) {
    await wait(120);
    let summary;
    updateState((draft) => {
      const session = draft.sessions.find((item) => item.id === sessionId);
      session.completedAt = new Date().toISOString();
      const correctCount = session.answers.filter((item) => item.result.isCorrect).length;
      const addedMistakes = session.answers.filter((item) => !item.result.isCorrect).length;
      summary = {
        total: session.questions.length,
        correctCount,
        rate: session.questions.length ? Math.round((correctCount / session.questions.length) * 100) : 0,
        mistakeCount: addedMistakes,
      };
      session.summary = summary;
    });
    return summary;
  },

  async getMistakes(subjectId) {
    await wait(160);
    const state = loadState();
    return state.mistakes.filter((item) => !subjectId || item.subjectId === subjectId);
  },
};
