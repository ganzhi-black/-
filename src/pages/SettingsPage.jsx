import { AlertCircle, ArrowRight, Check, FileQuestion, ListChecks, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import EmptyState from "../components/EmptyState.jsx";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api, track } from "../services/api.js";
import { repairText } from "../utils/textRepair.js";

const typeOptions = [
  { id: "single", label: "单选题", desc: "适合检查概念和细节记忆" },
  { id: "term", label: "名词解释", desc: "仅在资料含名词解释题时生成" },
  { id: "short", label: "简答题", desc: "200-400 字，定义/概念加核心要点" },
  { id: "essay", label: "论述题", desc: "500 字以上，需要分析阐释和展开" },
];

export default function SettingsPage() {
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [subject, setSubject] = useState(null);
  const [types, setTypes] = useState(["single", "short", "essay"]);
  const [amount, setAmount] = useState(6);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    setLoadError("");
    api
      .getSubject(subjectId)
      .then((nextSubject) => {
        if (nextSubject) setSubject(nextSubject);
        else setLoadError("没有找到这门科目，可能已经被删除。");
      })
      .catch((nextError) => setLoadError(nextError.message));
  }, [subjectId]);

  function toggleType(type) {
    setTypes((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]));
  }

  async function start() {
    if (!subject.chunkCount) {
      setError("这门科目还没有可用的资料切片，请先上传资料。");
      return;
    }
    setLoading(true);
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
      setLoading(false);
    }
  }

  if (loadError) {
    return <EmptyState title="科目加载失败" description={loadError} actionText="返回已上传资料" to="/subjects/history" />;
  }

  if (!subject) return <div className="skeleton-page" />;

  return (
    <div className="stack">
      <section className="page-title">
        <p className="eyebrow muted">练习设置</p>
        <h1>{subject.name}</h1>
        <p>{repairText(subject.sourceFileName)}</p>
      </section>

      <section className="setting-card">
        <div className="setting-title">
          <FileQuestion size={20} />
          <h2>题型</h2>
        </div>
        <div className="option-grid">
          {typeOptions.map((item) => (
            <button key={item.id} type="button" className={`choice-card ${types.includes(item.id) ? "selected" : ""}`} onClick={() => toggleType(item.id)}>
              <span className="check-dot">{types.includes(item.id) ? <Check size={14} /> : null}</span>
              <strong>{item.label}</strong>
              <small>{item.desc}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="setting-card">
        <div className="setting-title">
          <SlidersHorizontal size={20} />
          <h2>题量</h2>
        </div>
        <label className="field compact-field">
          <span>题量</span>
          <input type="number" min="1" max="50" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
      </section>

      <div className="summary-strip">
        <Metric label="资料切片" value={subject.chunkCount} />
        <Metric label="资料状态" value={subject.chunkCount ? "可出题" : "未就绪"} tone={subject.chunkCount ? "good" : "warn"} />
      </div>

      {error && (
        <div className="notice error">
          <AlertCircle size={17} />
          {error}
        </div>
      )}

      <LoadingButton className="primary-button full" loading={loading} loadingText="出题中，请您稍作等待" onClick={start}>
        开始练习
      </LoadingButton>
      <Link className="secondary-button full" to="/mistakes" onClick={() => track("subject_mistakes_clicked", { subjectId })}>
        <ListChecks size={18} />
        查看错题
        <ArrowRight size={18} />
      </Link>
    </div>
  );
}
