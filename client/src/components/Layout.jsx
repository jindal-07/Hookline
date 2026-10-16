// App shell: machined dark sidebar on desktop (≥1024px); top bar + slide-in drawer below that.
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import Icon from "./Icons.jsx";
import { Logo, LogoMark } from "./Logo.jsx";
import { useTheme, useEvents } from "../hooks/index.js";
import { Drawer, IconButton, Tooltip } from "./controls.jsx";
import { Toggle } from "./forms.jsx";

const NAV = [
  { to: "/", label: "Overview", icon: "dashboard", end: true },
  { to: "/upload", label: "Upload", icon: "upload" },
  { to: "/batches", label: "Batches", icon: "layers" },
  { to: "/videos", label: "Videos", icon: "film" },
  { to: "/dataset", label: "Dataset", icon: "dna" },
  { to: "/scripts", label: "Scripts", icon: "sparkles" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

function NavigationItem({ item }) {
  return (
    <NavLink to={item.to} end={item.end} className="nav-item">
      <Icon name={item.icon} className="size-[18px] shrink-0" />
      <span className="truncate">{item.label}</span>
      <span className="led" aria-hidden="true" />
    </NavLink>
  );
}

function LiveIndicator({ live, compact }) {
  return (
    <Tooltip label={live ? "Live updates connected" : "Live updates disconnected — retrying"}>
      <span className="inline-flex min-h-10 items-center gap-2 rounded-xl px-2 text-xs font-bold text-nav-fg" tabIndex={0} aria-label={live ? "Live updates connected" : "Live updates reconnecting"}>
        <span className={`status-led ${live ? "on" : "off"}`} aria-hidden="true" />
        {!compact && <span>{live ? "Live" : "Reconnecting"}</span>}
      </span>
    </Tooltip>
  );
}

/** Sidebar contents — shared by the desktop rail and the mobile drawer. */
function Sidebar({ theme, toggleTheme, live, onClose }) {
  return (
    <div className="scope-nav pt-safe flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-4 pt-5">
        <Link to="/" className="rounded-xl" aria-label="Hookline home"><Logo /></Link>
        {onClose && <IconButton icon="x" label="Close menu" onClick={onClose} tooltip={false} />}
      </div>
      <div className="mx-4 mb-3 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3">
        <p className="label px-3 pb-2 pt-1 !text-[10px] !text-white/40">Workspace</p>
        <ul className="grid gap-1">{NAV.map(n => <li key={n.to}><NavigationItem item={n} /></li>)}</ul>
      </nav>
      <div className="pb-safe m-3 rounded-2xl border border-white/5 bg-[image:var(--mat-well)] p-2 shadow-[var(--well)]">
        <div className="flex items-center justify-between gap-2 pl-1">
          <LiveIndicator live={live} />
          <Toggle checked={theme === "dark"} onChange={toggleTheme} label="Dark mode" className="pr-1 text-xs text-nav-fg" />
        </div>
      </div>
    </div>
  );
}

function TopNavigation({ onMenu, live, theme, toggleTheme }) {
  return (
    <header className="scope-nav pt-safe sticky top-0 z-30 border-b border-black/40 shadow-[0_6px_16px_-8px_rgba(0,0,0,0.6)] lg:hidden">
      <div className="flex h-14 items-center gap-2 px-2 sm:px-4">
        <IconButton icon="menu" label="Open menu" onClick={onMenu} tooltip={false} aria-haspopup="dialog" />
        <Link to="/" className="mr-auto rounded-xl" aria-label="Hookline home">
          <span className="min-[360px]:hidden"><LogoMark className="size-8" /></span>
          <span className="hidden min-[360px]:inline-flex"><Logo markClass="size-8" wordClass="text-base" /></span>
        </Link>
        <LiveIndicator live={live} compact />
        <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleTheme} />
      </div>
    </header>
  );
}

export default function Layout() {
  const [theme, toggleTheme] = useTheme();
  const live = useEvents(null);
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); }, [pathname]);
  // Close the drawer if the viewport grows into the desktop layout.
  useEffect(() => {
    const mq = matchMedia("(min-width: 1024px)");
    const onChange = () => mq.matches && setMenu(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_minmax(0,1fr)]">
      <a href="#main" className="btn-primary fixed left-3 top-3 z-[80] -translate-y-20 focus:translate-y-0">Skip to content</a>
      <aside className="sticky top-0 hidden h-dvh border-r border-black/60 shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)] lg:block">
        <Sidebar theme={theme} toggleTheme={toggleTheme} live={live} />
      </aside>
      <TopNavigation onMenu={() => setMenu(true)} live={live} theme={theme} toggleTheme={toggleTheme} />
      <Drawer open={menu} onClose={() => setMenu(false)} label="Main menu">
        <Sidebar theme={theme} toggleTheme={toggleTheme} live={live} onClose={() => setMenu(false)} />
      </Drawer>
      <main id="main" tabIndex={-1} className="pb-safe mx-auto w-full min-w-0 max-w-[1400px] px-4 py-5 outline-none sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        <div key={pathname} className="anim-page">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** crumbs: [{ to, label }] — the last crumb is the parent of the current page. */
export function Breadcrumbs({ crumbs }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm font-bold text-muted">
        {crumbs.map((c, i) => (
          <li key={c.to + i} className="flex min-w-0 items-center gap-1">
            {i === 0 && <Icon name="arrowLeft" className="size-3.5 shrink-0" />}
            {i > 0 && <Icon name="chevronRight" className="size-3.5 shrink-0 opacity-60" />}
            <Link to={c.to} className="truncate rounded-md hover:text-fg">{c.label}</Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({ title, subtitle, actions, crumbs }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 sm:mb-6">
      <div className="min-w-0 flex-1 basis-72">
        {crumbs && <Breadcrumbs crumbs={crumbs} />}
        <h1 className="text-2xl sm:text-3xl">{title}</h1>
        {subtitle && <div className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
