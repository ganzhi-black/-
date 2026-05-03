import { ArrowRight, CheckCircle2, ChevronDown, RotateCcw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api } from "../services/mockApi.js";
import { updateState } from "../services/storage.js";
import { percent } from "../utils/format.js";

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
        <h1>{subjective ? `准确率 ${percent(result.accuracy)}` : result.isCorrect ? "回答正确" : "回答错误"}</h1>
        <p>{result.advice}</p>
      </section>

      <div className="summary-strip">
        <Metric label="题型" value={subjective ? "主观题" : "客观题"} />
        <Metric label="入错题本" value={result.isCorrect ? "否" : "是"} tone={result.isCorrect ? "good" : "warn"} />
      </div>

      {subjective && (
        <section className="feedback-card">
          <h2>要点核对</h2>
          <div className="point-group">
            <h3>
              <CheckCircle2 size={18} />
              你提到的要点
            </h3>
            {result.coveredPoints.map((point) => (
              <p className="point good" key={point}>
                {point}
              </p>
            ))}
          </div>
          <div className="point-group">
            <h3>
              <XCircle size={18} />
              你漏掉的要点
            </h3>
            {result.missedPoints.length ? (
              result.missedPoints.map((point) => (
                <p className="point bad" key={point}>
                  {point}
                </p>
              ))
            ) : (
              <p className="point good">本题关键点覆盖完整</p>
            )}
          </div>
        </section>
      )}

      <section className="source-card">
        <button type="button" onClick={() => setSourceOpen((value) => !value)}>
          <span>原文出处：{result.sourceLocation}</span>
          <ChevronDown size={18} className={sourceOpen ? "up" : ""} />
        </button>
        {sourceOpen && <p>{result.sourceText}</p>}
      </section>

      <div className="action-row">
        {subjective && (
          <button className="secondary-button" type="button" onClick={redo}>
            <RotateCcw size={18} />
            再说一遍
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
