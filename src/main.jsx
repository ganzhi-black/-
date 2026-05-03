import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import "./styles.css";

const root = document.getElementById("root");

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <HashRouter>
          <App />
        </HashRouter>
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (error) {
  root.innerHTML = `<div class="fatal-screen"><strong>页面启动失败</strong><p>${error?.message || "未知错误"}</p><button onclick="location.reload()">重新加载</button></div>`;
}
