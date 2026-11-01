import { NavLink, Outlet } from "react-router-dom";
import { Bell, CalendarClock, Home, Landmark, Mail, ReceiptText, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const NAV = [
  { to: "/", label: "Panoramica", icon: Home, end: true },
  { to: "/banche", label: "Banche", icon: Landmark },
  { to: "/bollette", label: "Bollette", icon: ReceiptText },
  { to: "/scadenze", label: "Scadenze", icon: CalendarClock },
  { to: "/promemoria", label: "Promemoria", icon: Bell },
  { to: "/email", label: "Da email", icon: Mail },
];

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
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>Y</span>
          <span>Yrols</span>
        </div>
        <nav>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon size={18} aria-hidden /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <button className="theme-btn" onClick={toggle} aria-label="Cambia tema">
          {dark ? <Sun size={16} /> : <Moon size={16} />}<span>{dark ? "Tema chiaro" : "Tema scuro"}</span>
        </button>
      </aside>
      <main className="content"><Outlet /></main>
    </div>
  );
}
