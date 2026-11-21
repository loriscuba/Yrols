import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Bell, CalendarClock, CheckCircle2, RefreshCw, Home, Landmark, LogOut, Mail, ReceiptText, ShoppingCart, Moon, Sun, Repeat, Building2, PiggyBank, MoreHorizontal, ShieldCheck, Umbrella, X } from "lucide-react";
import { supabase } from "../cloud";
import { signOut } from "../security";
import { useEffect, useState } from "react";
import { refreshAvailable, refreshBanks, useBankRefresh } from "../bankRefresh";

/** Aggiorna i movimenti a ogni apertura dell'app (e al ritorno in primo piano), al massimo ogni 30 minuti. */
function useRefreshOnOpen() {
  useEffect(() => {
    if (!refreshAvailable()) return;
    refreshBanks({ auto: true });
    const onVisible = () => { if (document.visibilityState === "visible") refreshBanks({ auto: true }); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}

/** Avviso discreto sull'aggiornamento in corso o appena finito. Quello automatico mostra solo novità ed errori. */
function RefreshToast() {
  const s = useBankRefresh();
  const [hidden, setHidden] = useState<number | null>(null);
  const at = "at" in s ? s.at : null;
  useEffect(() => {
    if (at === null) return;
    const t = setTimeout(() => setHidden(at), s.status === "error" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [at, s.status]);
  if (s.status === "idle" || (at !== null && hidden === at)) return null;
  if (s.status === "info" && s.auto) return null;
  if (s.status === "done" && s.auto && s.text.startsWith("Nessun")) return null;
  const running = s.status === "running";
  return (
    <div className={`refresh-toast ${s.status === "error" ? "critical" : ""}`} role="status" aria-live="polite">
      {running ? <RefreshCw size={14} className="spin" aria-hidden /> : s.status === "done" ? <CheckCircle2 size={14} aria-hidden /> : null}
      <span>{running ? "Aggiorno i movimenti…" : s.text}</span>
    </div>
  );
}

/** `main`: voci sempre visibili nella barra in basso sul cellulare; le altre stanno in "Altro". */
const NAV = [
  { to: "/", label: "Panoramica", short: "Home", icon: Home, end: true, main: true },
  { to: "/banche", label: "Banche", icon: Landmark, main: true },
  { to: "/spese-previste", label: "Spese previste", icon: Repeat },
  { to: "/bollette", label: "Bollette", icon: ReceiptText, main: true },
  { to: "/scontrini", label: "Scontrini", icon: ShoppingCart, main: true },
  { to: "/fornitori", label: "Fornitori", icon: Building2 },
  { to: "/risparmio", label: "Risparmio", icon: PiggyBank, main: true },
  ...(supabase ? [{ to: "/fondo-pensione", label: "Fondo pensione", icon: Umbrella }] : []),
  { to: "/scadenze", label: "Scadenze", icon: CalendarClock },
  { to: "/promemoria", label: "Promemoria", icon: Bell },
  { to: "/email", label: "Da email", icon: Mail },
  ...(supabase ? [{ to: "/sicurezza", label: "Sicurezza", icon: ShieldCheck }] : []),
];
const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

function useTheme() {
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem("yrols-theme"); } catch { return null; } });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { theme ? localStorage.setItem("yrols-theme", theme) : localStorage.removeItem("yrols-theme"); } catch { /* ignora */ }
  }, [theme]);
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  return { dark, toggle: () => setTheme(dark ? "light" : "dark") };
}

export function Layout() {
  const { dark, toggle } = useTheme();
  useRefreshOnOpen();
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => { setMore(false); }, [pathname]);
  useEffect(() => {
    if (!more) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [more]);
  const inMore = NAV.some((n) => !n.main && pathname.startsWith(n.to));
  const tools = (
    <>
      {supabase && (
        <button className="theme-btn" onClick={() => signOut()} aria-label="Esci">
          <LogOut size={16} /><span>Esci</span>
        </button>
      )}
      <button className="theme-btn" onClick={toggle} aria-label="Cambia tema">
        {dark ? <Sun size={16} /> : <Moon size={16} />}<span>{dark ? "Tema chiaro" : "Tema scuro"}</span>
      </button>
    </>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>Y</span>
          <span>Yrols</span>
        </div>
        <nav>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={linkClass}>
              <Icon size={18} aria-hidden /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        {tools}
      </aside>

      {/* Cellulare: barra in basso con le pagine principali e il pannello "Altro" per il resto. */}
      <nav className="tabbar" aria-label="Navigazione">
        {NAV.filter((n) => n.main).map(({ to, label, short, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={linkClass}>
            <Icon size={20} aria-hidden /><span>{short ?? label}</span>
          </NavLink>
        ))}
        <button className={`nav-more ${inMore || more ? "active" : ""}`} onClick={() => setMore(!more)} aria-expanded={more} aria-controls="altro">
          {more ? <X size={20} aria-hidden /> : <MoreHorizontal size={20} aria-hidden />}<span>Altro</span>
        </button>
      </nav>
      {more && (
        <div className="sheet-backdrop" onClick={() => setMore(false)}>
          <div className="sheet" id="altro" role="dialog" aria-label="Altre pagine" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grid">
              {NAV.filter((n) => !n.main).map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className={linkClass}>
                  <Icon size={22} aria-hidden /><span>{label}</span>
                </NavLink>
              ))}
            </div>
            <div className="sheet-tools">{tools}</div>
          </div>
        </div>
      )}
      <main className="content"><RefreshToast /><Outlet /></main>
    </div>
  );
}
