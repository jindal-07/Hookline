import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, downloads, downloadFile } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, Loading, PageSkeleton, ErrorState, ProgressBar, Alert, MetricCard, Badge, TableScroll, LegendItem } from "../components/ui.jsx";
import { Menu, useConfirm, useToast } from "../components/controls.jsx";
import { VideoTable, Filters, EMPTY_FILTERS } from "../components/VideoTable.jsx";
import Icon from "../components/Icons.jsx";
import AnalysisReview from "../components/AnalysisReview.jsx";
import { BatchBadge } from "./Overview.jsx";
import { useBatchDeletion, canDeleteBatch } from "../hooks/useBatchDeletion.js";
import { fmtDate, fmtScore, fmtMs, fmtInt } from "../utils/format.js";

const STAGE_GROUPS = [
  { key: "queued", label: "Queued", statuses: ["PENDING"], className: "bg-border-strong" },
  { key: "media", label: "Download / audio", statuses: ["DOWNLOADING", "AUDIO_EXTRACTION"], className: "bg-info-solid/60" },
  { key: "analysis", label: "Transcribing / analysing", statuses: ["ANALYSIS_PENDING", "TRANSCRIBING", "SCREENPLAY_ANALYSIS"], className: "bg-info-solid" },
  { key: "matching", label: "Matching", statuses: ["MATCHING"], className: "bg-ai-solid/70" },
  { key: "generation", label: "Script generation", statuses: ["GENERATION_PENDING", "SCRIPT_GENERATION"], className: "bg-ai-solid" },
  { key: "completed", label: "Completed", statuses: ["COMPLETED"], className: "bg-success-solid", done: true },
  { key: "review", label: "Needs review", statuses: ["INCONCLUSIVE"], className: "bg-warning-solid", done: true },
  { key: "skipped", label: "Below threshold / cancelled", statuses: ["SKIPPED_LOW_SCORE", "CANCELLED"], className: "bg-neutral", done: true },
  { key: "failed", label: "Failed", statuses: ["FAILED"], className: "bg-error-solid", done: true },
];

