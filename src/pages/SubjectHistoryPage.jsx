import { AlertCircle, ArrowLeft, Check, Eye, FileQuestion, History, ListChecks, PlusCircle, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import EmptyState from "../components/EmptyState.jsx";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api } from "../services/api.js";
import { cnDateTime } from "../utils/format.js";
import { repairText } from "../utils/textRepair.js";

const typeOptions = [
  { id: "single", label: "单选题", desc: "检查概念和细节记忆" },
  { id: "term", label: "名词解释", desc: "背诵核心概念" },
  { id: "short", label: "简答题", desc: "训练要点作答" },
  { id: "essay", label: "论述题", desc: "训练分析展开" },
];

const typeLabels = {
  single: "单选题",
  term: "名词解释",
  short: "简答题",
  essay: "论述题",
};

export default function SubjectHistoryPage() {
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [subject, setSubject] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [types, setTypes] = useState(["single", "short", "essay"]);
  const [amount, setAmount] = useState(6);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expandedQuestionId, setExpandedQuestionId] = useState("");
  const [deletingQuestionId, setDeletingQuestionId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([api.getSubject(subjectId), api.getSubjectQuestions(subjectId)])
      .then(([nextSubject, nextQuestions]) => {
        if (cancelled) return;
        setSubject(nextSubject);
        setQuestions(Array.isArray(nextQuestions) ? nextQuestions : []);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subjectId]);

  const skippedCount = useMemo(() => questions.filter((question) => question.wasSkipped).length, [questions]);

  function toggleType(type) {
    setTypes((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]));
  }

  async function createQuestions() {
    if (!subject?.chunkCount) {
      setError("这门科目还没有可用的资料切片，请先重新上传资料。");
      return;
    }

    setCreating(true);
    setError("");
    try {
      const session = await api.createSession({
        subjectId,
        types: types.length ? types : ["single"],
        amount: Math.min(50, Math.max(1, Number(amount) || 1)),
        mode: "relaxed",
      });
      navigate(`/quiz/${session.id}`);
    } catch (nextError) {
      setError(nextError.message);
      setCreating(false);
    }
  }

  async function deleteQuestion(question) {
    const confirmed = window.confirm(`确定删除这道历史题吗？\n${question.title}`);
    if (!confirmed) return;

    setDeletingQuestionId(question.id);
    setError("");
    try {
      await api.deleteSubjectQuestion({ subjectId, questionId: question.id });
      setQuestions((current) => current.filter((item) => item.id !== question.id));
      if (expandedQuestionId === question.id) setExpandedQuestionId("");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setDeletingQuestionId("");
    }
  }

  if (loading) return <div className="skeleton-page" />;

  if (error && !subject) {
    return <EmptyState title="历史科目加载失败" description={error} actionText="返回历史科目" to="/subjects/history" />;
  }

  return (
    <div className="stack subject-history-page">
      <section className="page-title">
        <Link className="text-link" to="/subjects/history">
          <ArrowLeft size={16} />
          返回历史科目
        </Link>
        <p className="eyebrow muted">资料历史</p>
        <h1>{subject?.name || "未命名科目"}</h1>
        <p>{repairText(subject?.sourceFileName || "基于这份资料管理历史题目和继续出题。")}</p>
      </section>

      <div className="summary-strip">
        <Metric label="历史题目" value={questions.length} />
        <Metric label="曾跳过" value={skippedCount} tone={skippedCount ? "warn" : "good"} />
        <Metric label="资料切片" value={subject?.chunkCount || 0} />
      </div>

      <section className="setting-card history-question-module">
        <div className="setting-title">
          <History size={20} />
          <h2>查看历史题目</h2>
        </div>
        {questions.length === 0 ? (
          <EmptyState title="还没有历史题目" description="先用这份资料生成一组题，之后所有历史题都会沉淀在这里。" />
        ) : (
          <div className="history-question-list">
            {questions.map((question, index) => (
              <article className="history-question-item" key={question.id || `${question.title}-${index}`}>
                <div className="history-question-head">
                  <span>{typeLabels[question.type] || "题目"}</span>
                  {question.wasSkipped && <strong>曾跳过</strong>}
                </div>
                <h3>{question.title}</h3>
                <div className="history-question-actions">
                  <small>{cnDateTime(question.createdAt || question.generatedAt)}</small>
                  <button type="button" onClick={() => setExpandedQuestionId((current) => (current === question.id ? "" : question.id))}>
                    <Eye size={16} />
                    {expandedQuestionId === question.id ? "收起详情" : "查看详情"}
                  </button>
                  <button className="danger-action" type="button" disabled={deletingQuestionId === question.id} onClick={() => deleteQuestion(question)}>
                    <Trash2 size={16} />
                    {deletingQuestionId === question.id ? "删除中" : "删除"}
                  </button>
                </div>
                {expandedQuestionId === question.id && (
                  <div className="history-question-detail">
                    {Array.isArray(question.keyPoints) && question.keyPoints.length > 0 && (
                      <div className="history-detail-block">
                        <h4>答案要点</h4>
                        <ul className="history-points">
                          {question.keyPoints.map((point) => (
                            <li key={point}>{point}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(question.evidenceQuote || question.sourceText) && (
                      <div className="history-detail-block">
                        <h4>原文出处</h4>
                        <p>{question.evidenceQuote || question.sourceText}</p>
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="setting-card new-question-module">
        <div className="setting-title">
          <PlusCircle size={20} />
          <h2>新建题目</h2>
        </div>
        <p className="muted compact-copy">继续基于这份资料出题，系统会把历史题目加入避重清单，尽量不再重复出同一道题。</p>
        <div className="option-grid">
          {typeOptions.map((item) => (
            <button key={item.id} type="button" className={`choice-card ${types.includes(item.id) ? "selected" : ""}`} onClick={() => toggleType(item.id)} disabled={creating}>
              <span className="check-dot">{types.includes(item.id) ? <Check size={14} /> : null}</span>
              <strong>{item.label}</strong>
              <small>{item.desc}</small>
            </button>
          ))}
        </div>
        <label className="field compact-field">
          <span>
            <SlidersHorizontal size={16} />
            新建题数
          </span>
          <input type="number" min="1" max="50" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={creating} />
        </label>
        {error && (
          <div className="notice error">
            <AlertCircle size={17} />
            {error}
          </div>
        )}
        <LoadingButton className="primary-button full" loading={creating} loadingText="出题中，请您稍作等待" onClick={createQuestions}>
          <FileQuestion size={18} />
          生成新题
        </LoadingButton>
        <Link className="secondary-button full" to={`/subjects/${subjectId}/settings`}>
          <ListChecks size={18} />
          进入原练习设置
        </Link>
      </section>
    </div>
  );
}
