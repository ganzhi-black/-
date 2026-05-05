import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, LibraryBig, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import EmptyState from "../components/EmptyState.jsx";
import LoadingButton from "../components/LoadingButton.jsx";
import { api } from "../services/api.js";
import { cnDateTime, percent } from "../utils/format.js";
import { repairText } from "../utils/textRepair.js";

function questionTypeLabel(type) {
  if (type === "single") return "单选题";
  if (type === "term") return "名词解释";
  if (type === "short") return "简答题";
  return "论述题";
}

export default function MistakesPage() {
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [mistakes, setMistakes] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [loadingId, setLoadingId] = useState("");

  useEffect(() => {
    const load = async () => {
      const [nextMistakes, nextDashboard] = await Promise.all([api.getMistakes(subjectId), api.getDashboard()]);
      setMistakes(nextMistakes);
      setDashboard(nextDashboard);
    };
    load();
    window.addEventListener("qimoshua:state-change", load);
    return () => window.removeEventListener("qimoshua:state-change", load);
  }, [subjectId]);

  const subject = useMemo(() => dashboard?.subjects.find((item) => item.id === subjectId), [dashboard, subjectId]);

  const groups = useMemo(() => {
    if (!dashboard || !mistakes) return [];
    return dashboard.subjects
      .map((item) => {
        const items = mistakes.filter((mistake) => mistake.subjectId === item.id);
        const latest = items.reduce((time, mistake) => {
          const value = new Date(mistake.updatedAt || mistake.createdAt).getTime();
          return Math.max(time, value);
        }, 0);
        return { subject: item, mistakes: items, latest };
      })
      .filter((group) => group.mistakes.length > 0);
  }, [dashboard, mistakes]);

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

  if (!mistakes || !dashboard) return <div className="skeleton-page" />;

  if (!subjectId) {
    return (
      <div className="stack">
        <section className="page-title">
          <h1>错题本</h1>
          <p>按科目整理答错的题，重新练习后如果达到通过线，会自动从错题本中移除。</p>
        </section>

        {groups.length === 0 ? (
          <EmptyState title="暂时还没有错题" description="继续练习，答错的题会自动出现在这里。" actionText="返回首页" to="/" />
        ) : (
          <div className="subject-grid mistake-subject-grid">
            {groups.map((group) => (
              <Link className="subject-card mistake-subject-card" key={group.subject.id} to={`/mistakes/${group.subject.id}`}>
                <div className="subject-icon">
                  <LibraryBig size={22} />
                </div>
                <div>
                  <h3>{group.subject.name}</h3>
                  <p>{group.mistakes.length} 道错题待重做</p>
                </div>
                <div className="subject-meta">
                  <span>
                    <BookOpen size={15} />
                    {repairText(group.subject.sourceFileName)}
                  </span>
                  <span>{group.latest ? cnDateTime(group.latest) : "暂无时间"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="page-title">
        <Link className="text-link" to="/mistakes">
          <ArrowLeft size={16} />
          返回错题本
        </Link>
        <p className="eyebrow muted">错题本</p>
        <h1>{subject?.name || "当前科目"}</h1>
        <p>这里会保留本门课答错的题。重新作答通过后，题目会自动移出错题本。</p>
      </section>

      {mistakes.length === 0 ? (
        <EmptyState title="这门课还没有错题" description="继续练习，产生的错题会自动出现在这里。" actionText="返回错题本" to="/mistakes" />
      ) : (
        <>
          <LoadingButton className="primary-button full" loading={loadingId === "all"} onClick={() => retry(mistakes)}>
            <RotateCcw size={18} />
            重做全部错题
          </LoadingButton>
          <div className="mistake-list">
            {mistakes.map((item) => (
              <article className="mistake-card" key={item.id}>
                <div className="mistake-top">
                  <span className="type-pill">{questionTypeLabel(item.question.type)}</span>
                  <span>{cnDateTime(item.updatedAt || item.createdAt)}</span>
                </div>
                <h2>{repairText(item.question.title)}</h2>
                <p>{repairText(item.lastResult.advice)}</p>
                <div className="mistake-meta">
                  <span>
                    <LibraryBig size={15} />
                    得分 {percent(item.lastAccuracy)}
                  </span>
                  <span>
                    <BookOpen size={15} />
                    {repairText(item.lastResult.sourceLocation || "原文出处")}
                  </span>
                </div>
                <div className="mistake-actions">
                  <LoadingButton className="secondary-button" loading={loadingId === item.id} onClick={() => retry([item])}>
                    <RotateCcw size={17} />
                    重做
                  </LoadingButton>
                  <Link className="text-link" to={`/subjects/${item.subjectId}/settings`}>
                    回到练习设置
                    <ArrowRight size={16} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <div className="notice success">
            <CheckCircle2 size={17} />
            错题重做通过后会自动移出错题本。
          </div>
        </>
      )}
    </div>
  );
}
