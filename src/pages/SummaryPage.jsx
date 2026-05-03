import { ArrowRight, Home, LibraryBig, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api } from "../services/mockApi.js";

export default function SummaryPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getSession(sessionId).then(setSession);
  }, [sessionId]);

  const summary = useMemo(() => {
    if (!session) return null;
    const correctCount = session.answers.filter((item) => item.result.isCorrect).length;
    return session.summary || {
      total: session.questions.length,
      correctCount,
      rate: Math.round((correctCount / session.questions.length) * 100),
      mistakeCount: session.answers.filter((item) => !item.result.isCorrect).length,
    };
  }, [session]);

  async function again() {
    setLoading(true);
    const next = await api.createSession({
      subjectId: session.subjectId,
      types: ["single", "short", "essay"],
      amount: session.questions.length,
      mode: session.mode,
    });
    navigate(`/quiz/${next.id}`);
  }

  if (!session || !summary) return <div className="skeleton-page" />;

  return (
    <div className="stack">
      <section className="result-hero good">
        <p className="eyebrow muted">本轮总结</p>
        <h1>答对率 {summary.rate}%</h1>
        <p>本轮训练已保存，错题会自动进入错题本，方便考前集中攻克。</p>
      </section>
      <div className="summary-strip three">
        <Metric label="总题数" value={summary.total} />
        <Metric label="答对" value={summary.correctCount} tone="good" />
        <Metric label="新增错题" value={summary.mistakeCount} tone="warn" />
      </div>
      <LoadingButton className="primary-button full" loading={loading} onClick={again}>
        <RotateCcw size={18} />
        继续练习
      </LoadingButton>
      <Link className="secondary-button full" to="/mistakes">
        <LibraryBig size={18} />
        查看错题本
        <ArrowRight size={18} />
      </Link>
      <Link className="ghost-button full" to={`/subjects/${session.subjectId}/settings`}>
        <Home size={18} />
        返回科目主页
      </Link>
    </div>
  );
}
