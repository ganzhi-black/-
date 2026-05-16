import { BarChart3, CirclePlus, Home, LibraryBig, LogOut, Plus } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { track } from "../services/api.js";

function BrandLogo() {
  return (
    <svg className="brand-logo-svg" viewBox="0 0 48 48" aria-hidden="true">
      <path className="logo-brush-outline" d="M10.5 9.5h27c1.7 0 3 1.3 3 3v14.7c0 5.4-3.1 8.3-9.2 9.8-2.3.6-2.8 1.5-2.5 3.7.4 3.9-1.8 6.2-4.8 6.2s-5.2-2.3-4.8-6.2c.3-2.2-.2-3.1-2.5-3.7-6.1-1.5-9.2-4.4-9.2-9.8V12.5c0-1.7 1.3-3 3-3Z" />
      <path className="logo-brush-line" d="M8.4 25.3h31.2" />
      <path className="logo-brush-tooth" d="M14.5 10v9.4" />
      <path className="logo-brush-tooth" d="M20.8 10v9.4" />
      <path className="logo-brush-tooth" d="M27.2 10v9.4" />
      <path className="logo-brush-tooth" d="M33.5 10v9.4" />
    </svg>
  );
}

export default function AppShell({ children, user, onLogout }) {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const isAuth = location.pathname === "/login" || location.pathname === "/register";

  return (
    <div className={`app-shell ${isHome ? "home-shell" : ""}`}>
      <svg className="pencil-filter-svg" aria-hidden="true" focusable="false">
        <defs>
          <filter id="pencil-roughen">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="12" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.45" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="期末刷首页">
          <span className="brand-mark">
            <BrandLogo />
          </span>
          <span>
            <strong>期末刷</strong>
            <small>AI 资料刷题助手</small>
          </span>
        </NavLink>
        <div className="topbar-actions">
          {user && <span className="user-chip">{user.nickname || user.email}</span>}
          {!isHome && !isAuth && user && (
            <NavLink to="/upload" className="icon-button" aria-label="上传资料">
              <Plus size={20} />
            </NavLink>
          )}
          {user?.isAdmin && (
            <NavLink to="/admin/metrics" className="icon-button" aria-label="数据看板">
              <BarChart3 size={19} />
            </NavLink>
          )}
          {user && (
            <button className="icon-button" type="button" onClick={onLogout} aria-label="退出登录">
              <LogOut size={19} />
            </button>
          )}
        </div>
      </header>
      <main className="page-wrap">{children}</main>
      {!isHome && !isAuth && user && (
        <nav className="bottom-nav" aria-label="底部导航">
          <NavLink to="/" end>
            <Home size={19} />
            <span>首页</span>
          </NavLink>
          <NavLink to="/upload">
            <CirclePlus size={19} />
            <span>上传</span>
          </NavLink>
          <NavLink to="/mistakes" onClick={() => track("bottom_nav_mistakes_clicked")}>
            <LibraryBig size={19} />
            <span>错题</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
}
