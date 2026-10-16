// Training batches: the analysed sheet (one row per video with the features the dataset will use),
// reviewed — and optionally trimmed — before the dataset is built.
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { Card, Badge, Alert, Spinner, Loading, ErrorState, TableScroll, Empty } from "./ui.jsx";
import { useToast } from "./controls.jsx";
import { Checkbox } from "./forms.jsx";
import Icon from "./Icons.jsx";
import { secs, fmtDate, videoStatus } from "../utils/format.js";
import { StatusBadge } from "./ui.jsx";

const COLUMNS = [
  ["row", "Row"], ["title", "Title"], ["url", "URL"], ["label", "Performance"], ["genre", "Genre"], ["subgenre", "Subgenre"],
  ["duration", "Duration (s)"], ["scene_count", "Scenes"], ["language", "Language"], ["hook_pattern", "Hook"],
  ["pacing", "Pacing"], ["ending_type", "Ending"], ["emotional_arc", "Emotional arc"], ["status", "Status"],
];

function downloadCsv(filename, rows) {
  const cell = (v) => { const s = Array.isArray(v) ? v.join(" → ") : v ?? ""; return /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s); };
  const csv = [COLUMNS.map(c => c[1]).join(","), ...rows.map(r => COLUMNS.map(([k]) => cell(r[k])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename.replace(/\.(xlsx|xls)$/i, "") + "-analysed.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

function Steps({ current }) {
  const steps = ["Upload sheet", "Analyse videos", "Review analysed sheet", "Build dataset"];
  return (
    <ol className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s} aria-current={state === "current" ? "step" : undefined}
            className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${state === "current" ? "border-focus bg-[image:var(--mat-panel)] shadow-[var(--well),0_0_0_3px_var(--focus-halo)]" : "border-border bg-[image:var(--mat-panel)] shadow-[var(--well)]"} ${state === "todo" ? "text-muted" : ""}`}>
            <span className={`grid size-6 shrink-0 place-items-center rounded-full border text-[11px] ${state === "done" ? "border-success-border bg-success-bg text-success" : state === "current" ? "border-[#c9a800] bg-[image:var(--mat-accent)] text-black shadow-[var(--key-accent)]" : "border-border-strong text-muted"}`}>
              {state === "done" ? <Icon name="check" className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default function AnalysisReview({ batchId, batchStatus }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, reload } = useApi(() => api.batchAnalysis(batchId), [batchId]);
  const refresh = useDebounced(() => reload({ silent: true }), 700);
  useEvents((e) => (e.batch_id === batchId || e.type === "dataset") && refresh(), { batchId });
  const [excluded, setExcluded] = useState(() => new Set());
  const [building, setBuilding] = useState(false);

  const rows = useMemo(() => data?.rows || [], [data]);
  const usable = rows.filter(r => r.analysed && r.label);
  const selected = usable.filter(r => !excluded.has(r.video_id));
  const finished = batchStatus === "COMPLETED";
  const included = data?.in_dataset?.included;
  const step = !finished ? 1 : included ? 4 : 2;

  if (error) return <Card title="Analysed sheet"><ErrorState error={error} onRetry={reload} /></Card>;
  if (!data) return <Card title="Analysed sheet"><Loading /></Card>;

  const toggle = (id) => setExcluded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = usable.length > 0 && excluded.size === 0;
  const best = selected.filter(r => r.label === "best").length, bad = selected.length - best;

  async function build() {
    setBuilding(true);
    try {
      // Unticked rows of this batch are left out; other training batches are included as before.
      const ds = await api.buildDataset({ excludeVideoIds: [...excluded] });
      toast(`Dataset built from ${ds.video_count} videos`, "success");
      navigate("/dataset");
    } catch (e) { toast(e.message, "error"); setBuilding(false); }
  }

  return (
    <Card
      title="Analysed sheet"
      subtitle="What AssemblyAI + Gemini found for each video — exactly what the dataset will compare. Untick rows you don't want included, then build the dataset."
      action={rows.some(r => r.analysed) && <button className="btn-secondary btn-sm" onClick={() => downloadCsv(data.batch.filename, rows)}><Icon name="download" className="size-3.5" />Download .csv</button>}
      bodyClass="p-0"
    >
      <div className="grid gap-4 border-b border-border p-4 sm:p-5">
        <Steps current={step} />
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge kind="neutral">{data.summary.analysed}/{data.summary.total} analysed</Badge>
          <Badge kind="success">{data.summary.best} best</Badge>
          <Badge kind="error">{data.summary.bad} bad</Badge>
          {data.summary.failed > 0 && <Badge kind="warning">{data.summary.failed} failed — not usable</Badge>}
        </div>
        {!finished && <Alert kind="info" title="Analysis in progress">Rows fill in as each video is analysed. You can build the dataset once the batch has finished.</Alert>}
        {included && <Alert kind="success" title="Included in the current dataset" action={<Link to="/dataset" className="btn-secondary btn-sm"><Icon name="dna" className="size-3.5" />Open dataset</Link>}>{data.in_dataset.name} · built {fmtDate(data.in_dataset.created_at)}. Rebuild below if you change the selection.</Alert>}
      </div>

      {!rows.length ? <Empty icon="sheet" title="No videos in this batch" /> : (
        <>
          {/* mobile: cards */}
          <ul className="divide-y divide-border md:hidden">
            {rows.map(r => (
              <li key={r.video_id} className={`flex gap-3 px-4 py-3.5 ${r.analysed && r.label && excluded.has(r.video_id) ? "opacity-55" : ""}`}>
                <div className="pt-0.5">{r.analysed && r.label ? <Checkbox checked={!excluded.has(r.video_id)} onChange={() => toggle(r.video_id)} label={`Include row ${r.row}`} /> : <span className="block size-5" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/videos/${r.video_id}`} className="min-w-0 break-words font-bold hover:underline">{r.title || r.url.replace(/^https?:\/\/(www\.)?/, "")}</Link>
                    {r.label && <Badge kind={r.label === "best" ? "success" : "error"}>{r.label === "best" ? "Best" : "Bad"}</Badge>}
                  </div>
                  <p className="text-xs text-muted">Row {r.row}</p>
                  {r.analysed ? (
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <div><dt className="text-muted">Genre</dt><dd className="font-bold">{r.genre}</dd></div>
                      <div><dt className="text-muted">Subgenre</dt><dd className="font-bold">{r.subgenre}</dd></div>
                      <div><dt className="text-muted">Length</dt><dd className="font-bold tabular">{secs(r.duration)} · {r.scene_count} scenes</dd></div>
                      <div><dt className="text-muted">Language</dt><dd className="font-bold">{r.language}</dd></div>
                      {r.hook_pattern && <div className="col-span-2"><dt className="text-muted">Hook</dt><dd className="font-semibold">{r.hook_pattern}</dd></div>}
                      {r.ending_type && <div className="col-span-2"><dt className="text-muted">Ending</dt><dd className="font-semibold">{r.ending_type}</dd></div>}
                    </dl>
                  ) : <div className="mt-2"><StatusBadge s={videoStatus(r.status)} />{r.error && <p className="mt-1 text-xs text-error">{r.error}</p>}</div>}
                </div>
              </li>
            ))}
          </ul>
          {/* tablet / desktop: sheet */}
          <TableScroll label="Analysed sheet" className="hidden max-h-[560px] overflow-y-auto md:block">
            <table className="table min-w-[1180px]">
              <thead>
                <tr>
                  <th className="w-10"><Checkbox checked={allOn} indeterminate={excluded.size > 0 && excluded.size < usable.length} onChange={() => setExcluded(allOn ? new Set(usable.map(r => r.video_id)) : new Set())} label="Include all rows" /></th>
                  <th>Row</th><th>Video</th><th>Performance</th><th>Genre</th><th>Subgenre</th><th className="text-right">Length</th><th className="text-right">Scenes</th><th>Lang.</th><th>Hook</th><th>Pacing</th><th>Ending</th><th>Emotional arc</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const usableRow = r.analysed && r.label;
                  const off = usableRow && excluded.has(r.video_id);
                  return (
                    <tr key={r.video_id} className={off ? "opacity-50" : ""}>
                      <td>{usableRow && <Checkbox checked={!off} onChange={() => toggle(r.video_id)} label={`Include row ${r.row}`} />}</td>
                      <td className="tabular text-muted">{r.row}</td>
                      <td className="max-w-56"><Link to={`/videos/${r.video_id}`} className="block truncate font-bold hover:underline" title={r.url}>{r.title || r.url.replace(/^https?:\/\/(www\.)?/, "")}</Link></td>
                      <td>{r.label ? <Badge kind={r.label === "best" ? "success" : "error"}>{r.label === "best" ? "Best" : "Bad"}</Badge> : <span className="text-muted">—</span>}</td>
                      {r.analysed ? (<>
                        <td className="font-bold">{r.genre}</td>
                        <td>{r.subgenre}</td>
                        <td className="text-right tabular">{secs(r.duration)}</td>
                        <td className="text-right tabular">{r.scene_count}</td>
                        <td className="uppercase text-muted">{r.language}</td>
                        <td className="max-w-48 truncate" title={r.hook_pattern || ""}>{r.hook_pattern || "—"}</td>
                        <td className="max-w-36 truncate" title={r.pacing || ""}>{r.pacing || "—"}</td>
                        <td className="max-w-40 truncate" title={r.ending_type || ""}>{r.ending_type || "—"}</td>
                        <td className="max-w-56 truncate text-xs text-muted" title={r.emotional_arc.join(" → ")}>{r.emotional_arc.join(" → ") || "—"}</td>
                      </>) : (
                        <td colSpan={9}><span className="flex items-center gap-2"><StatusBadge s={videoStatus(r.status)} />{r.error && <span className="truncate text-xs text-error" title={r.error}>{r.error}</span>}</span></td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}

      <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <p className="text-sm text-muted">
          <b className="text-fg">{selected.length}</b> of {usable.length} usable videos selected ({best} best · {bad} bad).
          {" "}Other training batches stay in the dataset.
        </p>
        <button className="btn-primary" disabled={!finished || building || !selected.length} onClick={build}>
          {building ? <Spinner /> : <Icon name="dna" />}{included ? "Rebuild dataset" : "Build dataset"}
        </button>
      </div>
    </Card>
  );
}
