import { ArrowRight, Check, FileQuestion, ListChecks, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import Metric from "../components/Metric.jsx";
import { api } from "../services/mockApi.js";

const typeOptions = [
  { id: "single", label: "选择题", desc: "快速判断掌握度" },
  { id: "short", label: "简答题", desc: "适合考点背诵" },
  { id: "essay", label: "论述题", desc: "训练大题表达" },
];

export default function SettingsPage() {
  const { subjectId } = useParams();
  const navigate = useNavigate();
  const [subject, setSubject] = useState(null);
  const [types, setTypes] = useState(["single", "short", "essay"]);
  const [amount, setAmount] = useState(6);
  const [mode, setMode] = useState("relaxed");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getSubject(subjectId).then(setSubject);
  }, [subjectId]);

  function toggleType(type) {
    setTypes((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]));
  }

  async function start() {
    setLoading(true);
    const session = await api.createSession({
      subjectId,
      types: types.length ? types : ["single"],
      amount: Math.min(30, Math.max(1, Number(amount) || 1)),
      mode,
    });
    navigate(`/quiz/${session.id}`);
  }

  if (!subject) return <div className="skeleton-page" />;

  return (
    <div className="stack">
      <section className="page-title">
        <p className="eyebrow muted">练习设置</p>
        <h1>{subject.name}</h1>
        <p>{subject.sourceFileName}</p>
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
          <h2>题量与模式</h2>
        </div>
        <label className="field compact-field">
          <span>题量</span>
          <input type="number" min="1" max="30" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <div className="segmented">
          <button type="button" className={mode === "strict" ? "active" : ""} onClick={() => setMode("strict")}>
            默写严格
          </button>
          <button type="button" className={mode === "relaxed" ? "active" : ""} onClick={() => setMode("relaxed")}>
            复习宽松
          </button>
        </div>
      </section>

      <div className="summary-strip">
        <Metric label="资料切片" value={subject.chunkCount} />
        <Metric label="状态" value="可练习" tone="good" />
      </div>

      <LoadingButton className="primary-button full" loading={loading} onClick={start}>
        开始练习
      </LoadingButton>
      <Link className="secondary-button full" to="/mistakes">
        <ListChecks size={18} />
        查看错题本
        <ArrowRight size={18} />
      </Link>
    </div>
  );
}
