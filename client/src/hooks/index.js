import { useCallback, useEffect, useRef, useState } from "react";

/** Fetch data with loading/error state; `reload` re-runs it. */
export function useApi(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(async ({ silent } = {}) => {
    const n = ++seq.current;
    if (!silent) setState(s => ({ ...s, loading: true }));
    try {
      const data = await fn();
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState(s => ({ ...s, error, loading: false }));
    }
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export { useEvents, EventsProvider } from "./events.jsx";

/** Debounced callback — used to coalesce bursts of progress events into one refetch. */
export function useDebounced(fn, ms = 400) {
  const t = useRef();
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => clearTimeout(t.current), []);
  return useCallback((...a) => { clearTimeout(t.current); t.current = setTimeout(() => f.current(...a), ms); }, [ms]);
}

/** Calls fn every `ms` while `active` (a fallback for live events) and while the tab is visible. */
export function usePolling(fn, ms, active) {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") f.current(); }, ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

/** Current time, re-rendering every `ms` while `active` — for live elapsed timers. */
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return now;
}

export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");
  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { /* private mode */ }
    setTheme(next);
  }, [theme]);
  return [theme, toggle];
}
