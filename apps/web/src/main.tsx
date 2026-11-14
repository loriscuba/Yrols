import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Layout } from "./components/Layout";
import { AuthGate } from "./components/AuthGate";
import { OverviewPage } from "./pages/Overview";
import { ProjectionPage } from "./pages/Projection";
import { BanksPage } from "./pages/Banks";
import { BillsPage } from "./pages/Bills";
import { DeadlinesPage } from "./pages/Deadlines";
import { RemindersPage } from "./pages/Reminders";
import { EmailPage } from "./pages/Email";
import { SavingsPage } from "./pages/Savings";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="banche" element={<BanksPage />} />
          <Route path="spese-previste" element={<ProjectionPage />} />
          <Route path="bollette" element={<BillsPage />} />
          <Route path="risparmio" element={<SavingsPage />} />
          <Route path="scadenze" element={<DeadlinesPage />} />
          <Route path="promemoria" element={<RemindersPage />} />
          <Route path="email" element={<EmailPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </AuthGate>
  </React.StrictMode>,
);
