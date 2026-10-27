import { Link } from "react-router-dom";
import { api } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, MetricCard, PageSkeleton, ErrorState, Empty, ProgressBar, Badge, ChartContainer, LegendItem } from "../components/ui.jsx";
import Icon from "../components/Icons.jsx";
import { fmtScore, fmtConf, fmtDate, titleCase } from "../utils/format.js";

export default function Overview() {
  const stats = useApi(() => api.stats());
  const batches = useApi(() => api.batches());
  const refresh = useDebounced(() => { stats.reload({ silent: true }); batches.reload({ silent: true }); }, 800);
  useEvents(refresh);

  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  if (!stats.data) return <PageSkeleton />;
  const s = stats.data;
  const recent = (batches.data?.items || []).slice(0, 6);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Analysis and script generation across every batch."
        actions={<Link to="/upload" className="btn-primary"><Icon name="upload" />Upload spreadsheet</Link>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 min-[1360px]:grid-cols-7 [&>:last-child]:col-span-2 min-[1360px]:[&>:last-child]:col-span-1">
        <MetricCard label="Submitted" value={s.total} icon="film" />
        <MetricCard label="Processing" value={s.processing + s.pending} hint={`${s.pending} queued`} tone="info" icon="clock" />
        <MetricCard label="Completed" value={s.completed} tone="success" icon="checkCircle" />
        <MetricCard label="Failed" value={s.failed} tone={s.failed ? "error" : undefined} icon="xCircle" />
        <MetricCard label="Above threshold" value={s.above_threshold} hint={`threshold ${s.threshold} · ${s.eligible} approved`} icon="check" />
        <MetricCard label="Scripts" value={s.scripts_generated} tone="ai" icon="sparkles" />
        <MetricCard label="Avg. score" value={fmtScore(s.avg_score)} hint={`avg. confidence ${fmtConf(s.avg_confidence)}`} icon="dashboard" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 sm:mt-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title="Recent batches" action={<Link to="/batches" className="btn-ghost btn-sm">View all<Icon name="chevronRight" className="size-3.5" /></Link>} bodyClass="p-0">
          {!recent.length ? (
            <Empty icon="sheet" title="No batches yet" action={<Link to="/upload" className="btn-primary btn-sm">Upload your first spreadsheet</Link>}>
              Upload an Excel file with a <code>video_url</code> column to start.
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map(b => {
                const done = b.completed_videos + b.failed_videos + b.skipped_videos;
                return (
                  <li key={b.id}>
                    <Link to={`/batches/${b.id}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-sunken sm:gap-4 sm:px-5">
                      <span className="hidden size-10 shrink-0 place-items-center rounded-xl border border-border bg-[image:var(--mat-key)] text-muted shadow-[var(--key)] min-[400px]:grid"><Icon name={b.purpose === "dataset" ? "dna" : "sheet"} className="size-4.5" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="min-w-0 truncate font-bold">{b.filename}</p>
                          <BatchBadge status={b.status} />
                        </div>
                        <p className="text-xs text-muted">{fmtDate(b.created_at)} · {b.total_videos} videos</p>
                        <div className="mt-2 sm:hidden"><ProgressBar value={done} max={b.total_videos || 1} /></div>
                      </div>
                      <div className="hidden w-40 shrink-0 sm:block">
                        <ProgressBar value={done} max={b.total_videos || 1} />
                        <p className="mt-1 text-right text-xs tabular text-muted">{done}/{b.total_videos}</p>
                      </div>
                      <Icon name="chevronRight" className="size-4 shrink-0 text-muted" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Match score distribution" subtitle="Latest score per video">
          <ScoreChart data={s.score_distribution} threshold={s.threshold} />
          {s.above_threshold + s.eligible > 0 && (
            <p className="mt-4 text-sm text-muted">
              <b className="tabular text-fg">{s.above_threshold}</b> scored {s.threshold} or more · <b className="tabular text-fg">{s.eligible}</b> approved for scripts
              {s.above_threshold > s.eligible && <> — the other {s.above_threshold - s.eligible} have a high score but not enough confidence in it, or too many mismatches</>}.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

export function BatchBadge({ status }) {
  const map = { DRAFT: ["neutral", "Draft"], QUEUED: ["info", "Queued"], PROCESSING: ["info", "Processing"], COMPLETED: ["success", "Completed"], CANCELLED: ["neutral", "Cancelled"] };
  const [kind, label] = map[status] || ["neutral", titleCase(status)];
  return <Badge kind={kind} spinning={status === "PROCESSING"}>{label}</Badge>;
}

/** Accessible bar chart: buckets at or above the threshold use the primary (yellow) series (the server splits the bucket the threshold falls in). */
function ScoreChart({ data, threshold }) {
  const max = Math.max(1, ...data.map(d => d.count));
  const total = data.reduce((t, d) => t + d.count, 0);
  if (!total) return <Empty icon="dashboard" title="No scores yet">Scores appear here as videos finish matching.</Empty>;
  return (
    <ChartContainer
      label={`Score distribution: ${data.map(d => `${d.bucket}: ${d.count}`).join(", ")}`}
      axis={data.map(d => <span key={d.bucket} className="flex-1 text-center">{d.from}</span>)}
      legend={<>
        <LegendItem className="bg-chart-primary">At or above threshold ({threshold})</LegendItem>
        <LegendItem className="bg-border-strong">Below threshold</LegendItem>
      </>}
    >
      {data.map((d, i) => {
        const above = d.above;
        return (
          <div key={d.bucket} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.bucket}: ${d.count}`}>
            <span className="mb-1 text-center text-[10px] font-bold tabular text-muted opacity-0 transition-opacity group-hover:opacity-100">{d.count}</span>
            <div
              className={`anim-grow-y rounded-t-md border border-b-0 ${above ? "border-[#c9a800] bg-[image:var(--mat-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]" : "border-border-strong bg-border-strong"}`}
              style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 4 : 0, animationDelay: `${i * 30}ms` }}
            />
          </div>
        );
      })}
    </ChartContainer>
  );
}
