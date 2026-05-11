import { CirclePlus, Home, LibraryBig, Plus } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

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

export default function AppShell({ children }) {
  const location = useLocation();
  const isHome = location.pathname === "/";

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
        <NavLink to="/" className="brand" aria-label="回到首页">
          <span className="brand-mark">
            <BrandLogo />
          </span>
          <span>
            <strong>期末刷</strong>
            <small>AI 训练系统</small>
          </span>
        </NavLink>
        {!isHome && (
          <NavLink to="/upload" className="icon-button" aria-label="新建科目">
            <Plus size={20} />
          </NavLink>
        )}
      </header>
      <main className="page-wrap">{children}</main>
      {!isHome && (
        <nav className="bottom-nav" aria-label="主导航">
          <NavLink to="/" end>
            <Home size={19} />
            <span>首页</span>
          </NavLink>
          <NavLink to="/upload">
            <CirclePlus size={19} />
            <span>上传</span>
          </NavLink>
          <NavLink to="/mistakes">
            <LibraryBig size={19} />
            <span>错题</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
}
