import { ArrowRight, Home, LibraryBig, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api, track } from "../services/api.js";
import { updateState } from "../services/storage.js";

export default function SummaryPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getSession(sessionId)
      .then((cached) => {
        if (!cancelled) setSession(cached);
        return api.getSession(sessionId, { forceRefresh: true, preserveLocalProgress: true });
      })
      .then((fresh) => {
        if (!cancelled) setSession(fresh);
      })
      .catch((error) => {
        console.warn("Summary session load failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const summary = useMemo(() => {
    if (!session) return null;
    const skippedCount = new Set(session.skippedQuestionIndexes || []).size;
    const answeredCount = session.answers.length;
    const correctCount = session.answers.filter((item) => item.result.isCorrect).length;
    return session.summary || {
      total: session.questions.length,
      answeredCount,
      skippedCount,
      correctCount,
      rate: answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0,
      mistakeCount: session.answers.filter((item) => !item.result.isCorrect).length,
    };
  }, [session]);

  useEffect(() => {
    if (session && summary?.mistakeCount > 0) {
      track("summary_mistakes_cta_viewed", {
        sessionId,
        subjectId: session.subjectId,
        mistakeCount: summary.mistakeCount,
      });
    }
  }, [session, summary?.mistakeCount, sessionId]);

  useEffect(() => {
    if (!session) return;
    const total = Array.isArray(session.questions) ? session.questions.length : 0;
    const answered = Math.max(Number(session.summary?.answeredCount || 0), Array.isArray(session.answers) ? session.answers.length : 0);
    const skipped = Math.max(Number(session.summary?.skippedCount || 0), new Set(session.skippedQuestionIndexes || []).size);
    if (total > 0 && answered + skipped < total) {
      const nextIndex = Math.min(total - 1, answered + skipped);
      updateState((draft) => {
        const current = draft.sessions.find((item) => item.id === sessionId);
        if (current) current.currentIndex = nextIndex;
      });
      navigate(`/quiz/${sessionId}`, { replace: true });
    }
  }, [navigate, session, sessionId]);

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
        <p className="eyebrow muted">练习总结</p>
        <h1>正确率 {summary.rate}%</h1>
        <p>跳过的题不会进入错题本，也不会计入正确率。可以稍后回到资料继续覆盖未练习内容。</p>
      </section>
      <div className="summary-strip three">
        <Metric label="已作答" value={summary.answeredCount} />
        <Metric label="答对" value={summary.correctCount} tone="good" />
        <Metric label="错题" value={summary.mistakeCount} tone="warn" />
      </div>
      <div className="summary-strip">
        <Metric label="总题数" value={summary.total} />
        <Metric label="已跳过" value={summary.skippedCount || 0} />
      </div>
      <LoadingButton className="primary-button full" loading={loading} onClick={again}>
        <RotateCcw size={18} />
        再练一组
      </LoadingButton>
      <Link className="secondary-button full" to="/mistakes" onClick={() => track("summary_mistakes_clicked", { sessionId, subjectId: session.subjectId })}>
        <LibraryBig size={18} />
        查看错题本
        <ArrowRight size={18} />
      </Link>
      <Link className="ghost-button full" to={`/subjects/${session.subjectId}/settings`}>
        <Home size={18} />
        返回练习设置
      </Link>
    </div>
  );
}
