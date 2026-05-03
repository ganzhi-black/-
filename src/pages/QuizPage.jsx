import { ArrowLeft, CheckCircle2, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import ProgressDots from "../components/ProgressDots.jsx";
import VoiceAnswer from "../components/VoiceAnswer.jsx";
import { api } from "../services/mockApi.js";

export default function QuizPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

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

  if (!session || !question) return <div className="skeleton-page" />;

  return (
    <div className="stack quiz-page">
      <section className="quiz-head">
        <Link className="icon-button" to="/">
          <ArrowLeft size={19} />
        </Link>
        <div>
          <p>第 {session.currentIndex + 1} 题 / 共 {session.questions.length} 题</p>
          <ProgressDots total={session.questions.length} current={session.currentIndex} />
        </div>
      </section>

      <section className="question-panel">
        <span className="type-pill">{question.type === "single" ? "选择题" : question.type === "short" ? "简答题" : "论述题"}</span>
        <h1>{question.title}</h1>
      </section>

      {question.type === "single" ? (
        <div className="answers-list">
          {question.options.map((option) => (
            <button key={option.label} className={`answer-option ${answer === option.label ? "selected" : ""}`} onClick={() => setAnswer(option.label)} disabled={loading}>
              <span>{option.label}</span>
              <strong>{option.text}</strong>
              {answer === option.label ? <CheckCircle2 size={18} /> : null}
            </button>
          ))}
        </div>
      ) : (
        <VoiceAnswer value={answer} onChange={setAnswer} disabled={loading} />
      )}

      <LoadingButton className="primary-button full" loading={loading} onClick={submit} disabled={!answer}>
        提交批改
        <Send size={18} />
      </LoadingButton>
    </div>
  );
}
