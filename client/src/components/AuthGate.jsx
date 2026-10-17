// Password wall. Asks the server whether a password is required (APP_PASSWORD) and whether this browser
// already has a session; shows the sign-in screen when needed — also if a later request comes back 401.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, AUTH_REQUIRED_EVENT } from "../services/api.js";
import { Logo } from "./Logo.jsx";
import { Spinner } from "./ui.jsx";
import Icon from "./Icons.jsx";

const AuthCtx = createContext({ required: false, signOut: () => {} });
export const useAuth = () => useContext(AuthCtx);

export default function AuthGate({ children }) {
  const [state, setState] = useState({ status: "checking", required: false }); // checking | ok | login
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      const s = await api.authSession();
      setState({ status: s.authenticated ? "ok" : "login", required: s.required });
    } catch {
      setState({ status: "ok", required: false }); // server unreachable: let the pages show the error
    }
  }, []);

  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    const onAuth = () => setState(s => ({ ...s, status: "login" }));
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuth);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    location.assign("/");
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login(password);
      location.reload(); // start fresh with the session cookie (reconnects live updates)
    } catch (err) {
      setError(err.status === 401 ? "That password isn't right." : err.message);
      setBusy(false);
    }
  }

  if (state.status === "ok") return <AuthCtx.Provider value={{ required: state.required, signOut }}>{children}</AuthCtx.Provider>;
  if (state.status === "checking") return <div className="grid min-h-dvh place-items-center text-muted" role="status"><Spinner className="size-6" /><span className="sr-only">Loading…</span></div>;

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <form onSubmit={submit} className="surface-dialog anim-dialog-in w-full max-w-sm overflow-hidden">
        <div className="scope-nav flex justify-center px-6 py-5"><Logo /></div>
        <div className="p-6 sm:p-8">
          <h1 className="text-xl">Sign in</h1>
          <p className="mt-1 text-sm text-muted">This Hookline workspace is password protected.</p>
          <label className="mt-5 block">
            <span className="label">Password</span>
            <input type="password" name="password" autoComplete="current-password" required autoFocus className="input mt-1.5" value={password}
              onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "auth-error" : undefined} />
          </label>
          {error && <p id="auth-error" role="alert" className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-error"><Icon name="alert" className="size-3.5 shrink-0" />{error}</p>}
          <button className="btn-primary mt-5 w-full" disabled={busy || !password}>{busy ? <Spinner /> : <Icon name="checkCircle" />}Sign in</button>
          <p className="mt-4 text-center text-xs text-muted">You stay signed in on this browser for 30 days.</p>
        </div>
      </form>
    </main>
  );
}
