import { AlertCircle, CheckCircle2, FileText, UploadCloud } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import { api } from "../services/mockApi.js";

const stages = ["文本提取中", "智能切片中", "向量化入库中"];
const acceptedTypes = [".pdf", ".doc", ".docx"];

export default function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [stage, setStage] = useState(-1);
  const [loading, setLoading] = useState(false);

  const derivedName = useMemo(() => file?.name?.replace(/\.(pdf|doc|docx)$/i, "") || "", [file]);

  function pickFile(nextFile) {
    setError("");
    if (!nextFile) return;
    const lower = nextFile.name.toLowerCase();
    if (!acceptedTypes.some((type) => lower.endsWith(type))) {
      setError("格式暂不支持，请上传 PDF、Word 文档。");
      return;
    }
    if (nextFile.size > 10 * 1024 * 1024) {
      setError("文件超过 10 MB，建议拆分后再上传。");
      return;
    }
    if (lower.endsWith(".pdf") && nextFile.size < 8 * 1024) {
      setError("疑似扫描版 PDF，mock 阶段暂不支持无文本层资料。");
      return;
    }
    setFile(nextFile);
    setName((current) => current || derivedName || nextFile.name.replace(/\.(pdf|doc|docx)$/i, ""));
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
    for (let i = 0; i < stages.length; i += 1) {
      setStage(i);
      await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 500));
    }
    const subject = await api.createSubject({ name: name.trim().slice(0, 20), file });
    navigate(`/subjects/${subject.id}/settings`);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <section className="page-title">
        <p className="eyebrow muted">新建科目</p>
        <h1>上传复习资料</h1>
        <p>支持 PDF、Word，上限 10 MB。当前为 mock 阶段，文件不会上传到真实服务器。</p>
      </section>

      <label
        className={`upload-zone ${file ? "has-file" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          pickFile(event.dataTransfer.files?.[0]);
        }}
      >
        <input type="file" accept=".pdf,.doc,.docx" onChange={(event) => pickFile(event.target.files?.[0])} disabled={loading} />
        <UploadCloud size={34} />
        <strong>{file ? file.name : "拖拽文件到这里，或点击选择"}</strong>
        <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF / DOC / DOCX"}</span>
      </label>

      <label className="field">
        <span>科目名称</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：马克思主义基本原理" maxLength={20} disabled={loading} />
      </label>

      {error && (
        <div className="notice error">
          <AlertCircle size={17} />
          {error}
        </div>
      )}

      {stage >= 0 && (
        <div className="stage-list">
          {stages.map((item, index) => (
            <div className={`stage-item ${index <= stage ? "active" : ""}`} key={item}>
              {index < stage ? <CheckCircle2 size={18} /> : <FileText size={18} />}
              <span>{item}</span>
            </div>
          ))}
        </div>
      )}

      <LoadingButton className="primary-button full" loading={loading} type="submit">
        开始解析入库
      </LoadingButton>
    </form>
  );
}
