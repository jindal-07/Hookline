import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { ConfirmProvider, ToastProvider } from "./components/controls.jsx";
import { EventsProvider } from "./hooks/events.jsx";
import AuthGate from "./components/AuthGate.jsx";
import Overview from "./pages/Overview.jsx";
import Upload from "./pages/Upload.jsx";
import Batches from "./pages/Batches.jsx";
import BatchDetail from "./pages/BatchDetail.jsx";
import Videos from "./pages/Videos.jsx";
import VideoDetail from "./pages/VideoDetail.jsx";
import Settings from "./pages/Settings.jsx";
import Dataset from "./pages/Dataset.jsx";
import Scripts from "./pages/Scripts.jsx";
import ScriptDetail from "./pages/ScriptDetail.jsx";
import NotFound from "./pages/NotFound.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthGate>
          <EventsProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Overview />} />
                <Route path="upload" element={<Upload />} />
                <Route path="batches" element={<Batches />} />
                <Route path="batches/:id" element={<BatchDetail />} />
                <Route path="videos" element={<Videos />} />
                <Route path="videos/:id" element={<VideoDetail />} />
                <Route path="dataset" element={<Dataset />} />
                <Route path="scripts" element={<Scripts />} />
                <Route path="scripts/:id" element={<ScriptDetail />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </EventsProvider>
          </AuthGate>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
);