export default function BatchDetail() {
  const { id } = useParams();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState(new Set());
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const { deleteOne } = useBatchDeletion();
  const batch = useApi(() => api.batch(id), [id]);
  const videos = useApi(() => api.batchVideos(id, { ...filters, batchId: undefined, limit: 1000 }), [id, JSON.stringify(filters)]);
  const refresh = useDebounced(() => { batch.reload({ silent: true }); videos.reload({ silent: true }); }, 600);
  useEvents(refresh, { batchId: id });

  const categories = useMemo(() => [...new Set((videos.data?.items || []).map(v => v.category).filter(Boolean))].sort(), [videos.data]);

  if (batch.error) return <ErrorState error={batch.error} onRetry={batch.reload} />;
  if (!batch.data) return <PageSkeleton />;
  const { batch: b, stats: s, validation, usage } = batch.data;
  const counts = Object.fromEntries(STAGE_GROUPS.map(g => [g.key, 0]));
  // Stage counts come from the unfiltered stats endpoint when available; fall back to the table.
  for (const v of videos.data?.items || []) { const g = STAGE_GROUPS.find(x => x.statuses.includes(v.status)); if (g && !hasFilters(filters)) counts[g.key]++; }
  const done = b.completed_videos + b.failed_videos + b.skipped_videos;

  const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok(r), "success"); refresh(); } catch (e) { toast(e.message, "error"); } };
  const onDelete = async () => { if (await deleteOne(b)) navigate("/batches"); };
  const onCancel = async () => {
    if (!(await confirm({ title: "Cancel this batch?", body: "Queued videos are removed and running ones stop at their next stage. Completed results are kept. You can retry individual videos later.", confirmLabel: "Cancel batch", danger: true }))) return;
    run(() => api.cancelBatch(id), r => `${r.cancelled} videos cancelled`);
  };
  const exportAs = (opts) => downloadFile(downloads.batchExport(id, opts)).catch(e => toast(e.message, "error"));
  const sel = [...selected];

  return (
    <>
      <PageHeader
        crumbs={[{ to: "/batches", label: "Batches" }]}
        title={<span className="flex flex-wrap items-center gap-x-3 gap-y-2"><span className="min-w-0 break-words">{b.filename}</span><BatchBadge status={b.status} />{b.purpose === "dataset" && <Badge kind="neutral">Training dataset</Badge>}</span>}
        subtitle={`Uploaded ${fmtDate(b.created_at)}${b.started_at ? ` · started ${fmtDate(b.started_at)}` : ""}${b.finished_at ? ` · finished ${fmtDate(b.finished_at)}` : ""}`}
        actions={<>
          {b.status === "DRAFT" && <button className="btn-primary" onClick={() => run(() => api.processBatch(id), r => `${r.queued} videos queued`)}><Icon name="play" className="size-3.5 fill-current" />Start processing</button>}
          {["PROCESSING", "DRAFT"].includes(b.status) && <button className="btn-secondary" onClick={onCancel}><Icon name="stop" />Cancel</button>}
          {canDeleteBatch(b) && <button className="btn-ghost !text-error" onClick={onDelete}><Icon name="trash" />Delete</button>}
          <Menu label="Export" icon="download" buttonClass="btn-secondary" items={[
            { heading: "Entire batch" },
            { label: "CSV", icon: "sheet", onClick: () => exportAs({ format: "csv" }) },
            { label: "Excel (.xlsx)", icon: "sheet", onClick: () => exportAs({ format: "xlsx" }) },
            { label: "JSON summary", icon: "file", onClick: () => exportAs({ format: "json" }) },
            { label: "Detailed JSON (transcripts, evidence, scripts)", icon: "file", onClick: () => exportAs({ format: "json", detailed: true }) },
            { divider: true },
            { heading: "Qualifying videos only" },
            { label: "Excel (.xlsx)", icon: "sheet", onClick: () => exportAs({ format: "xlsx", scope: "qualifying" }) },
            { label: "Detailed JSON", icon: "file", onClick: () => exportAs({ format: "json", scope: "qualifying", detailed: true }) },
            { divider: true },
            { heading: `Selected (${sel.length})` },
            { label: "Excel (.xlsx)", icon: "sheet", disabled: !sel.length, onClick: () => exportAs({ format: "xlsx", scope: "selected", ids: sel }) },
            { label: "Detailed JSON", icon: "file", disabled: !sel.length, onClick: () => exportAs({ format: "json", scope: "selected", ids: sel, detailed: true }) },
          ]} />
        </>}
      />

      <div className="grid grid-cols-1 gap-5">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-bold">{done} of {b.total_videos} videos finished</p>
            <p className="text-sm text-muted tabular">{b.total_videos ? Math.round((done / b.total_videos) * 100) : 0}%</p>
          </div>
          <div className="mt-2"><ProgressBar segments={STAGE_GROUPS.map(g => ({ key: g.key, label: g.label, value: counts[g.key], className: g.className, done: g.done }))} /></div>
          <ul className="mt-3 grid grid-cols-1 gap-x-5 gap-y-1.5 text-xs min-[400px]:grid-cols-2 md:flex md:flex-wrap">
            {STAGE_GROUPS.map(g => <li key={g.key} className="flex items-center gap-1.5"><LegendItem className={g.className}><span className="text-muted">{g.label}</span></LegendItem><span className="ml-auto font-bold tabular md:ml-0">{counts[g.key]}</span></li>)}
          </ul>
          {hasFilters(filters) && <p className="mt-2 text-xs text-muted">Stage breakdown hidden while filters are active.</p>}
        </Card>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Completed" value={s.completed} tone="success" icon="checkCircle" />
          <MetricCard label="Processing" value={s.processing + s.pending} tone="info" icon="clock" />
          <MetricCard label="Failed" value={s.failed} tone={s.failed ? "error" : undefined} icon="xCircle" />
          <MetricCard label="Above threshold" value={s.above_threshold} hint={`threshold ${s.threshold}`} icon="check" />
          <MetricCard label="Scripts" value={s.scripts_generated} tone="ai" icon="sparkles" />
          <MetricCard label="Avg. score" value={fmtScore(s.avg_score)} icon="dashboard" />
        </div>

        {b.purpose === "dataset" && <AnalysisReview batchId={id} batchStatus={b.status} />}

        {validation?.invalid_rows?.length > 0 && (
          <Alert kind="warning" title={`${validation.invalid_rows.length} spreadsheet row(s) were not imported`}
            action={<button className="btn-secondary btn-sm" onClick={() => downloadFile(downloads.validationReport(id)).catch(e => toast(e.message, "error"))}><Icon name="download" />Report</button>}>
            Rows {validation.invalid_rows.slice(0, 8).map(r => r.row).join(", ")}{validation.invalid_rows.length > 8 ? "…" : ""} had invalid or duplicate URLs.
          </Alert>
        )}

        <Card title="Videos" subtitle={videos.data ? `${videos.data.total} shown` : undefined} bodyClass="p-0"
          action={sel.length > 0 && <><Badge kind="neutral">{sel.length} selected</Badge><button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button></>}>
          <div className="border-b border-border p-3 sm:p-4"><Filters value={filters} onChange={setFilters} categories={categories} /></div>
          {videos.error ? <ErrorState error={videos.error} onRetry={videos.reload} /> : !videos.data ? <Loading /> : (
            <VideoTable items={videos.data.items} threshold={videos.data.threshold} selected={selected} onSelect={setSelected}
              onRetry={(v) => run(() => api.retry(v.id), r => `Retrying from ${r.stages.join(" + ")}`)} />
          )}
        </Card>

        {usage?.length > 0 && (
          <Card title="Provider usage" subtitle="Recorded per stage for this batch (successful runs)" bodyClass="p-0">
            <TableScroll label="Provider usage">
              <table className="table min-w-[680px]">
                <thead><tr><th>Stage</th><th className="text-right">Runs</th><th className="text-right">Avg. time</th><th className="text-right">Prompt tokens</th><th className="text-right">Output tokens</th><th className="text-right">Audio minutes</th><th className="text-right">Skill cost</th></tr></thead>
                <tbody>{usage.map(u => (
                  <tr key={u.stage}><td className="font-bold capitalize">{u.stage}</td><td className="text-right tabular">{u.runs}</td><td className="text-right tabular">{fmtMs(u.avg_ms)}</td><td className="text-right tabular">{fmtInt(u.prompt_tokens || null)}</td><td className="text-right tabular">{fmtInt(u.output_tokens || null)}</td><td className="text-right tabular">{u.audio_seconds ? (u.audio_seconds / 60).toFixed(1) : "—"}</td><td className="text-right tabular">{u.cost_usd ? `$${u.cost_usd.toFixed(2)}` : "—"}</td></tr>
                ))}</tbody>
              </table>
            </TableScroll>
          </Card>
        )}
      </div>
    </>
  );
}

const hasFilters = (f) => Object.entries(f).some(([k, v]) => k !== "batchId" && v);
