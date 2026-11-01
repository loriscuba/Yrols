import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/Overview";
import { BanksPage } from "./pages/Banks";
import { BillsPage } from "./pages/Bills";
import { DeadlinesPage } from "./pages/Deadlines";
import { RemindersPage } from "./pages/Reminders";
import { EmailPage } from "./pages/Email";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="banche" element={<BanksPage />} />
          <Route path="bollette" element={<BillsPage />} />
          <Route path="scadenze" element={<DeadlinesPage />} />
          <Route path="promemoria" element={<RemindersPage />} />
          <Route path="email" element={<EmailPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
