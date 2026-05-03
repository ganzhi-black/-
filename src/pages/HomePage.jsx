import { ArrowRight, FolderPlus, LibraryBig, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../services/mockApi.js";

export default function HomePage() {
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => {
    const load = () => api.getDashboard().then(setDashboard);
    load();
    window.addEventListener("qimoshua:state-change", load);
    return () => window.removeEventListener("qimoshua:state-change", load);
  }, []);

  const subjectCount = dashboard?.subjects?.length || 0;
  const mistakeCount = dashboard?.totalMistakes || 0;

  return (
    <div className="home-clean">
      <section className="home-hero-clean">
        <div className="home-hero-copy">
          <span className="home-kicker">
            <Sparkles size={16} />
            为中国大学生期末周而做
          </span>
          <h1>把你的复习资料，变成可训练的题库。</h1>
          <p>
            上传你的复习资料，生成选择题、简答题、论述题。主观题支持语音作答，AI批改，错题自动整理进入错题本。
          </p>
        </div>

        <div className="home-action-modules" aria-label="首页操作">
          <Link className="home-module" to="/upload">
            <span className="home-module-icon">
              <FolderPlus size={24} />
            </span>
            <span>
              <strong>新建科目</strong>
              <small>{subjectCount ? `${subjectCount} 个科目已创建` : "上传资料开始训练"}</small>
            </span>
            <ArrowRight size={20} />
          </Link>
          <Link className="home-module" to="/mistakes">
            <span className="home-module-icon">
              <LibraryBig size={24} />
            </span>
            <span>
              <strong>进入错题本</strong>
              <small>{mistakeCount ? `${mistakeCount} 道错题待重做` : "暂无错题，继续保持"}</small>
            </span>
            <ArrowRight size={20} />
          </Link>
        </div>
      </section>
    </div>
  );
}
