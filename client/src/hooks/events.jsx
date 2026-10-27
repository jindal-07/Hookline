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
    // EventSource retries automatically but doesn't replay what was sent while it was down (server restart, sleep,
    // network blip), so after a reconnect every subscriber gets a "resync" event and refetches.
    let dropped = false;
    es.onopen = () => {
      setConnected(true);
      if (dropped) for (const fn of subs.current) fn({ type: "resync" });
      dropped = false;
    };
    es.onerror = () => { setConnected(false); dropped = true; };
    return () => es.close();
  }, []);
  const value = useRef({ subscribe: (fn) => { subs.current.add(fn); return () => subs.current.delete(fn); } }).current;
  return <Ctx.Provider value={{ ...value, connected }}>{children}</Ctx.Provider>;
}

/**
 * Subscribe to progress events; optional filter by batch. Returns connection state.
 * Handlers also receive { type: "resync" } after a reconnect (events may have been missed): refetch on it.
 */
export function useEvents(onEvent, { batchId } = {}) {
  const { subscribe, connected } = useContext(Ctx);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => subscribe((e) => {
    if (batchId && e.type !== "resync" && e.batch_id !== batchId) return;
    handler.current?.(e);
  }), [subscribe, batchId]);
  return connected;
}
