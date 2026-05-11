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

function previousSentenceStart(text, index) {
  for (let i = Math.max(0, index - 1); i >= 0; i -= 1) {
    if (SENTENCE_END.test(text[i]) || text[i] === "\n") {
      return Math.min(text.length, i + 1);
    }
  }
  return 0;
}

function nextSentenceEnd(text, index) {
  for (let i = Math.max(0, index); i < text.length; i += 1) {
    if (SENTENCE_END.test(text[i]) || text[i] === "\n") {
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

function sourceExcerpt(question, result) {
  const sourceText = normalizeText(result?.sourceText);
  const evidenceQuote = normalizeText(result?.evidenceQuote);

  if (evidenceQuote && sourceText) {
    const quoteIndex = sourceText.indexOf(evidenceQuote);
    if (quoteIndex >= 0) return sentenceExcerpt(sourceText, quoteIndex, evidenceQuote.length, 360);
  }

  if (evidenceQuote) return evidenceQuote;
  if (!sourceText) return "";

  const searchTerms = tokenize(
    [
      question?.title,
      question?.correctAnswer,
      question?.explanation,
      ...(question?.options || []).map((item) => item.text),
      ...(question?.keyPoints || []),
    ].join(" "),
  );

  const hit = searchTerms
    .map((term) => sourceText.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  return sentenceExcerpt(sourceText, hit === undefined ? 0 : hit);
}

export default function ResultPage() {
  const { sessionId, questionIndex } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    api.getSession(sessionId).then(setSession);
  }, [sessionId]);

  const index = Number(questionIndex);
  const record = useMemo(() => session?.answers.find((item) => item.questionIndex === index), [session, index]);
  const result = record?.result;
  const excerpt = useMemo(() => sourceExcerpt(record?.question, result), [record, result]);

  async function next() {
    if (index >= session.questions.length - 1) {
      setFinishing(true);
      await api.finishSession(sessionId);
      navigate(`/summary/${sessionId}`);
      return;
    }
    session.currentIndex = index + 1;
    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      current.currentIndex = index + 1;
    });
    navigate(`/quiz/${sessionId}`);
  }

  function redo() {
    session.currentIndex = index;
    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      current.currentIndex = index;
      current.answers = current.answers.filter((item) => item.questionIndex !== index);
    });
    navigate(`/quiz/${sessionId}`);
  }

  if (!session || !record || !result) return <div className="skeleton-page" />;

  const subjective = record.question.type !== "single";

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
            {result.coveredPoints.length ? (
              result.coveredPoints.map((point) => (
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
            {result.missedPoints.length ? (
              result.missedPoints.map((point) => (
                <p className="point bad" key={point}>
                  {normalizeText(point)}
                </p>
              ))
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
            <p>{excerpt}</p>
          </div>
        )}
      </section>

      <div className="action-row result-action-row">
        {subjective && (
          <button className="secondary-button" type="button" onClick={redo}>
            <RotateCcw size={18} />
            重新作答
          </button>
        )}
        <LoadingButton className="primary-button grow" loading={finishing} onClick={next}>
          {index >= session.questions.length - 1 ? "查看总结" : "下一题"}
          <ArrowRight size={18} />
        </LoadingButton>
      </div>
    </div>
  );
}
