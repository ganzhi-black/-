import { AlertCircle, Check, FileQuestion, SlidersHorizontal, UploadCloud } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import { api, track } from "../services/api.js";

const acceptedTypes = [".pdf", ".doc", ".docx", ".txt", ".md"];
const typeOptions = [
  { id: "single", label: "单选题", desc: "适合快速检查概念、定义和关键事实。" },
  { id: "term", label: "名词解释", desc: "适合背诵核心概念和关键词。" },
  { id: "short", label: "简答题", desc: "适合训练 200-400 字的要点作答。" },
  { id: "essay", label: "论述题", desc: "适合训练更完整的分析和展开。" },
];

export default function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [types, setTypes] = useState(["single", "short", "essay"]);
  const [amount, setAmount] = useState(6);

  function pickFile(nextFile) {
    setError("");
    if (!nextFile) return;
    const lower = nextFile.name.toLowerCase();
    if (!acceptedTypes.some((type) => lower.endsWith(type))) {
      setError("格式暂不支持，请上传 PDF 或 Word 文档。");
      return;
    }
    if (nextFile.size > 80 * 1024 * 1024) {
      setError("文件超过 10 MB，建议拆分后再上传。");
      return;
    }
    if (lower.endsWith(".pdf") && nextFile.size < 8 * 1024) {
      setError("疑似扫描版 PDF，暂不支持无文本层资料。");
      return;
    }
    setFile(nextFile);
    setName((current) => current || nextFile.name.replace(/\.(pdf|doc|docx|txt|md)$/i, ""));
  }

  function toggleType(type) {
    setTypes((current) => (current.includes(type) ? current.filter((item) => item !== type) : [...current, type]));
  }

  async function submit(event) {
    event.preventDefault();
    if (!file) {
      setError("请先选择一份复习资料。");
      return;
    }
    if (!name.trim()) {
      setError("请给这个科目起一个名字。");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const subject = await api.createSubject({ name: name.trim().slice(0, 20), file });
      const session = await api.createSession({
        subjectId: subject.id,
        types: types.length ? types : ["single"],
        amount: Math.min(50, Math.max(1, Number(amount) || 1)),
        mode: "relaxed",
      });
      navigate(`/quiz/${session.id}`);
    } catch (nextError) {
      await track("upload_failed", {
        fileType: file?.name?.split(".").pop()?.toLowerCase() || "",
        fileSize: file?.size || 0,
        reason: nextError.message,
      });
      setError(nextError.message);
      setLoading(false);
    }
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={submit}>
        <section className="page-title">
          <p className="eyebrow muted">新建科目</p>
          <h1>上传复习资料</h1>
          <p>支持 PDF、Word，上限 10 MB。</p>
        </section>

        <label
          className={`upload-zone ${file ? "has-file" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            pickFile(event.dataTransfer.files?.[0]);
          }}
        >
          <input type="file" accept=".pdf,.doc,.docx,.txt,.md" onChange={(event) => pickFile(event.target.files?.[0])} disabled={loading} />
          <UploadCloud size={34} />
          <strong>{file ? file.name : "拖拽文件到这里，或点击选择"}</strong>
          <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF / DOC / DOCX"}</span>
        </label>

        <label className="field">
          <span>科目名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：马克思主义基本原理" maxLength={20} disabled={loading} />
        </label>

        <section className="setting-card">
          <div className="setting-title">
            <FileQuestion size={20} />
            <h2>选择题型</h2>
          </div>
          <div className="option-grid">
            {typeOptions.map((item) => (
              <button key={item.id} type="button" className={`choice-card ${types.includes(item.id) ? "selected" : ""}`} onClick={() => toggleType(item.id)} disabled={loading}>
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
            <h2>题目数量</h2>
          </div>
          <label className="field compact-field">
            <span>本次生成题数</span>
            <input type="number" min="1" max="50" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={loading} />
          </label>
        </section>

        {error && (
          <div className="notice error">
            <AlertCircle size={17} />
            {error}
          </div>
        )}

        <LoadingButton className="primary-button full" loading={loading} loadingText="出题中，请您稍作等待" type="submit">
          {loading ? "出题中，请您稍作等待" : "开始出题"}
        </LoadingButton>
      </form>
    </div>
  );
}
