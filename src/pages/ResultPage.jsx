import { ArrowRight, CheckCircle2, ChevronDown, RotateCcw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api } from "../services/api.js";
import { updateState } from "../services/storage.js";
import { percent } from "../utils/format.js";
import { repairText } from "../utils/textRepair.js";

const SENTENCE_END = /[。！？!?；;]/;

const CLEAN_SENTENCE_END = /[\u3002\uff01\uff1f!?\uff1b;]/;
const COMPLETE_SOURCE_END = /[\u3002\uff01\uff1f.!?]$/;
const COMPLETE_SOURCE_END_GLOBAL = /[\u3002\uff01\uff1f.!?]/g;

function normalizeText(text = "") {
  return repairText(String(text).replace(/\s+/g, " ").trim());
}

function tokenize(text = "") {
  const normalized = normalizeText(text);
  const chineseTerms = normalized.match(/[\u4e00-\u9fa5]{2,12}/g) || [];
  const englishTerms = normalized.match(/[a-zA-Z0-9]{3,}/g) || [];
  return [...chineseTerms, ...englishTerms]
    .filter((item) => item.length >= 2)
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
}

function compactText(text = "") {
  return normalizeText(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").toLowerCase();
}

function titleStem(title = "") {
  return normalizeText(title)
    .replace(/^(?:\u8bf7)?(?:\u7b80\u8ff0|\u8bd5\u8ff0|\u8bba\u8ff0|\u5206\u6790|\u6982\u62ec|\u8bf4\u660e|\u8c08\u8c08)/, "")
    .replace(/(?:\u662f\u4ec0\u4e48|\u6709\u54ea\u4e9b|\u8868\u73b0\u5728\u54ea\u4e9b\u65b9\u9762|\u4f53\u73b0\u5728\u54ea\u4e9b\u65b9\u9762)[\u3002\uff1f?]?$/, "")
    .trim();
}

function charBigrams(text = "") {
  const chars = compactText(text);
  if (chars.length < 2) return new Set();
  const bigrams = new Set();
  for (let i = 0; i <= chars.length - 2; i += 1) bigrams.add(chars.slice(i, i + 2));
  return bigrams;
}

function bigramOverlap(text, reference) {
  const textBigrams = charBigrams(text);
  const refBigrams = charBigrams(reference);
  if (!refBigrams.size) return 0;
  let hits = 0;
  for (const bigram of textBigrams) {
    if (refBigrams.has(bigram)) hits += 1;
  }
  return hits / refBigrams.size;
}

function isMetaPoint(point, questionTitle) {
  const text = normalizeText(point);
  const compactPoint = compactText(text);
  const compactTitle = compactText(titleStem(questionTitle));
  if (!text || text.length < 4) return true;
  if (/[\uff08(]?(?:\u7b80\u7b54\u9898|\u8bba\u8ff0\u9898|\u540d\u8bcd\u89e3\u91ca|\u9009\u62e9\u9898|\u586b\u7a7a\u9898)[\uff09)]?/.test(text)) return true;
  if (/(?:\u7b54\u9898\u65b9\u5411|\u51fa\u9898\u6a21\u5f0f|\u590d\u4e60\u65b9\u5411)/.test(text)) return true;
  if (/(?:\u4f53\u73b0\u5728|\u5305\u62ec|\u5206\u4e3a).{2,40}(?:\u65b9\u9762|\u7c7b|\u70b9)$/.test(text)) return true;
  if (compactTitle.length >= 6 && compactPoint.includes(compactTitle)) return true;
  return false;
}

function isLikelyInQuestionScope(point, questionTitle) {
  const text = normalizeText(point);
  const title = normalizeText(questionTitle);
  if (/[\u827a\u8853]\u672f[\u7279\u7279]\u8272|\u827a\u672f\u7279\u8272/.test(title) || title.includes("\u827a\u672f\u7279\u8272")) {
    return text.includes("\u827a\u672f");
  }
  return true;
}

function cleanDisplayStandards(question, result) {
  const rawPoints = [
    ...(Array.isArray(question?.keyPoints) ? question.keyPoints : []),
    ...(Array.isArray(result?.coveredPoints) ? result.coveredPoints : []),
  ];
  const cleaned = [];
  for (const rawPoint of rawPoints) {
    const point = normalizeText(rawPoint);
    if (isMetaPoint(point, question?.title)) continue;
    if (!isLikelyInQuestionScope(point, question?.title)) continue;
    if (!cleaned.some((item) => item === point || bigramOverlap(point, item) >= 0.72)) cleaned.push(point);
  }
  return cleaned;
}

function alignDisplayPoints(points, standards) {
  const aligned = [];
  for (const rawPoint of points || []) {
    const point = normalizeText(rawPoint);
    const matched = standards.find((standard) => standard === point || standard.includes(point) || point.includes(standard) || bigramOverlap(point, standard) >= 0.55);
    if (matched && !aligned.includes(matched)) aligned.push(matched);
  }
  return aligned;
}

function previousSentenceStart(text, index) {
  for (let i = Math.max(0, index - 1); i >= 0; i -= 1) {
    if (CLEAN_SENTENCE_END.test(text[i]) || SENTENCE_END.test(text[i]) || text[i] === "\n") {
      return Math.min(text.length, i + 1);
    }
  }
  return 0;
}

function nextSentenceEnd(text, index) {
  for (let i = Math.max(0, index); i < text.length; i += 1) {
    if (CLEAN_SENTENCE_END.test(text[i]) || SENTENCE_END.test(text[i]) || text[i] === "\n") {
      return i + 1;
    }
  }
  return Math.min(text.length, index);
}

function sentenceExcerpt(sourceText, hit, minLength = 180, maxLength = 360) {
  const text = normalizeText(sourceText);
  if (!text) return "";

  let start = previousSentenceStart(text, hit);
  let end = nextSentenceEnd(text, Math.max(hit + minLength, start + minLength));

  if (end - start > maxLength) {
    end = nextSentenceEnd(text, start + maxLength);
  }
  if (end <= start) {
    end = Math.min(text.length, start + maxLength);
  }

  return text.slice(start, end).trim();
}

function endAtCompleteSentence(text) {
  const normalized = normalizeText(text);
  if (!normalized || COMPLETE_SOURCE_END.test(normalized)) return normalized;

  const stops = [...normalized.matchAll(COMPLETE_SOURCE_END_GLOBAL)];
  const lastStop = stops[stops.length - 1];
  if (lastStop && lastStop.index >= Math.min(60, normalized.length - 1)) {
    return normalized.slice(0, lastStop.index + 1).trim();
  }

  return normalized.length >= 8 ? `${normalized}。` : normalized;
}

function completeSentenceEndAfter(text, index) {
  for (let i = Math.max(0, index); i < text.length; i += 1) {
    if (COMPLETE_SOURCE_END_GLOBAL.test(text[i])) {
      COMPLETE_SOURCE_END_GLOBAL.lastIndex = 0;
      return i + 1;
    }
    COMPLETE_SOURCE_END_GLOBAL.lastIndex = 0;
  }
  return -1;
}

function previousSectionStart(text, index) {
  const sectionPattern = /[(（][一二三四五六七八九十\d]+[)）]\s*/g;
  let match;
  let found = -1;
  while ((match = sectionPattern.exec(text))) {
    if (match.index >= index) break;
    if (index - match.index <= 500) found = match.index;
  }
  return found;
}

function nextSectionStart(text, start) {
  const sectionPattern = /[(（][一二三四五六七八九十\d]+[)）]\s*/g;
  sectionPattern.lastIndex = Math.min(text.length, start + 40);
  let match;
  while ((match = sectionPattern.exec(text))) {
    if (match.index - start >= 120) return match.index;
  }
  return -1;
}

function answerBasisItems(question) {
  const keyPoints = Array.isArray(question?.keyPoints)
    ? question.keyPoints.map(normalizeText).filter((point) => point && !isMetaPoint(point, question?.title) && isLikelyInQuestionScope(point, question?.title))
    : [];
  if (keyPoints.length) return keyPoints;

  const correctOptionText = Array.isArray(question?.options)
    ? normalizeText(question.options.find((item) => String(item.label) === String(question?.correctAnswer))?.text)
    : "";

  return [correctOptionText, question?.correctAnswer, question?.explanation, question?.evidenceQuote]
    .map(normalizeText)
    .filter((item) => item.length >= 4);
}

function excerptAroundAnswerBasis(sourceText, question, basisOverride = null) {
  const text = normalizeText(sourceText);
  if (!text) return "";

  const basisItems = Array.isArray(basisOverride) && basisOverride.length ? basisOverride : answerBasisItems(question);
  const hits = [];

  for (const [basisIndex, point] of basisItems.entries()) {
    const directIndex = text.indexOf(point);
    if (directIndex >= 0) {
      hits.push({ index: directIndex, length: point.length, basisIndex });
      continue;
    }

    const term = tokenize(point).find((item) => item.length >= 4 && text.includes(item));
    if (term) hits.push({ index: text.indexOf(term), length: term.length, basisIndex });
  }

  if (!hits.length) return "";

  hits.sort((left, right) => left.index - right.index);
  const firstHit = hits[0];
  const lastHit = hits[hits.length - 1];
  const lastBasisHit = [...hits].sort((left, right) => right.basisIndex - left.basisIndex || right.index - left.index)[0] || lastHit;
  const requiredEnd = completeSentenceEndAfter(text, lastBasisHit.index + lastBasisHit.length);
  let start = previousSentenceStart(text, firstHit.index);
  let end = Math.max(nextSentenceEnd(text, lastHit.index + lastHit.length), requiredEnd);
  const sectionStart = previousSectionStart(text, firstHit.index);

  const titleTerms = tokenize(question?.title || "").filter((term) => !/简述|论述|分析|说明|原因|特点|意义|影响|作用/.test(term));
  const titleHit = titleTerms
    .map((term) => text.indexOf(term))
    .filter((index) => index >= 0 && index <= firstHit.index)
    .sort((left, right) => right - left)[0];

  if (sectionStart >= 0) {
    start = sectionStart;
  } else if (titleHit !== undefined && firstHit.index - titleHit <= 500) {
    start = previousSentenceStart(text, titleHit);
  }

  const sectionEnd = nextSectionStart(text, start);
  if (sectionStart >= 0) {
    if (sectionEnd > start) {
      const minimumEnd = requiredEnd > 0 ? requiredEnd : end;
      end = Math.min(sectionEnd, Math.max(start + 1200, minimumEnd));
    } else {
      end = requiredEnd > 0 ? requiredEnd : Math.min(text.length, start + 1000);
    }
  }

  if (end <= start) end = Math.min(text.length, lastHit.index + lastHit.length);
  if (sectionStart < 0 && end - start > 1000) {
    start = sectionStart >= 0 ? sectionStart : previousSentenceStart(text, firstHit.index);
    end = nextSentenceEnd(text, lastHit.index + lastHit.length);
    const tighterSectionEnd = nextSectionStart(text, start);
    if (tighterSectionEnd > end && tighterSectionEnd - start <= 1200) end = tighterSectionEnd;
  }

  return endAtCompleteSentence(text.slice(start, end));
}

function sourceExcerpt(question, result) {
  const sourceText = normalizeText(question?.sourceText);
  const evidenceQuote = normalizeText(question?.evidenceQuote);
  const standards = cleanDisplayStandards(question, result);
  const answerBasis = excerptAroundAnswerBasis(sourceText, question, standards);

  if (answerBasis) return endAtCompleteSentence(answerBasis);
  if (evidenceQuote) return endAtCompleteSentence(evidenceQuote);
  if (!sourceText) return "";

  const titleTerms = tokenize(question?.title || "");
  const titleHit = titleTerms
    .map((term) => sourceText.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  return endAtCompleteSentence(titleHit === undefined ? sentenceExcerpt(sourceText, 0) : sentenceExcerpt(sourceText, titleHit, 180, 700));
}

export default function ResultPage() {
  const { sessionId, questionIndex } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [fullSourceOpen, setFullSourceOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [redoing, setRedoing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getSession(sessionId)
      .then((cached) => {
        if (!cancelled) setSession(cached);
        return api.getSession(sessionId, { forceRefresh: true });
      })
      .then((fresh) => {
        if (!cancelled) setSession(fresh);
      })
      .catch((error) => {
        console.warn("Session load failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const index = Number(questionIndex);
  const record = useMemo(() => session?.answers.find((item) => item.questionIndex === index), [session, index]);
  const result = record?.result;
  const excerpt = useMemo(() => sourceExcerpt(record?.question, result), [record, result]);
  const fullSource = normalizeText(record?.question?.sourceText || record?.question?.evidenceQuote || result?.sourceText || result?.evidenceQuote);

  async function next() {
    setFinishing(true);
    try {
      const latest = await api.getSession(sessionId, { forceRefresh: true, preserveLocalProgress: true });
      setSession(latest);
      const latestQuestions = Array.isArray(latest?.questions) ? latest.questions : session.questions;
      if (index >= latestQuestions.length - 1) {
        await api.finishSession(sessionId);
        navigate(`/summary/${sessionId}`);
        return;
      }
      updateState((draft) => {
        const current = draft.sessions.find((item) => item.id === sessionId);
        if (current) current.currentIndex = index + 1;
      });
      navigate(`/quiz/${sessionId}`);
    } finally {
      setFinishing(false);
    }
  }

  async function redo() {
    if (!record?.questionId || redoing) return;
    setRedoing(true);
    await api.deleteSessionAnswer({ sessionId, questionId: record.questionId });
    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      if (!current) return;
      current.currentIndex = index;
      current.answers = (current.answers || []).filter((item) => item.questionIndex !== index);
    });
    navigate(`/quiz/${sessionId}`);
  }

  if (!session || !record || !result) return <div className="skeleton-page" />;

  const subjective = record.question.type !== "single";
  const displayStandards = cleanDisplayStandards(record.question, result);
  const coveredPoints = alignDisplayPoints(Array.isArray(result.coveredPoints) ? result.coveredPoints : [], displayStandards);
  const missedPoints = alignDisplayPoints(Array.isArray(result.missedPoints) ? result.missedPoints : [], displayStandards).filter((point) => !coveredPoints.includes(point));
  const matchedSourceStandards = displayStandards.filter((point) => fullSource.includes(point) || bigramOverlap(fullSource, point) >= 0.35);
  const sourceLooksMatched = !displayStandards.length || matchedSourceStandards.length >= Math.min(2, displayStandards.length);
  const hasStandardBasis =
    coveredPoints.length > 0 ||
    missedPoints.length > 0 ||
    fullSource ||
    normalizeText(record.question.explanation || record.question.evidenceQuote || result.evidenceQuote);

  return (
    <div className="stack">
      <section className={`result-hero ${result.isCorrect ? "good" : "bad"}`}>
        <div className="result-icon">{result.isCorrect ? <CheckCircle2 size={30} /> : <XCircle size={30} />}</div>
        <p className="eyebrow muted">单题结果</p>
        <h1>{subjective ? `得分 ${percent(result.accuracy)}` : result.isCorrect ? "回答正确" : "回答错误"}</h1>
        <p>{normalizeText(result.advice)}</p>
      </section>

      <div className="summary-strip">
        <Metric label="题型" value={subjective ? "主观题" : "客观题"} />
        <Metric label="入错题本" value={result.isCorrect ? "否" : "是"} tone={result.isCorrect ? "good" : "warn"} />
      </div>

      {subjective && (
        <section className="feedback-card">
          <h2>答案要点</h2>
          <div className="point-group">
            <h3>
              <CheckCircle2 size={18} />
              已覆盖要点
            </h3>
            {coveredPoints.length ? (
              coveredPoints.map((point) => (
                <p className="point good" key={point}>
                  {normalizeText(point)}
                </p>
              ))
            ) : (
              <p className="point bad">暂未覆盖有效要点</p>
            )}
          </div>
          <div className="point-group">
            <h3>
              <XCircle size={18} />
              遗漏要点
            </h3>
            {missedPoints.length ? (
              missedPoints.map((point) => (
                <p className="point bad" key={point}>
                  {normalizeText(point)}
                </p>
              ))
            ) : !hasStandardBasis ? (
              <p className="point bad">本题缺少可核对的标准要点，请重新生成这道题。</p>
            ) : (
              <p className="point good">没有明显遗漏要点</p>
            )}
          </div>
        </section>
      )}

      <section className="source-card">
        <button type="button" onClick={() => setSourceOpen((value) => !value)}>
          <span>原文出处</span>
          <ChevronDown size={18} className={sourceOpen ? "up" : ""} />
        </button>
        {sourceOpen && (
          <div className="source-body">
            <p>{sourceLooksMatched ? excerpt || fullSource || "暂无可展示的原文片段。" : "这道旧题保存的原文出处与当前题目要点不匹配，建议重新生成这道题。"}</p>
            {sourceLooksMatched && fullSource.length > excerpt.length && (
              <>
                <button className="text-link source-toggle" type="button" onClick={() => setFullSourceOpen((value) => !value)}>
                  {fullSourceOpen ? "收起完整片段" : "查看完整片段"}
                </button>
                {fullSourceOpen && (
                  <div className="source-full" onWheel={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()}>
                    <p>{fullSource}</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>

      <div className="action-row result-action-row">
        {subjective && (
          <LoadingButton className="secondary-button" type="button" loading={redoing} loadingText="正在回到原题" onClick={redo} disabled={finishing}>
            <RotateCcw size={18} />
            重新作答
          </LoadingButton>
        )}
        <LoadingButton className="primary-button grow" loading={finishing} onClick={next}>
          {index >= session.questions.length - 1 ? "查看总结" : "下一题"}
          <ArrowRight size={18} />
        </LoadingButton>
      </div>
    </div>
  );
}
