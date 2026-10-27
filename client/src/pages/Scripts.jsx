import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, downloads, downloadFile } from "../services/api.js";
import { useApi, useEvents, useDebounced, usePolling, useNow } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, Loading, PageSkeleton, ErrorState, Empty, Alert, Badge, StatusBadge, Spinner } from "../components/ui.jsx";
import { Select, IconButton, Menu, useToast, useConfirm } from "../components/controls.jsx";
import { FormField } from "../components/forms.jsx";
import Icon from "../components/Icons.jsx";
import { fmtDate, pct, secs, scriptStatus, isScriptBusy, elapsed } from "../utils/format.js";

const LANGS = { hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", bn: "Bengali", mr: "Marathi", gu: "Gujarati", pa: "Punjabi", ur: "Urdu" };

export default function Scripts() {
  const [params] = useSearchParams();
  const dataset = useApi(() => api.latestDataset().catch(e => (e.status === 404 ? null : Promise.reject(e))));
  const settings = useApi(() => api.settings());
  const scripts = useApi(() => api.scripts());
  const refresh = useDebounced(() => scripts.reload({ silent: true }), 500);
  useEvents((e) => {
    if (e.type === "script" || e.type === "resync") refresh();
    if (e.type === "dataset" || e.type === "resync") dataset.reload({ silent: true });
  });
  // Live events are the main path; while anything is queued or writing, also re-check every 8s in case one is missed.
  const items = scripts.data?.items || [];
  usePolling(() => scripts.reload({ silent: true }), 8000, items.some(s => isScriptBusy(s.status)));
  useFinishedToasts(items);

  if (dataset.error) return <ErrorState error={dataset.error} onRetry={dataset.reload} />;
  if (dataset.loading && !dataset.data) return <PageSkeleton />;
  const ds = dataset.data;
  const skill = settings.data?.providers.skill;

  return (
    <>
      <PageHeader title="Scripts" subtitle="Write new standalone episodes with your scriptwriter skill, guided by what worked in your best videos." />
      {!ds ? (
        <Card><Empty icon="dna" title="Build a dataset first" action={<Link to="/dataset" className="btn-primary btn-sm">Go to Dataset</Link>}>Upload your best and bad performing videos as a training dataset. Once they're analysed, you can create scripts here.</Empty></Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-5">
            {skill && <SkillBanner skill={skill} />}
            <CreateForm ds={ds} initialGenre={params.get("genre")} initialSubgenre={params.get("subgenre")} onCreated={() => scripts.reload({ silent: true })} />
          </div>
          <ScriptList scripts={scripts} />
        </div>
      )}
    </>
  );
}

function SkillBanner({ skill }) {
  if (skill.mode === "agent-sdk" && skill.ready) return <Alert kind="ai" title={`Skill: ${skill.skill} v${skill.version}`}>Runs automatically through the Claude Agent SDK.</Alert>;
  if (skill.mode === "manual") return <Alert kind="warning" title={`Manual mode${skill.skill ? ` · ${skill.skill}` : ""}`}>No Anthropic API key is set, so each script is exported as a job file for Claude Code. Paste the result back on the script's page. Add ANTHROPIC_API_KEY to run the skill automatically.</Alert>;
  if (skill.mode === "mock") return <Alert kind="info" title="Demo mode">Scripts come from a mock skill, not your scriptwriter skill.</Alert>;
  return <Alert kind="error" title="No skill configured">{skill.error || "Set SKILL_DIR and SKILL_MODE in .env."}</Alert>;
}

function CreateForm({ ds, initialGenre, initialSubgenre, onCreated }) {
  const p = ds.profile;
  const toast = useToast();
  const navigate = useNavigate();
  const genres = useMemo(() => p.genres.filter(g => g.best > 0), [p]);
  const [genre, setGenre] = useState(initialGenre && genres.some(g => g.genre === initialGenre) ? initialGenre : genres[0]?.genre || "");
  const [subgenre, setSubgenre] = useState(initialSubgenre || "");
  const [duration, setDuration] = useState("");
  const [language, setLanguage] = useState(Object.entries(p.overview.languages).sort((a, b) => b[1] - a[1])[0]?.[0] || "hi");
  const [premise, setPremise] = useState("");
  const [notes, setNotes] = useState("");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const g = genres.find(x => x.genre === genre);
  const subOptions = (g?.subgenres || []).filter(s => s.best > 0);
  useEffect(() => { if (subgenre && !subOptions.some(s => s.subgenre === subgenre)) setSubgenre(""); }, [genre, subgenre, subOptions]);
  const pb = useApi(() => (genre ? api.playbook(ds.id, genre, subgenre || undefined) : Promise.resolve(null)), [ds.id, genre, subgenre]);

  if (!genres.length) return <Card><Empty icon="dna" title="No best-performing videos in the dataset">The dataset needs at least one video labelled best.</Empty></Card>;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createScripts({ datasetId: ds.id, genre, subgenre: subgenre || undefined, targetDurationSeconds: duration ? Number(duration) : undefined, language, premise: premise || undefined, notes: notes || undefined, count });
      toast(`${r.items.length} script${r.items.length > 1 ? "s" : ""} queued`, "success");
      onCreated();
      if (r.items.length === 1) navigate(`/scripts/${r.items[0].id}`);
    } catch (err) { toast(err.message, "error"); }
    finally { setBusy(false); }
  }

  const play = pb.data;
  return (
    <Card title="New standalone episode" subtitle={`From ${ds.name} · ${ds.video_count} videos`}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Genre">
            <Select label="Genre" value={genre} onChange={setGenre} options={genres.map(x => ({ value: x.genre, label: x.genre, hint: `${pct(x.win_rate)} best · ${x.total} videos${x.low_sample ? " · few videos" : ""}` }))} />
          </FormField>
          <FormField label="Subgenre">
            <Select label="Subgenre" value={subgenre} onChange={setSubgenre} options={[{ value: "", label: "Any subgenre", hint: "Use the genre as a whole" }, ...subOptions.map(s => ({ value: s.subgenre, label: s.subgenre, hint: `${pct(s.win_rate)} best · ${s.total} videos` }))]} />
          </FormField>
          <FormField label="Target length (seconds)" hint={play?.duration.target_seconds ? `Best videos here run about ${secs(play.duration.target_seconds)}` : undefined}>
            <input type="number" inputMode="numeric" min={10} max={1800} className="input tabular" value={duration} onChange={e => setDuration(e.target.value)} placeholder={play?.duration.target_seconds ? `${play.duration.target_seconds} (what worked)` : "60"} />
          </FormField>
          <FormField label="Language">
            <Select label="Language" value={language} onChange={setLanguage} options={[...new Set([...Object.keys(p.overview.languages), "hi", "en"])].filter(l => l !== "unknown").map(l => ({ value: l, label: LANGS[l] || l }))} />
          </FormField>
        </div>
        <FormField label="Premise or theme" optional>
          <textarea className="input min-h-24" value={premise} onChange={e => setPremise(e.target.value)} maxLength={2000} placeholder="e.g. A delivery rider discovers his landlord is his estranged father" />
        </FormField>
        <FormField label="Notes for the writer" optional>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} maxLength={2000} placeholder="e.g. Keep it to two locations; end on a cliffhanger" />
        </FormField>

        {play && <PlaybookPreview play={play} />}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <div className="w-36 max-[359px]:flex-1"><Select label="Number of scripts" value={count} onChange={setCount} options={[1, 2, 3, 4, 5].map(n => ({ value: n, label: `${n} script${n > 1 ? "s" : ""}` }))} /></div>
          <button className="btn-primary max-[359px]:w-full" disabled={busy || !genre}>{busy ? <Spinner /> : <Icon name="sparkles" />}Write script{count > 1 ? "s" : ""}</button>
        </div>
      </form>
    </Card>
  );
}

