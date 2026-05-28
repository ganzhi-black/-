import { AlertCircle, ArrowRight, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import LoadingButton from "../components/LoadingButton.jsx";
import { api } from "../services/api.js";

export default function AuthPage({ mode = "login", user, onAuthenticated }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isRegister = mode === "register";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const targetPath = useMemo(() => location.state?.from?.pathname || "/", [location.state]);

  if (user) return <Navigate to={targetPath} replace />;

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (isRegister && password !== confirmPassword) {
      setError("两次输入的密码不一致，请重新输入。");
      setPassword("");
      setConfirmPassword("");
      return;
    }
    setLoading(true);
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const nextUser = isRegister
        ? await api.register({ email: normalizedEmail, password, nickname: nickname.trim() })
        : await api.login({ email: normalizedEmail, password });
      onAuthenticated(nextUser);
      navigate(targetPath, { replace: true });
    } catch (nextError) {
      setError(nextError.message);
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-panel">
        <div className="auth-copy">
          <h1>{isRegister ? "创建账号后开始学习" : "登录后继续学习"}</h1>
          <p>上传资料、AI 出题、答题记录和错题本都会绑定到你的账号，换设备也不会丢。</p>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {isRegister && (
            <label className="field">
              <span>昵称</span>
              <div className="auth-input">
                <UserRound size={18} />
                <input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="例如：期末冲刺选手" maxLength={30} />
              </div>
            </label>
          )}

          <label className="field">
            <span>邮箱</span>
            <div className="auth-input">
              <Mail size={18} />
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
            </div>
          </label>

          <label className="field">
            <span>密码</span>
            <div className="auth-input">
              <LockKeyhole size={18} />
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" minLength={8} required />
            </div>
          </label>

          {isRegister && (
            <label className="field">
              <span>确认密码</span>
              <div className="auth-input">
                <LockKeyhole size={18} />
                <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="请再次输入密码" minLength={8} required />
              </div>
            </label>
          )}

          {error && (
            <div className="notice error">
              <AlertCircle size={17} />
              {error}
            </div>
          )}

          <LoadingButton className="primary-button full" loading={loading} type="submit">
            {isRegister ? "注册并进入" : "登录"}
            <ArrowRight size={18} />
          </LoadingButton>

          <button
            className="ghost-button full"
            type="button"
            onClick={() => navigate(isRegister ? "/login" : "/register", { replace: true, state: location.state })}
          >
            {isRegister ? "已有账号，去登录" : "还没有账号，去注册"}
          </button>
        </form>
      </section>
    </div>
  );
}
