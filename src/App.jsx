import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import AppShell from "./components/AppShell.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import AdminMetricsPage from "./pages/AdminMetricsPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import QuizPage from "./pages/QuizPage.jsx";
import ResultPage from "./pages/ResultPage.jsx";
import SummaryPage from "./pages/SummaryPage.jsx";
import MistakesPage from "./pages/MistakesPage.jsx";
import HistorySubjectsPage from "./pages/HistorySubjectsPage.jsx";
import { api } from "./services/api.js";

function RequireAuth({ user, children }) {
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

export default function App() {
  const dashboardPreview = import.meta.env.VITE_DASHBOARD_PREVIEW === "1";
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    if (dashboardPreview) {
      setUser(null);
      setAuthLoading(false);
      return;
    }

    api
      .getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, [dashboardPreview]);

  async function logout() {
    await api.logout();
    setUser(null);
  }

  if (authLoading) {
    return (
      <AppShell user={user} onLogout={logout}>
        <div className="skeleton-page" />
      </AppShell>
    );
  }

  return (
    <AppShell user={user} onLogout={logout}>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" user={user} onAuthenticated={setUser} />} />
        <Route path="/register" element={<AuthPage mode="register" user={user} onAuthenticated={setUser} />} />
        <Route path="/admin/metrics" element={dashboardPreview ? <AdminMetricsPage /> : <RequireAuth user={user}><AdminMetricsPage /></RequireAuth>} />
        <Route path="/" element={<RequireAuth user={user}><HomePage /></RequireAuth>} />
        <Route path="/upload" element={<RequireAuth user={user}><UploadPage /></RequireAuth>} />
        <Route path="/subjects/history" element={<RequireAuth user={user}><HistorySubjectsPage /></RequireAuth>} />
        <Route path="/subjects/:subjectId/settings" element={<RequireAuth user={user}><SettingsPage /></RequireAuth>} />
        <Route path="/quiz/:sessionId" element={<RequireAuth user={user}><QuizPage /></RequireAuth>} />
        <Route path="/result/:sessionId/:questionIndex" element={<RequireAuth user={user}><ResultPage /></RequireAuth>} />
        <Route path="/summary/:sessionId" element={<RequireAuth user={user}><SummaryPage /></RequireAuth>} />
        <Route path="/mistakes" element={<RequireAuth user={user}><MistakesPage /></RequireAuth>} />
        <Route path="/mistakes/:subjectId" element={<RequireAuth user={user}><MistakesPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
