import { ArrowLeft, CheckCircle2, Send, SkipForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import ProgressDots from "../components/ProgressDots.jsx";
import VoiceAnswer from "../components/VoiceAnswer.jsx";
import { api } from "../services/api.js";
import { updateState } from "../services/storage.js";

function questionTypeLabel(type) {
  if (type === "single") return "单选题";
  if (type === "term") return "名词解释";
  if (type === "short") return "简答题";
  return "论述题";
}

export default function QuizPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [skipLoading, setSkipLoading] = useState(false);

  useEffect(() => {
    api.getSession(sessionId).then(setSession);
  }, [sessionId]);

  const question = session?.questions[session.currentIndex];
  const previousAnswer = useMemo(() => {
    if (!session || !question) return "";
    return session.answers.find((item) => item.questionIndex === session.currentIndex)?.userAnswer || "";
  }, [session, question]);

  useEffect(() => {
    setAnswer(previousAnswer);
  }, [previousAnswer, question?.id]);

  async function submit() {
    if (!answer) return;
    setLoading(true);
    await api.submitAnswer({ sessionId, questionIndex: session.currentIndex, answer });
    navigate(`/result/${sessionId}/${session.currentIndex}`);
  }

  async function skip() {
    if (!session || skipLoading) return;
    setSkipLoading(true);
    const currentIndex = session.currentIndex;
    const nextIndex = currentIndex + 1;
    const isLast = currentIndex >= session.questions.length - 1;

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
            第 {session.currentIndex + 1} 题 / 共 {session.questions.length} 题
          </p>
          <ProgressDots total={session.questions.length} current={session.currentIndex} />
        </div>
      </section>

      <section className="question-panel">
        <span className="type-pill">{questionTypeLabel(question.type)}</span>
        <h1>{question.title}</h1>
      </section>

      {question.type === "single" ? (
        <div className="answers-list">
          {question.options.map((option) => (
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

      <LoadingButton className="primary-button full" loading={loading} onClick={submit} disabled={!answer || skipLoading}>
        提交批改
        <Send size={18} />
      </LoadingButton>
      <LoadingButton className="secondary-button full" loading={skipLoading} onClick={skip} disabled={loading}>
        跳过此题
        <SkipForward size={18} />
      </LoadingButton>
    </div>
  );
}
