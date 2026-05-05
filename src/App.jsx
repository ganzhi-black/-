import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "./components/AppShell.jsx";
import HomePage from "./pages/HomePage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import QuizPage from "./pages/QuizPage.jsx";
import ResultPage from "./pages/ResultPage.jsx";
import SummaryPage from "./pages/SummaryPage.jsx";
import MistakesPage from "./pages/MistakesPage.jsx";
import HistorySubjectsPage from "./pages/HistorySubjectsPage.jsx";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/subjects/history" element={<HistorySubjectsPage />} />
        <Route path="/subjects/:subjectId/settings" element={<SettingsPage />} />
        <Route path="/quiz/:sessionId" element={<QuizPage />} />
        <Route path="/result/:sessionId/:questionIndex" element={<ResultPage />} />
        <Route path="/summary/:sessionId" element={<SummaryPage />} />
        <Route path="/mistakes" element={<MistakesPage />} />
        <Route path="/mistakes/:subjectId" element={<MistakesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
