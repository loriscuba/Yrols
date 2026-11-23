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
import { SuppliersPage } from "./pages/Suppliers";
import { SavingsPage } from "./pages/Savings";
import { ReceiptsPage } from "./pages/Receipts";
import { StatsPage } from "./pages/Stats";
import { PensionPage } from "./pages/Pension";
import { SecurityPage } from "./pages/Security";
import { supabase } from "./cloud";

// Anti-clickjacking: GitHub Pages non permette l'intestazione frame-ancestors, quindi niente cruscotto dentro un iframe.
if (window.top !== window.self) {
  document.body.textContent = "Yrols non può essere aperto dentro un'altra pagina.";
  throw new Error("Caricamento in un iframe bloccato");
}

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
          <Route path="fornitori" element={<SuppliersPage />} />
          <Route path="risparmio" element={<SavingsPage />} />
          <Route path="scontrini" element={<ReceiptsPage />} />
          <Route path="statistiche" element={<StatsPage />} />
          <Route path="scadenze" element={<DeadlinesPage />} />
          <Route path="promemoria" element={<RemindersPage />} />
          <Route path="email" element={<EmailPage />} />
          {supabase && <Route path="fondo-pensione" element={<PensionPage />} />}
          {supabase && <Route path="sicurezza" element={<SecurityPage />} />}
        </Route>
      </Routes>
    </BrowserRouter>
    </AuthGate>
  </React.StrictMode>,
);
