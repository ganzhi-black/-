import { ArrowLeft, BookMarked, Clock3, FileText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import EmptyState from "../components/EmptyState.jsx";
import { api } from "../services/api.js";
import { cnDateTime } from "../utils/format.js";

function looksBroken(text = "") {
  return /[�ÃÂÄÅÆäåæðÐ]/.test(text) || /\?{3,}/.test(text);
}

function cleanName(name, fallback) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return fallback;
  const withoutQuestionMarks = trimmed.replace(/\?{2,}/g, "").trim();
  if (withoutQuestionMarks && withoutQuestionMarks !== trimmed) return withoutQuestionMarks;
  return looksBroken(trimmed) ? fallback : trimmed;
}

function displayFileName(subject) {
  const fileName = String(subject.sourceFileName || "").trim();
  if (!fileName) return subject.documentCount ? "已上传资料" : "";
  if (looksBroken(fileName)) {
    const extension = fileName.match(/\.[a-z0-9]+$/i)?.[0] || "";
    return `${cleanName(subject.name, "已上传资料")}${extension}`;
  }
  return fileName;
}

export default function HistorySubjectsPage() {
  const [dashboard, setDashboard] = useState(null);
  const [deletingId, setDeletingId] = useState("");

  async function load() {
    setDashboard(await api.getDashboard());
  }

  useEffect(() => {
    load();
    window.addEventListener("qimoshua:state-change", load);
    return () => window.removeEventListener("qimoshua:state-change", load);
  }, []);

  async function deleteSubject(event, subject) {
    event.preventDefault();
    event.stopPropagation();
    const confirmed = window.confirm(`确定删除「${cleanName(subject.name, "这份资料")}」吗？删除后资料切片和生成记录也会一起删除。`);
    if (!confirmed) return;

    setDeletingId(subject.id);
    try {
      await api.deleteSubject(subject.id);
      await load();
    } finally {
      setDeletingId("");
    }
  }

  if (!dashboard) return <div className="skeleton-page" />;

  return (
    <div className="stack">
      <section className="page-title">
        <Link className="text-link" to="/upload">
          <ArrowLeft size={16} />
          返回上传
        </Link>
        <p className="eyebrow muted">历史科目</p>
        <h1>继续使用已上传资料</h1>
        <p>点击科目后，会进入这门课的练习设置页，可以继续选择题型和题量出题。</p>
      </section>

      {dashboard.subjects.length === 0 ? (
        <EmptyState title="还没有历史科目" description="上传一份复习资料后，可以在这里继续练习。" actionText="上传资料" to="/upload" />
      ) : (
        <div className="subject-grid history-subject-grid">
          {dashboard.subjects.map((subject) => (
            <div className="subject-card history-subject-card" key={subject.id}>
              <Link className="subject-card-link" to={`/subjects/${subject.id}/settings`}>
                <div className="subject-icon">
                  <BookMarked size={22} />
                </div>
                <div>
                  <h3>{cleanName(subject.name, "未命名科目")}</h3>
                  <p>{displayFileName(subject)}</p>
                </div>
                <div className="subject-meta">
                  <span>
                    <FileText size={15} />
                    {subject.generatedQuestionCount || 0} 道题已生成
                  </span>
                  <span>
                    <Clock3 size={15} />
                    {cnDateTime(subject.lastPracticeAt || subject.createdAt)}
                  </span>
                </div>
              </Link>
              <button className="subject-delete-button" type="button" disabled={deletingId === subject.id} onClick={(event) => deleteSubject(event, subject)}>
                <Trash2 size={16} />
                {deletingId === subject.id ? "删除中" : "删除"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
