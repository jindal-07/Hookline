// Sign-in for servers protected with API_AUTH_TOKEN. Checks access once on load, and again whenever an
// API call is rejected (e.g. the token was rotated). Servers without a token pass straight through.
import { useCallback, useEffect, useState } from "react";
import { api, authToken, AUTH_REQUIRED_EVENT } from "../services/api.js";
import { Logo } from "./Logo.jsx";
import { Spinner } from "./ui.jsx";
import Icon from "./Icons.jsx";

export default function AuthGate({ children }) {
  const [state, setState] = useState("checking"); // checking | ok | login
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const probe = useCallback(async () => {
    try { await api.settings(); setState("ok"); return true; }
    catch (e) { setState(e.status === 401 ? "login" : "ok"); return e.status !== 401; } // other errors: let the pages show them
  }, []);

  useEffect(() => { probe(); }, [probe]);
  useEffect(() => {
    const onAuth = () => setState("login");
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuth);
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    authToken.set(value.trim());
    if (await probe()) { setValue(""); location.reload(); return; } // reconnect live updates with the token
    authToken.clear();
    setError("That access token isn't right.");
    setBusy(false);
  }

  if (state === "ok") return children;
  if (state === "checking") return <div className="grid min-h-dvh place-items-center text-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading…</span></div>;

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <form onSubmit={submit} className="surface-dialog anim-dialog-in w-full max-w-sm p-6 sm:p-8">
        <div className="scope-nav -mx-6 -mt-6 mb-6 flex justify-center rounded-t-[22px] px-6 py-5 sm:-mx-8 sm:-mt-8"><Logo /></div>
        <h1 className="text-xl">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Enter the access token for this Hookline server. It's the <code>API_AUTH_TOKEN</code> set where the app is hosted.</p>
        <label className="mt-5 block">
          <span className="label">Access token</span>
          <input type="password" autoComplete="current-password" required autoFocus className="input mt-1.5" value={value}
            onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "auth-error" : undefined} />
        </label>
        {error && <p id="auth-error" role="alert" className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-error"><Icon name="alert" className="size-3.5" />{error}</p>}
        <button className="btn-primary mt-5 w-full" disabled={busy || !value.trim()}>{busy ? <Spinner /> : <Icon name="checkCircle" />}Sign in</button>
        <p className="mt-4 text-center text-xs text-muted">The token is stored in this browser only.</p>
      </form>
    </main>
  );
}
