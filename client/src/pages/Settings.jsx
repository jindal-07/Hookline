import { useEffect, useState } from "react";
import { api } from "../services/api.js";
import { useApi } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, PageSkeleton, ErrorState, Alert, Badge, KeyValue, Spinner, InsetPanel } from "../components/ui.jsx";
import { FormField, SuffixInput } from "../components/forms.jsx";
import { useToast } from "../components/controls.jsx";
import Icon from "../components/Icons.jsx";

export default function Settings() {
  const { data, error, reload } = useApi(() => api.settings());
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const toast = useToast();
  useEffect(() => { if (data) setForm(data.scoring); }, [data]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data || !form) return <PageSkeleton />;

  const sum = Number(form.storyWeight) + Number(form.characterWeight) + Number(form.dialogueWeight);
  const errors = [];
  if (sum !== 100) errors.push(`Weights must add up to 100 (currently ${sum}).`);
  if ([form.storyWeight, form.characterWeight, form.dialogueWeight].some(w => w < 0)) errors.push("Weights can't be negative.");
  if (form.matchThreshold < 0 || form.matchThreshold > 100) errors.push("Threshold must be between 0 and 100.");
  if (form.minMatchConfidence < 0 || form.minMatchConfidence > 1) errors.push("Minimum confidence must be between 0 and 1.");
  const dirty = JSON.stringify(form) !== JSON.stringify(data.scoring);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value === "" ? "" : Number(e.target.value) }));

  async function save() {
    setSaving(true); setServerErrors([]);
    try { await api.saveSettings(form); toast("Settings saved — they apply to videos matched from now on", "success"); reload({ silent: true }); }
    catch (e) { setServerErrors([].concat(e.details || e.message)); toast("Settings were not saved", "error"); }
    finally { setSaving(false); }
  }

  const p = data.providers;
  return (
    <>
      <PageHeader title="Settings" subtitle="Scoring rules are validated and applied on the server. Each match result stores the configuration it used." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card title="Matching & eligibility" subtitle={`Scoring version ${data.scoring_version}`}>
          <div className="grid gap-6">
            <InsetPanel>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="thr" className="font-bold">Match threshold</label>
                <span className="min-w-14 rounded-xl border border-border bg-[image:var(--mat-key)] px-2.5 py-1 text-center text-xl font-black tabular shadow-[var(--key)]">{form.matchThreshold}</span>
              </div>
              <input id="thr" type="range" min={0} max={100} step={1} value={form.matchThreshold} onChange={set("matchThreshold")} className="range mt-3" style={{ "--fill": `${form.matchThreshold}%` }} aria-describedby="thr-hint" />
              <div className="flex justify-between text-[10px] font-bold tabular text-muted" aria-hidden="true"><span>0</span><span>50</span><span>100</span></div>
              <p id="thr-hint" className="mt-2 text-xs text-muted">Videos scoring at or above this, with sufficient confidence, get a generated script. 75 is a starting point — tune it after reviewing real matches.</p>
            </InsetPanel>

            <fieldset>
              <legend className="font-bold">Dimension weights <span className={`ml-2 text-sm tabular ${sum === 100 ? "text-success" : "text-error"}`}>{sum}/100</span></legend>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {[["storyWeight", "Story & events"], ["characterWeight", "Characters"], ["dialogueWeight", "Dialogue"]].map(([k, label]) => (
                  <FormField key={k} label={label}>
                    <SuffixInput suffix="%" type="number" inputMode="numeric" min={0} max={100} value={form[k]} onChange={set(k)} aria-invalid={sum !== 100} />
                  </FormField>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Minimum confidence" hint="Evidence quality needed before a high score qualifies.">
                <input type="number" inputMode="decimal" min={0} max={1} step={0.05} className="input tabular" value={form.minMatchConfidence} onChange={set("minMatchConfidence")} />
              </FormField>
              <FormField label="Contradiction penalty" hint="Points deducted per contradiction (max 25 per dimension).">
                <input type="number" inputMode="numeric" min={0} max={50} step={1} className="input tabular" value={form.contradictionPenalty} onChange={set("contradictionPenalty")} />
              </FormField>
            </div>

            {(errors.length > 0 || serverErrors.length > 0) && <Alert kind="error" title="Fix before saving"><ul className="list-disc pl-5">{[...errors, ...serverErrors].map((e, i) => <li key={i}>{e}</li>)}</ul></Alert>}
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <button className="btn-secondary" disabled={!dirty || saving} onClick={() => setForm(data.scoring)}>Reset</button>
              <button className="btn-primary" disabled={!dirty || errors.length > 0 || saving} onClick={save}>{saving && <Spinner />}Save settings</button>
            </div>
          </div>
        </Card>

        <div className="grid content-start gap-5">
          <Card title="Providers" subtitle="Credentials live only in the server's .env">
            <ul className="grid gap-2 text-sm">
              <Provider name="Video download" ok={p.downloader.ready} detail={p.downloader.provider} />
              <Provider name="Transcription" ok={p.transcriber.ready} detail={`${p.transcriber.provider}${p.transcriber.ready ? "" : " — ASSEMBLYAI_API_KEY missing"}`} />
              <Provider name="Video analysis" ok={p.analyzer.ready} detail={`${p.analyzer.provider} · ${p.analyzer.model}${p.analyzer.ready ? "" : " — GEMINI_API_KEY missing"}`} />
              <Provider name="Embeddings" ok={p.embeddings.semantic} warn={!p.embeddings.semantic} detail={`${p.embeddings.provider} · ${p.embeddings.model}${p.embeddings.multilingual ? " · multilingual" : ""}`} note={p.embeddings.warning} />
              <Provider name="Claude Skill" ok={p.skill.ready} warn={!p.skill.ready} detail={p.skill.ready ? `${p.skill.mode} · ${p.skill.skill || ""}${p.skill.version ? ` v${p.skill.version}` : ""}` : `${p.skill.mode}`} note={p.skill.error} />
            </ul>
          </Card>
          <Card title="Limits">
            <KeyValue items={[["Upload size", `${data.limits.max_upload_mb} MB`], ["Rows per batch", data.limits.max_rows.toLocaleString()], ["Max video length", `${Math.round(data.limits.max_video_duration_seconds / 60)} min`], ["Media retention", `${data.limits.media_retention_hours} h`]]} />
          </Card>
        </div>
      </div>
    </>
  );
}

function Provider({ name, ok, warn, detail, note }) {
  return (
    <li className="surface-inset flex items-start gap-3 p-3">
      <span className={`status-led mt-1.5 ${ok ? "on" : "off !animate-none"}`} style={ok || warn ? undefined : { background: "var(--red)", boxShadow: "0 0 8px rgba(220,38,38,.6)" }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-bold">{name}<Badge kind={ok ? "success" : warn ? "warning" : "error"}>{ok ? "Ready" : warn ? "Limited" : "Not configured"}</Badge></p>
        <p className="break-words text-muted">{detail}</p>
        {note && <p className="mt-0.5 break-words text-xs text-warning">{note}</p>}
      </div>
    </li>
  );
}
