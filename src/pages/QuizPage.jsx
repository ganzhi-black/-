import { ArrowLeft, CheckCircle2, Send, SkipForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import ProgressDots from "../components/ProgressDots.jsx";
import VoiceAnswer from "../components/VoiceAnswer.jsx";
import { api } from "../services/api.js";
import { updateState } from "../services/storage.js";

function questionTypeLabel(type) {
  if (type === "single") return "Single choice";
  if (type === "term") return "Term";
  if (type === "short") return "Short answer";
  return "Essay";
}

function safeIndex(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export default function QuizPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [skipLoading, setSkipLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getSession(sessionId).then(setSession);
  }, [sessionId]);

  const questions = Array.isArray(session?.questions) ? session.questions : [];
  const answers = Array.isArray(session?.answers) ? session.answers : [];
  const currentIndex = safeIndex(session?.currentIndex);
  const question = questions[currentIndex];
  const options = Array.isArray(question?.options) ? question.options : [];

  const previousAnswer = useMemo(() => {
    if (!question) return "";
    return answers.find((item) => item.questionIndex === currentIndex)?.userAnswer || "";
  }, [answers, currentIndex, question]);

  useEffect(() => {
    setAnswer(previousAnswer);
    setError("");
  }, [previousAnswer, question?.id]);

  async function submit() {
    if (!answer || !question || loading) return;
    setLoading(true);
    setError("");

    try {
      await api.submitAnswer({ sessionId, questionIndex: currentIndex, answer, sessionSnapshot: session });
      navigate(`/result/${sessionId}/${currentIndex}`);
    } catch (submitError) {
      const message = submitError.message || "";
      setError(message.includes("Cannot read") ? "Grading data is out of sync. Please refresh and retry." : message || "Grading failed. Please retry.");
      setLoading(false);
    }
  }

  async function skip() {
    if (!session || skipLoading) return;
    setSkipLoading(true);
    const nextIndex = currentIndex + 1;
    const isLast = currentIndex >= questions.length - 1;

    updateState((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      if (!current) return;
      current.skippedQuestionIndexes = Array.from(new Set([...(current.skippedQuestionIndexes || []), currentIndex]));
      if (!isLast) current.currentIndex = nextIndex;
    });

    if (isLast) {
      await api.finishSession(sessionId);
      navigate(`/summary/${sessionId}`);
      return;
    }

    setSession((current) => ({
      ...current,
      currentIndex: nextIndex,
      skippedQuestionIndexes: Array.from(new Set([...(current?.skippedQuestionIndexes || []), currentIndex])),
    }));
    setAnswer("");
    setSkipLoading(false);
  }

  if (!session || !question) return <div className="skeleton-page" />;

  return (
    <div className="stack quiz-page">
      <section className="quiz-head">
        <Link className="icon-button" to="/">
          <ArrowLeft size={19} />
        </Link>
        <div>
          <p>
            Question {currentIndex + 1} / {questions.length}
          </p>
          <ProgressDots total={questions.length} current={currentIndex} />
        </div>
      </section>

      <section className="question-panel">
        <span className="type-pill">{questionTypeLabel(question.type)}</span>
        <h1>{question.title}</h1>
      </section>

      {question.type === "single" ? (
        <div className="answers-list">
          {options.map((option) => (
            <button key={option.label} className={`answer-option ${answer === option.label ? "selected" : ""}`} onClick={() => setAnswer(option.label)} disabled={loading || skipLoading}>
              <span>{option.label}</span>
              <strong>{option.text}</strong>
              {answer === option.label ? <CheckCircle2 size={18} /> : null}
            </button>
          ))}
        </div>
      ) : (
        <VoiceAnswer value={answer} onChange={setAnswer} disabled={loading || skipLoading} />
      )}

      {error && <div className="notice error">{error}</div>}

      <LoadingButton className="primary-button full" loading={loading} loadingText="Grading..." onClick={submit} disabled={!answer || skipLoading}>
        Submit
        <Send size={18} />
      </LoadingButton>
      <LoadingButton className="secondary-button full" loading={skipLoading} onClick={skip} disabled={loading}>
        Skip
        <SkipForward size={18} />
      </LoadingButton>
    </div>
  );
}
