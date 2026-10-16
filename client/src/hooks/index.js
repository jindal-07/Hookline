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
