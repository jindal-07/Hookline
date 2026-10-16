import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "./Icons.jsx";
import { Badge, StatusBadge, Empty, TableScroll } from "./ui.jsx";
import { Select, Tooltip, IconButton } from "./controls.jsx";
import { Checkbox, SearchField } from "./forms.jsx";
import { videoStatus, matchStatus, generationStatus, taskStatus, fmtScore, fmtConf, fmtInt, scoreTone } from "../utils/format.js";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "PENDING", label: "Queued" },
  { value: "DOWNLOADING,AUDIO_EXTRACTION,ANALYSIS_PENDING,TRANSCRIBING,SCREENPLAY_ANALYSIS,MATCHING,GENERATION_PENDING,SCRIPT_GENERATION", label: "Processing" },
  { value: "COMPLETED", label: "Completed" },
  { value: "INCONCLUSIVE", label: "Needs review" },
  { value: "SKIPPED_LOW_SCORE", label: "Below threshold" },
  { value: "FAILED", label: "Failed" },
  { value: "CANCELLED", label: "Cancelled" },
];
const GEN_OPTIONS = [
  { value: "", label: "Any script status" },
  { value: "COMPLETED", label: "Script ready" },
  { value: "PENDING,RUNNING", label: "Generating" },
  { value: "AWAITING_MANUAL", label: "Awaiting import" },
  { value: "REJECTED", label: "Rejected (originality)" },
  { value: "FAILED", label: "Failed" },
  { value: "DISABLED", label: "Skill not configured" },
  { value: "NOT_ELIGIBLE", label: "Not eligible" },
];
const TONE_TEXT = { success: "text-success", warning: "text-warning", error: "text-error", neutral: "text-muted" };
/** Header tooltips for the video table. */
const COLUMN_HELP = {
  Row: "Row number of this video in the uploaded spreadsheet.",
  Video: "Title (or URL) of the video, with its category and best/bad label. Click it to open the full analysis.",
  Status: "Where the video is in the pipeline: queued, downloading, transcribing, analysing, matching, generating, or finished.",
  Analysis: "Audio = AssemblyAI transcription of the speech. Video = Gemini screenplay analysis of the visuals. Both must finish before scoring.",
  Score: "Overall match score (0–100): how closely the transcript and the screenplay analysis tell the same story. Green = at or above your threshold.",
  "S · C · D": "Story · Characters · Dialogue sub-scores (weighted 40/30/30 by default). “conf” is evidence confidence (0–1): transcript quality, amount of speech, speaker separation — not similarity.",
  Match: "Matching verdict: Matched (score and confidence high enough, so a script can be written), Partial (some elements line up), Mismatched (the audio and visuals tell different stories), or Inconclusive (not enough evidence; flagged for review).",
  Script: "Script generation status for this video: AI script ready, generating, awaiting manual import, rejected by the originality check, not eligible, or training data (dataset videos get no script).",
  Views: "View count from the spreadsheet, if provided.",
};
const RETRYABLE =["FAILED", "CANCELLED", "INCONCLUSIVE", "SKIPPED_LOW_SCORE"];

export const EMPTY_FILTERS = { status: "", threshold: "", minScore: "", category: "", generationStatus: "", q: "", batchId: "" };

/** Search is always visible; the other filters collapse behind a toggle below 1024px. */
export function Filters({ value, onChange, batches, categories = [] }) {
  const [open, setOpen] = useState(false);
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  const active = Object.entries(value).filter(([k, v]) => v && k !== "q" && (k !== "batchId" || batches)).length;
  const clear = () => onChange({ ...EMPTY_FILTERS, batchId: batches ? "" : value.batchId });
  const anyActive = active > 0 || !!value.q;
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <SearchField className="flex-1" value={value.q} onChange={set("q")} placeholder="Search URL or title" label="Search videos" />
        <button type="button" className="btn-secondary lg:hidden" aria-expanded={open} aria-controls="filter-panel" onClick={() => setOpen(o => !o)}>
          <Icon name="filter" />
          <span className="hidden min-[400px]:inline">Filters</span>
          {active > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-[image:var(--mat-accent)] px-1.5 text-xs text-black shadow-[var(--key-accent)]">{active}</span>}
        </button>
        <button type="button" className="btn-ghost hidden lg:inline-flex" disabled={!anyActive} onClick={clear}>Clear all</button>
      </div>
      <div id="filter-panel" className={`${open ? "grid" : "hidden"} gap-2 sm:grid-cols-2 lg:grid lg:grid-cols-3 xl:grid-cols-5`}>
        <Select label="Status" value={value.status} onChange={set("status")} options={STATUS_OPTIONS} />
        <Select label="Threshold" value={value.threshold} onChange={set("threshold")} options={[{ value: "", label: "Any score" }, { value: "above", label: "At/above threshold" }, { value: "below", label: "Below threshold" }]} />
        <Select label="Minimum score" value={value.minScore} onChange={set("minScore")} options={[{ value: "", label: "No minimum" }, ...[50, 60, 70, 80, 90].map(n => ({ value: String(n), label: `Score ≥ ${n}` }))]} />
        <Select label="Category" value={value.category} onChange={set("category")} options={[{ value: "", label: "Any category" }, ...categories.map(c => ({ value: c, label: c }))]} />
        {batches
          ? <Select label="Batch" value={value.batchId} onChange={set("batchId")} options={[{ value: "", label: "All batches" }, ...batches.map(b => ({ value: b.id, label: b.filename, hint: new Date(b.created_at).toLocaleDateString() }))]} />
          : <Select label="Script" value={value.generationStatus} onChange={set("generationStatus")} options={GEN_OPTIONS} />}
        <button type="button" className="btn-ghost sm:col-span-2 lg:hidden" disabled={!anyActive} onClick={clear}>Clear all filters</button>
      </div>
    </div>
  );
}

const displayUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "");

function PerfBadge({ label }) {
  if (!label) return null;
  return <Badge kind={label === "best" ? "success" : "error"}>{label === "best" ? "Best" : "Bad"}</Badge>;
}

function ScriptBadge({ v }) {
  return v.generation_status === "COMPLETED" ? <Badge kind="ai">AI script</Badge> : <StatusBadge s={generationStatus(v.generation_status)} />;
}

function RetryButton({ v, onRetry }) {
  if (!onRetry || !RETRYABLE.includes(v.status)) return null;
  return <IconButton icon="refresh" size="sm" label={v.status === "FAILED" ? `Retry from ${v.error_stage || "failed stage"}` : "Re-run from the next incomplete stage"} onClick={() => onRetry(v)} />;
}

/**
 * items: videos from the list API (each with .match + statuses). Selection is optional.
 * onRetry(video) shows a retry button for failed/cancelled/inconclusive rows.
 * ≥768px: sortable table (scrolls horizontally inside its card). Below: stacked cards.
 */
export function VideoTable({ items, threshold, selected, onSelect, onRetry, showBatch }) {
  const [sort, setSort] = useState({ key: "row", dir: 1 });
  if (!items.length) return <Empty icon="filter" title="No videos match these filters">Try clearing a filter or searching for something else.</Empty>;
  const allSelected = selected && items.every(v => selected.has(v.id));
  const someSelected = selected && items.some(v => selected.has(v.id));
  const toggleAll = () => onSelect(allSelected ? new Set() : new Set(items.map(v => v.id)));
  const toggle = (id) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); onSelect(n); };
  const val = (v) => ({ row: v.source_row_number, score: v.match?.overall_score ?? -1, views: Number(v.views ?? -1), status: v.status }[sort.key]);
  const sorted = [...items].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  const th = (key, label, cls = "") => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir > 0 ? "ascending" : "descending") : "none"}>
      <Tooltip label={`${COLUMN_HELP[label]} Click to sort.`}>
        <button className="inline-flex min-h-8 cursor-help items-center gap-1 rounded-md uppercase hover:text-fg" onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : key === "row" ? 1 : -1 }))}>
          {label}<Icon name="chevron" className={`size-3 transition-transform ${sort.key === key ? "" : "opacity-0"} ${sort.dir > 0 ? "rotate-180" : ""}`} />
        </button>
      </Tooltip>
    </th>
  );
  const hint = (label, cls = "") => (
    <th className={cls}>
      <Tooltip label={COLUMN_HELP[label]}>
        <span tabIndex={0} className="inline-flex min-h-8 cursor-help items-center rounded-md underline decoration-dotted decoration-border-strong underline-offset-4">{label}</span>
      </Tooltip>
    </th>
  );
  const subline = (v) => (showBatch ? v.category || "Uncategorised" : v.category || displayUrl(v.video_url));

  return (
    <>
      {/* ---- mobile: cards ---- */}
      <div className="md:hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm font-bold text-muted">
          {selected && <><Checkbox checked={!!allSelected} indeterminate={someSelected} onChange={toggleAll} label="Select all" /><span>Select all</span></>}
          <span className="ml-auto w-40">
              <Select label="Sort by" value={`${sort.key}:${sort.dir}`} onChange={(x) => { const [key, dir] = x.split(":"); setSort({ key, dir: Number(dir) }); }}
                className="!min-h-9 !py-1.5 text-xs" options={[{ value: "row:1", label: "Row order" }, { value: "score:-1", label: "Highest score" }, { value: "views:-1", label: "Most views" }, { value: "status:1", label: "Status" }]} />
          </span>
        </div>
        <ul className="divide-y divide-border">
          {sorted.map(v => {
            const m = v.match;
            const toneCls = TONE_TEXT[scoreTone(m?.overall_score, threshold)];
            return (
              <li key={v.id} className="flex gap-3 px-4 py-3.5">
                {selected && <div className="pt-0.5"><Checkbox checked={selected.has(v.id)} onChange={() => toggle(v.id)} label={`Select row ${v.source_row_number}`} /></div>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <Link to={`/videos/${v.id}`} className="line-clamp-2 break-words font-bold hover:underline">{v.title || displayUrl(v.video_url)}</Link>
                      <p className="mt-0.5 truncate text-xs text-muted">Row {v.source_row_number} · {subline(v)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`text-2xl font-black leading-none tabular ${toneCls}`}>{fmtScore(m?.overall_score)}</p>
                      {m && <p className="mt-1 text-[11px] tabular text-muted">conf {fmtConf(m.confidence)}</p>}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusBadge s={videoStatus(v.status)} />
                    {m && <StatusBadge s={matchStatus(m.match_status)} />}
                    <ScriptBadge v={v} />
                    <PerfBadge label={v.performance_label} />
                  </div>
                  {v.status === "FAILED" && <p className="mt-1.5 line-clamp-2 text-xs text-error">{v.error_message}</p>}
                  <div className="mt-2 flex items-center gap-3 text-xs text-muted">
                    {m && <span className="tabular">S {fmtScore(m.story_score)} · C {fmtScore(m.character_score)} · D {fmtScore(m.dialogue_score)}</span>}
                    {v.views != null && <span className="tabular">{fmtInt(v.views)} views</span>}
                    <span className="ml-auto"><RetryButton v={v} onRetry={onRetry} /></span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---- tablet / desktop: table ---- */}
      <TableScroll label="Videos" className="hidden md:block">
        <table className="table min-w-[1040px]">
          <thead>
            <tr>
              {selected && <th className="w-10"><Checkbox checked={!!allSelected} indeterminate={someSelected} onChange={toggleAll} label="Select all" /></th>}
              {th("row", "Row", "w-16")}
              {hint("Video")}
              {th("status", "Status")}
              {hint("Analysis")}
              {th("score", "Score", "text-right")}
              {hint("S · C · D", "whitespace-nowrap text-right")}
              {hint("Match")}
              {hint("Script")}
              {th("views", "Views", "text-right")}
              <th className="w-12"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(v => {
              const m = v.match;
              const toneCls = TONE_TEXT[scoreTone(m?.overall_score, threshold)];
              return (
                <tr key={v.id} className={selected?.has(v.id) ? "bg-accent-tint" : ""}>
                  {selected && <td><Checkbox checked={selected.has(v.id)} onChange={() => toggle(v.id)} label={`Select row ${v.source_row_number}`} /></td>}
                  <td className="tabular text-muted">{v.source_row_number}</td>
                  <td className="max-w-72">
                    <Link to={`/videos/${v.id}`} className="block truncate font-bold hover:underline">{v.title || displayUrl(v.video_url)}</Link>
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted"><PerfBadge label={v.performance_label} /><span className="truncate">{subline(v)}</span></p>
                    {v.status === "FAILED" && <p className="truncate text-xs text-error" title={v.error_message}>{v.error_message}</p>}
                  </td>
                  <td><StatusBadge s={videoStatus(v.status)} /></td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-1 text-xs"><span className="w-10 text-muted">Audio</span><StatusBadge s={taskStatus(v.transcript_status)} /></span>
                      <span className="flex items-center gap-1 text-xs"><span className="w-10 text-muted">Video</span><StatusBadge s={taskStatus(v.analysis_status)} /></span>
                    </div>
                  </td>
                  <td className={`text-right text-lg font-black tabular ${toneCls}`}>{fmtScore(m?.overall_score)}</td>
                  <td className="whitespace-nowrap text-right text-xs tabular text-muted">{m ? <><span className="font-bold text-fg">{fmtScore(m.story_score)} · {fmtScore(m.character_score)} · {fmtScore(m.dialogue_score)}</span><br /><span>conf {fmtConf(m.confidence)}</span></> : "—"}</td>
                  <td>{m ? <StatusBadge s={matchStatus(m.match_status)} /> : <span className="text-xs text-muted">—</span>}</td>
                  <td><ScriptBadge v={v} /></td>
                  <td className="text-right tabular">{fmtInt(v.views)}</td>
                  <td><RetryButton v={v} onRetry={onRetry} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
