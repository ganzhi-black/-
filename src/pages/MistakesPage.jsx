import { ArrowRight, BookOpen, CheckCircle2, LibraryBig, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import EmptyState from "../components/EmptyState.jsx";
import LoadingButton from "../components/LoadingButton.jsx";
import { api } from "../services/mockApi.js";
import { cnDateTime, percent } from "../utils/format.js";

export default function MistakesPage() {
  const navigate = useNavigate();
  const [mistakes, setMistakes] = useState(null);
  const [loadingId, setLoadingId] = useState("");

  useEffect(() => {
    const load = () => api.getMistakes().then(setMistakes);
    load();
    window.addEventListener("qimoshua:state-change", load);
    return () => window.removeEventListener("qimoshua:state-change", load);
  }, []);

  async function retry(items) {
    if (!items.length) return;
    setLoadingId(items.length === 1 ? items[0].id : "all");
    const session = await api.createSession({
      subjectId: items[0].subjectId,
      types: ["single"],
      amount: items.length,
      mode: "strict",
      retryQuestions: items,
    });
    navigate(`/quiz/${session.id}`);
  }

  if (!mistakes) return <div className="skeleton-page" />;

  return (
    <div className="stack">
      <section className="page-title">
        <p className="eyebrow muted">错题本</p>
        <h1>集中攻克薄弱点</h1>
        <p>客观题答错、主观题准确率低于 70% 会自动入库；重做达标后自动移出。</p>
      </section>

      {mistakes.length === 0 ? (
        <EmptyState title="你还没有错题" description="继续练习，系统会帮你自动整理薄弱题目。" actionText="去练习" to="/" />
      ) : (
        <>
          <LoadingButton className="primary-button full" loading={loadingId === "all"} onClick={() => retry(mistakes)}>
            <RotateCcw size={18} />
            全部重做
          </LoadingButton>
          <div className="mistake-list">
            {mistakes.map((item) => (
              <article className="mistake-card" key={item.id}>
                <div className="mistake-top">
                  <span className="type-pill">{item.question.type === "single" ? "选择题" : item.question.type === "short" ? "简答题" : "论述题"}</span>
                  <span>{cnDateTime(item.updatedAt)}</span>
                </div>
                <h2>{item.question.title}</h2>
                <p>{item.lastResult.advice}</p>
                <div className="mistake-meta">
                  <span>
                    <LibraryBig size={15} />
                    上次 {percent(item.lastAccuracy)}
                  </span>
                  <span>
                    <BookOpen size={15} />
                    {item.lastResult.sourceLocation}
                  </span>
                </div>
                <div className="mistake-actions">
                  <LoadingButton className="secondary-button" loading={loadingId === item.id} onClick={() => retry([item])}>
                    <RotateCcw size={17} />
                    单题重做
                  </LoadingButton>
                  <Link className="text-link" to={`/subjects/${item.subjectId}/settings`}>
                    练同科目
                    <ArrowRight size={16} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <div className="notice success">
            <CheckCircle2 size={17} />
            重做后答对或准确率达到 70%，题目会自动移出这里。
          </div>
        </>
      )}
    </div>
  );
}
