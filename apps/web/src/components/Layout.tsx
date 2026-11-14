import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Bell, CalendarClock, Home, Landmark, LogOut, Mail, ReceiptText, Moon, Sun, Repeat, Building2, PiggyBank, MoreHorizontal, X } from "lucide-react";
import { supabase } from "../cloud";
import { useEffect, useState } from "react";

/** `main`: voci sempre visibili nella barra in basso sul cellulare; le altre stanno in "Altro". */
const NAV = [
  { to: "/", label: "Panoramica", short: "Home", icon: Home, end: true, main: true },
  { to: "/banche", label: "Banche", icon: Landmark, main: true },
  { to: "/spese-previste", label: "Spese previste", icon: Repeat },
  { to: "/bollette", label: "Bollette", icon: ReceiptText, main: true },
  { to: "/fornitori", label: "Fornitori", icon: Building2 },
  { to: "/risparmio", label: "Risparmio", icon: PiggyBank, main: true },
  { to: "/scadenze", label: "Scadenze", icon: CalendarClock },
  { to: "/promemoria", label: "Promemoria", icon: Bell },
  { to: "/email", label: "Da email", icon: Mail },
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
        <button className="theme-btn" onClick={() => supabase!.auth.signOut()} aria-label="Esci">
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
      <main className="content"><Outlet /></main>
    </div>
  );
}
