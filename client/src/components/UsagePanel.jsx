// Settings → API usage & credits: exact usage per provider from the server's usage ledger, the credits you
// added, what's left, a per-operation breakdown, daily spend, and the editable price table.
import { useState } from "react";
import { api } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { Card, Badge, Loading, ErrorState, Tabs, ChartContainer, LegendItem, TableScroll, InsetPanel, Spinner } from "./ui.jsx";
import { Modal, useToast } from "./controls.jsx";
import { FormField, SuffixInput } from "./forms.jsx";
import Icon from "./Icons.jsx";

const META = {
  gemini: { name: "Gemini", what: "Video & screenplay analysis, embeddings", color: "bg-info-solid", icon: "film" },
  assemblyai: { name: "AssemblyAI", what: "Speech transcription", color: "bg-success-solid", icon: "file" },
  anthropic: { name: "Anthropic", what: "Script writing (Claude Agent SDK)", color: "bg-ai-solid", icon: "sparkles" },
};
const OPERATION = { video_analysis: "Video analysis", text_analysis: "Screenplay text analysis", embeddings: "Embeddings (matching)", transcription: "Transcription", script: "Script writing" };
const PERIODS = [{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "all", label: "All time" }];

const usd = (n) => (n == null ? "—" : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const int = (n) => (n == null ? "—" : Math.round(n).toLocaleString());
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : int(n));
const hours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(2)} h` : `${(s / 60).toFixed(1)} min`);

export default function UsagePanel() {
  const [period, setPeriod] = useState("30d");
  const [editing, setEditing] = useState(null);
  const { data, error, reload } = useApi(() => api.usage(period), [period]);
  const refresh = useDebounced(() => reload({ silent: true }), 1500);
  useEvents(refresh); // pipeline activity → refresh the numbers

  return (
    <Card
      title="API usage & credits"
      subtitle="Every billable call to Gemini, AssemblyAI and Anthropic, as recorded by this server."
      action={<Tabs tabs={PERIODS} value={period} onChange={setPeriod} label="Period" role="radiogroup" />}
      bodyClass="p-4 sm:p-5"
    >
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : (
        <div className="grid grid-cols-1 gap-5">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {Object.keys(META).map(p => <ProviderCard key={p} id={p} u={data.providers[p]} onEditCredits={() => setEditing(p)} />)}
          </div>
          <DailyChart daily={data.daily} />
          <Breakdown operations={data.operations} />
          <PriceEditor prices={data.prices} onSaved={() => reload({ silent: true })} />
          <p className="text-xs text-muted">
            Tokens and audio time are the figures each provider reports for every call, including failed or retried attempts (they are billed too).
            Anthropic reports its own cost. Gemini and AssemblyAI costs are calculated from the price table at the time of each call; Gemini embeddings return no token count, so they are estimated (≈ 4 characters per token).
            Providers don't offer an API for your remaining balance, so "credits left" is the amount you entered minus usage since that date — compare it with each provider's billing page now and then.
          </p>
        </div>
      )}
      <CreditModal provider={editing} current={editing ? data?.providers[editing]?.credit : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload({ silent: true }); }} />
    </Card>
  );
}

function ProviderCard({ id, u, onEditCredits }) {
  const m = META[id];
  const c = u.credit;
  const pct = c ? Math.min(100, (c.used_usd / Math.max(c.amount_usd, 0.0001)) * 100) : 0;
  const stats = id === "assemblyai"
    ? [["Transcriptions", int(u.requests)], ["Audio processed", hours(u.audio_seconds)]]
    : id === "anthropic"
      ? [["Agent turns", int(u.requests)], ["Input tokens", tokens(u.input_tokens)], ["Output tokens", tokens(u.output_tokens)], ["Cache reads", tokens(u.cached_tokens)]]
      : [["Requests", int(u.requests)], ["Input tokens", tokens(u.input_tokens)], ["Output tokens", tokens(u.output_tokens)], ["Retried attempts", int(u.failed_requests)]];
  return (
    <InsetPanel className="grid content-start gap-3">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-[image:var(--mat-key)] text-muted shadow-[var(--key)]"><Icon name={m.icon} className="size-4.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-black">{m.name}</p>
          <p className="truncate text-xs text-muted">{m.what}</p>
        </div>
        {u.estimated && <Badge kind="neutral" className="shrink-0">part estimated</Badge>}
      </div>
      <div>
        <p className="label">Cost in period</p>
        <p className="text-3xl font-black tabular">{usd(u.cost_usd)}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        {stats.map(([k, v]) => <div key={k} className="min-w-0"><dt className="truncate text-xs text-muted">{k}</dt><dd className="font-bold tabular">{v}</dd></div>)}
      </dl>
      <div className="border-t border-border pt-3">
        {c ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-bold tabular">{usd(c.remaining_usd)} left</span>
              <span className="text-xs tabular text-muted">{usd(c.used_usd)} of {usd(c.amount_usd)} used</span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-full border border-border bg-[image:var(--mat-well)] p-px shadow-[var(--well)]" role="meter" aria-label={`${m.name} credits used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className={`h-full rounded-full ${pct > 85 ? "bg-error-solid" : pct > 60 ? "bg-warning-solid" : m.color}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-xs text-muted">since {c.since}</span>
              <button type="button" className="btn-ghost btn-sm" onClick={onEditCredits}>Edit credits</button>
            </div>
          </>
        ) : (
          <button type="button" className="btn-secondary btn-sm w-full" onClick={onEditCredits}><Icon name="plus" className="size-3.5" />Add credits to track balance</button>
        )}
      </div>
    </InsetPanel>
  );
}

function DailyChart({ daily }) {
  if (!daily.length) return null;
  const days = [...new Set(daily.map(d => d.day))].slice(-31);
  const per = Object.fromEntries(days.map(d => [d, Object.fromEntries(Object.keys(META).map(p => [p, 0]))]));
  for (const d of daily) if (per[d.day]) per[d.day][d.provider] = d.cost_usd;
  const max = Math.max(0.0001, ...days.map(d => Object.values(per[d]).reduce((a, b) => a + b, 0)));
  return (
    <div className="min-w-0">
      <p className="label mb-2">Daily cost</p>
      <ChartContainer height="h-32"
        label={days.map(d => `${d}: ${usd(Object.values(per[d]).reduce((a, b) => a + b, 0))}`).join("; ")}
        axis={days.length <= 14 ? days.map(d => <span key={d} className="min-w-0 flex-1 truncate text-center">{d.slice(5)}</span>) : <><span className="flex-1">{days[0].slice(5)}</span><span className="flex-1 text-right">{days.at(-1).slice(5)}</span></>}
        legend={Object.entries(META).map(([p, m]) => <LegendItem key={p} className={m.color}>{m.name}</LegendItem>)}>
        {days.map(d => (
          <div key={d} className="mx-auto flex h-full min-w-0 max-w-12 flex-1 flex-col justify-end" title={`${d}: ${Object.entries(per[d]).map(([p, v]) => `${META[p].name} ${usd(v)}`).join(", ")}`}>
            {Object.keys(META).map(p => per[d][p] > 0 && <div key={p} className={`${META[p].color} first:rounded-t-sm`} style={{ height: `${(per[d][p] / max) * 100}%`, minHeight: 2 }} />)}
          </div>
        ))}
      </ChartContainer>
    </div>
  );
}

function Breakdown({ operations }) {
  if (!operations.length) return <p className="text-sm text-muted">No API calls in this period.</p>;
  return (
    <div className="min-w-0">
      <p className="label mb-2">By operation</p>
      <TableScroll label="Usage by operation" className="surface-inset">
        <table className="table min-w-[720px]">
          <thead><tr><th>Provider</th><th>Operation</th><th className="text-right">Requests</th><th className="text-right">Input tokens</th><th className="text-right">Output tokens</th><th className="text-right">Audio</th><th className="text-right">Cost</th></tr></thead>
          <tbody>
            {operations.map(o => (
              <tr key={`${o.provider}|${o.operation}`}>
                <td className="font-bold">{META[o.provider]?.name || o.provider}</td>
                <td>{OPERATION[o.operation] || o.operation}{o.estimated && <span className="ml-2 text-xs text-muted">(estimated)</span>}{o.failed_requests > 0 && <span className="ml-2 text-xs text-warning">{o.failed_requests} retried</span>}</td>
                <td className="text-right tabular">{int(o.requests)}</td>
                <td className="text-right tabular">{o.input_tokens ? tokens(o.input_tokens) : "—"}</td>
                <td className="text-right tabular">{o.output_tokens ? tokens(o.output_tokens) : "—"}</td>
                <td className="text-right tabular">{o.audio_seconds ? hours(o.audio_seconds) : "—"}</td>
                <td className="text-right font-black tabular">{usd(o.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

function PriceEditor({ prices, onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const f = form || prices;
  const set = (p, k) => (e) => setForm({ ...f, [p]: { ...f[p], [k]: e.target.value === "" ? "" : Number(e.target.value) } });
  const fields = [
    ["gemini", "input_per_million", "Gemini input", "/1M"], ["gemini", "output_per_million", "Gemini output", "/1M"], ["gemini", "embedding_per_million", "Gemini embeddings", "/1M"],
    ["assemblyai", "per_audio_hour", "AssemblyAI audio", "/hr"], ["anthropic", "input_per_million", "Anthropic input (fallback)", "/1M"], ["anthropic", "output_per_million", "Anthropic output (fallback)", "/1M"],
  ];
  async function save() {
    setBusy(true);
    try { await api.saveUsageSettings({ prices: f }); toast("Prices saved — they apply to calls from now on", "success"); setForm(null); onSaved(); }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  }
  return (
    <details className="surface-inset group p-4">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-bold [&::-webkit-details-marker]:hidden">
        <Icon name="chevron" className="size-4 text-muted transition-transform group-open:rotate-180" />Price table (USD)
      </summary>
      <p className="mt-2 text-xs text-muted">Used to price Gemini and AssemblyAI calls when they are recorded. Gemini 3.8 Flash's intro rates are reported to double on 1 January 2027 — update them then. Anthropic's own reported cost is used whenever available.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([p, k, label, unit]) => (
          <FormField key={`${p}.${k}`} label={label}>
            <SuffixInput suffix={unit} type="number" inputMode="decimal" min={0} step="0.01" value={f[p][k]} onChange={set(p, k)} />
          </FormField>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-secondary" disabled={!form || busy} onClick={() => setForm(null)}>Reset</button>
        <button className="btn-primary" disabled={!form || busy} onClick={save}>{busy && <Spinner />}Save prices</button>
      </div>
    </details>
  );
}

function CreditModal({ provider, current, onClose, onSaved }) {
  const [amount, setAmount] = useState("");
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const open = !!provider;
  const name = provider ? META[provider].name : "";
  const today = new Date().toISOString().slice(0, 10);
  const shownAmount = amount !== "" ? amount : current?.amount_usd ?? "";
  const shownSince = since || current?.since || today;

  async function save(remove = false) {
    setBusy(true);
    try {
      await api.saveUsageSettings({ credits: { [provider]: remove ? null : { amount_usd: Number(shownAmount), since: shownSince } } });
      toast(remove ? `${name} credit tracking removed` : `${name} credits saved`, "success");
      setAmount(""); setSince(""); onSaved();
    } catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={() => { setAmount(""); setSince(""); onClose(); }} title={`${name} credits`} size="sm:max-w-md"
      footer={<>
        {current && <button className="btn-ghost !text-error mr-auto" disabled={busy} onClick={() => save(true)}>Stop tracking</button>}
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || shownAmount === "" || Number(shownAmount) < 0} onClick={() => save(false)}>{busy && <Spinner />}Save</button>
      </>}>
      <p className="text-sm text-muted">Enter the credit you loaded on {name} and the date you loaded it. Usage recorded from that date is subtracted to show what's left.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <FormField label="Credits added (USD)">
          <SuffixInput suffix="$" type="number" inputMode="decimal" min={0} step="0.01" value={shownAmount} onChange={(e) => setAmount(e.target.value)} data-autofocus />
        </FormField>
        <FormField label="Added on">
          <input type="date" className="input" max={today} value={shownSince} onChange={(e) => setSince(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