function PlaybookPreview({ play }) {
  return (
    <details className="surface-inset group p-4 text-sm" open>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-bold [&::-webkit-details-marker]:hidden"><Icon name="chevron" className="size-4 text-muted transition-transform group-open:rotate-180" />What the skill will be told</summary>
      <div className="mt-3 grid gap-3">
        {play.evidence && (
          <p className="text-muted">
            Based on <b className="text-fg">{play.evidence.videos}</b> videos ({play.evidence.best} best, {play.evidence.bad} bad){play.evidence.low_sample && <Badge kind="warning" className="ml-2">few videos — weak evidence</Badge>}.
            {play.duration.target_seconds && <> Target length <b className="text-fg">{secs(play.duration.target_seconds)}</b>{play.duration.worked_range_seconds && <> (best videos: {secs(play.duration.worked_range_seconds[0])}–{secs(play.duration.worked_range_seconds[1])})</>}.</>}
            {play.scene_count_guidance && <> About <b className="text-fg">{play.scene_count_guidance}</b> scenes.</>}
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <div><p className="label mb-1 text-success">Use</p>{play.use_patterns.length ? <ul className="list-disc space-y-0.5 pl-5">{play.use_patterns.slice(0, 6).map((u, i) => <li key={i}>{u.replace(/\s\(.*$/, "")}</li>)}</ul> : <p className="text-muted">No strong patterns yet.</p>}</div>
          <div><p className="label mb-1 text-error">Avoid</p>{play.avoid_patterns.length ? <ul className="list-disc space-y-0.5 pl-5">{play.avoid_patterns.slice(0, 6).map((u, i) => <li key={i}>{u.replace(/\s\(.*$/, "")}</li>)}</ul> : <p className="text-muted">No strong patterns yet.</p>}</div>
        </div>
        <p className="text-xs text-muted">Patterns {play.pattern_scope}. Plus {play.structural_examples.length} structural examples (mechanics only — no source names, lines or premises).</p>
      </div>
    </details>
  );
}

/** Toast once when a script this page saw as queued/writing finishes. */
function useFinishedToasts(items) {
  const toast = useToast();
  const seen = useRef(new Map());
  useEffect(() => {
    for (const s of items) {
      const before = seen.current.get(s.id);
      if (before && isScriptBusy(before) && !isScriptBusy(s.status)) {
        const name = s.title || "Your script";
        if (s.status === "COMPLETED") toast(`“${name}” is ready`, "success");
        else if (s.status === "AWAITING_MANUAL") toast(`“${name}” is waiting for a manual import`, "warning");
        else toast(`“${name}”: ${scriptStatus(s.status).label}`, "error");
      }
      seen.current.set(s.id, s.status);
    }
  }, [items, toast]);
}

function ScriptList({ scripts }) {
  const toast = useToast();
  const confirm = useConfirm();
  if (scripts.error) return <ErrorState error={scripts.error} onRetry={scripts.reload} />;
  const items = scripts.data?.items || [];
  const del = async (s) => {
    if (!(await confirm({ title: "Delete this script?", body: "The script and its generation details will be removed permanently.", confirmLabel: "Delete", danger: true }))) return;
    try { await api.deleteScript(s.id); toast("Script deleted", "success"); scripts.reload({ silent: true }); } catch (e) { toast(e.message, "error"); }
  };
  return (
    <Card title="Your scripts" subtitle={items.length ? `${items.length} total` : undefined} bodyClass="p-0">
      {!scripts.data ? <Loading /> : !items.length ? <Empty icon="sparkles" title="No scripts yet">Choose a genre and write your first episode.</Empty> : (
        <ul className="divide-y divide-border">
          {items.map(s => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <span className="hidden size-10 shrink-0 place-items-center rounded-xl border border-border bg-[image:var(--mat-key)] text-ai shadow-[var(--key)] min-[400px]:grid"><Icon name="file" className="size-4.5" /></span>
              <div className="min-w-0 flex-1">
                <Link to={`/scripts/${s.id}`} className="block truncate font-bold hover:underline">{s.title || `${s.brief.subgenre || s.brief.genre} episode`}</Link>
                <p className="truncate text-xs text-muted">{s.brief.genre}{s.brief.subgenre && ` · ${s.brief.subgenre}`} · {secs(s.brief.target_duration_seconds)} · {fmtDate(s.created_at)}</p>
                <div className="mt-1.5 flex items-center gap-2"><StatusBadge s={scriptStatus(s.status)} />{isScriptBusy(s.status) && <Elapsed s={s} />}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {s.status === "COMPLETED" && <Menu ariaLabel={`Download ${s.title || "script"}`} icon="download" buttonClass="btn-ghost btn-sm" items={[
                  { label: "Word document (.docx)", icon: "file", onClick: () => downloadFile(downloads.scriptFile(s.id, "docx")).catch(e => toast(e.message, "error")) },
                  { label: "PDF", icon: "file", onClick: () => downloadFile(downloads.scriptFile(s.id, "pdf")).catch(e => toast(e.message, "error")) },
                ]} />}
                <IconButton icon="trash" size="sm" label="Delete script" className="hover:!text-error" onClick={() => del(s)} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Live timer for a queued/writing script ("writing for 2:14"). */
export function Elapsed({ s, className = "text-xs text-muted" }) {
  const now = useNow(1000, isScriptBusy(s.status));
  const since = s.status === "RUNNING" ? s.updated_at : s.created_at;
  return <span className={`tabular ${className}`}>{s.status === "RUNNING" ? "writing for" : "waiting"} {elapsed(since, now)}</span>;
}
