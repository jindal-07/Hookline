// One shared Server-Sent Events connection for the whole app; components subscribe to it.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { eventsUrl } from "../services/api.js";

const Ctx = createContext({ connected: false, subscribe: () => () => {} });

export function EventsProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const subs = useRef(new Set());
  useEffect(() => {
    const es = new EventSource(eventsUrl());
    const on = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      for (const fn of subs.current) fn(data);
    };
    es.addEventListener("video", on);
    es.addEventListener("batch", on);
    es.addEventListener("script", on);
    es.addEventListener("dataset", on);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource retries automatically
    return () => es.close();
  }, []);
  const value = useRef({ subscribe: (fn) => { subs.current.add(fn); return () => subs.current.delete(fn); } }).current;
  return <Ctx.Provider value={{ ...value, connected }}>{children}</Ctx.Provider>;
}

/** Subscribe to progress events; optional filter by batch. Returns connection state. */
export function useEvents(onEvent, { batchId } = {}) {
  const { subscribe, connected } = useContext(Ctx);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => subscribe((e) => {
    if (batchId && e.batch_id !== batchId) return;
    handler.current?.(e);
  }), [subscribe, batchId]);
  return connected;
}
