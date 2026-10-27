import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, PageSkeleton, ErrorState, Empty, Alert, Badge, MetricCard, Spinner, TableScroll, ChartContainer, LegendItem } from "../components/ui.jsx";
import { Tooltip, IconButton, useToast } from "../components/controls.jsx";
import Icon from "../components/Icons.jsx";
import { fmtDate, pct, secs, fmtMeta } from "../utils/format.js";

const FEATURE_LABEL = {
  hook_pattern: "Hook", pacing: "Pacing", ending_type: "Ending", arc_opening: "Opens on", arc_closing: "Closes on",
  narrative_format: "Format", story_engine: "Story step", dialogue_function: "Dialogue does", emotion: "Emotion", structure_element: "Structure",
};

export default function Dataset() {
  const toast = useToast();
  const navigate = useNavigate();
  const [building, setBuilding] = useState(false);
  const { data: ds, error, reload } = useApi(() => api.latestDataset().catch(e => (e.status === 404 ? null : Promise.reject(e))));
  const batches = useApi(() => api.batches());
  const refresh = useDebounced(() => { reload({ silent: true }); batches.reload({ silent: true }); }, 800);
  useEvents((e) => (e.type === "dataset" || e.type === "batch" || e.type === "resync") && refresh());

  async function rebuild() {
    setBuilding(true);
    try { await api.buildDataset(); toast("Dataset rebuilt from all training batches", "success"); reload({ silent: true }); }
    catch (e) { toast(e.message, "error"); }
    finally { setBuilding(false); }
  }

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (ds === null && !batches.data) return <PageSkeleton />;
  const training = (batches.data?.items || []).filter(b => b.purpose === "dataset");
  const processing = training.filter(b => b.status === "PROCESSING");

  const header = (
    <PageHeader
      title="Dataset"
      subtitle="What your best-performing videos have in common — and what your worst ones do. Built from training batches labelled best/bad."
      actions={<>
        <Link to="/upload?purpose=dataset" className="btn-secondary"><Icon name="upload" />Add training videos</Link>
        {training.length > 0 && <button className="btn-secondary" onClick={rebuild} disabled={building}>{building ? <Spinner /> : <Icon name="refresh" />}Rebuild</button>}
        {ds && <Link to="/scripts" className="btn-primary"><Icon name="sparkles" />Create a script</Link>}
      </>}
    />
  );

  if (!ds) return (
    <>
      {header}
      <Card>
        <Empty icon="dna" title={training.length ? "Training videos are still being analysed" : "No dataset yet"}
          action={!training.length && <Link to="/upload?purpose=dataset" className="btn-primary btn-sm">Upload training videos</Link>}>
          {training.length
            ? `${processing.length} training batch(es) processing. When a batch finishes, review its analysed sheet on the batch page and build the dataset.`
            : <>Upload a spreadsheet as a <b>Training dataset</b> with columns <code>video_url</code> and <code>performance</code> (best or bad). Each video is transcribed and analysed; the dataset is built when the batch finishes.</>}
        </Empty>
      </Card>
    </>
  );

  const p = ds.profile, o = p.overview;
  return (
    <>
      {header}
      <p className="-mt-2 mb-5 text-xs text-muted sm:-mt-3">{ds.name} · built {fmtDate(ds.created_at)} from {ds.source_batch_ids.length} training batch(es) · builder v{ds.builder_version}</p>

      <div className="grid grid-cols-1 gap-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard icon="film" label="Videos used" value={o.videos} hint={o.excluded ? `${o.excluded} excluded` : "none excluded"} />
          <MetricCard label="Best" value={o.best} tone="success" icon="checkCircle" />
          <MetricCard label="Bad" value={o.bad} tone="error" icon="xCircle" />
          <MetricCard label="Best: typical length" value={secs(o.duration_best.median)} hint={o.duration_best.p25 ? `middle half ${secs(o.duration_best.p25)}–${secs(o.duration_best.p75)}` : undefined} icon="clock" />
          <MetricCard label="Bad: typical length" value={secs(o.duration_bad.median)} icon="clock" />
          <MetricCard label="Scenes (best / bad)" value={`${o.scene_count_best ?? "—"} / ${o.scene_count_bad ?? "—"}`} />
        </div>

        {p.notes.length > 0 && (
          <Alert kind="info" title="Read with care">
            <ul className="list-disc pl-5">{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </Alert>
        )}

        <Card title="Genres & subgenres" subtitle={`Ranked by win rate (share of videos that were "best"; baseline ${pct(o.best_share)}). Small groups are flagged.`} bodyClass="p-0">
          <TableScroll label="Genres and subgenres">
            <table className="table min-w-[600px] lg:min-w-[820px]">
              <thead><tr><th>Genre / subgenre</th><th className="text-right">Videos</th><th className="w-48">Best vs bad</th><th className="text-right">Win rate</th><th className="text-right">Best length</th><th className="hidden text-right lg:table-cell">Bad length</th><th className="hidden text-right lg:table-cell">Scenes (best)</th><th className="w-12"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {p.genres.map(g => [
                  <GroupRow key={g.genre} row={g} label={<b>{g.genre}</b>} baseline={o.best_share} onCreate={() => navigate(`/scripts?genre=${encodeURIComponent(g.genre)}`)} />,
                  ...g.subgenres.map(s => <GroupRow key={`${g.genre}|${s.subgenre}`} row={s} sub label={<span className="pl-4 text-muted">↳ {s.subgenre}</span>} baseline={o.best_share} onCreate={() => navigate(`/scripts?genre=${encodeURIComponent(g.genre)}&subgenre=${encodeURIComponent(s.subgenre)}`)} />),
                ])}
              </tbody>
            </table>
          </TableScroll>
        </Card>

        <div className="grid gap-5 xl:grid-cols-2">
          <Card title="Video length" subtitle={p.duration.sweet_spot ? `Sweet spot: ${p.duration.sweet_spot.range} (${pct(p.duration.sweet_spot.win_rate)} best of ${p.duration.sweet_spot.total})` : "Not enough data for a sweet spot yet"}>
            <DurationChart buckets={p.duration.buckets} />
          </Card>
          <Card title="Coverage" subtitle="Languages in the training videos">
            <div className="flex flex-wrap gap-2">{Object.entries(o.languages).map(([l, n]) => <Badge key={l} kind="neutral">{l} · {n}</Badge>)}</div>
            {ds.excluded.length > 0 && (
              <details className="mt-4 text-sm">
                <summary className="flex min-h-10 cursor-pointer items-center gap-2 font-bold"><Icon name="chevron" className="size-4 text-muted" />{ds.excluded.length} excluded video(s)</summary>
                <ul className="mt-2 grid gap-1">{ds.excluded.map(x => <li key={x.video_id} className="break-words text-muted"><span className="mono break-all text-xs">{x.url}</span> — {x.reason}</li>)}</ul>
              </details>
            )}
          </Card>
        </div>

        {(p.sheet_metadata?.metrics.length > 0 || p.sheet_metadata?.categories.length > 0) && <SheetMetadataCard sm={p.sheet_metadata} baseline={o.best_share} />}

        <div className="grid gap-5 xl:grid-cols-2">
          <PatternCard title="What worked" subtitle="Much more common in best videos than in bad ones" kind="success" items={p.patterns.winning} best={o.best} bad={o.bad} />
          <PatternCard title="What to skip" subtitle="Much more common in bad videos than in best ones" kind="error" items={p.patterns.avoid} best={o.best} bad={o.bad} />
        </div>
        <p className="text-xs text-muted">×N = how many times more common the pattern is in that group (smoothed). Patterns are associations in your data, not guaranteed causes.</p>
      </div>
    </>
  );
}

function GroupRow({ row, label, sub, baseline, onCreate }) {
  const tone = row.low_sample ? "neutral" : row.win_rate >= baseline + 0.15 ? "success" : row.win_rate <= baseline - 0.15 ? "error" : "warning";
  const toneText = { success: "text-success", error: "text-error", warning: "text-warning", neutral: "text-muted" }[tone];
  return (
    <tr className={sub ? "text-sm" : "bg-surface-2"}>
      <td className="min-w-40"><span className="flex flex-wrap items-center gap-x-2 gap-y-1">{label}{row.low_sample && <Badge kind="neutral">few videos</Badge>}</span></td>
      <td className="text-right tabular">{row.total}</td>
      <td>
        <div className="flex h-2.5 overflow-hidden rounded-full border border-border bg-[image:var(--mat-well)] p-px shadow-[var(--well)]" role="img" aria-label={`${row.best} best, ${row.bad} bad`}>
          <div className="rounded-l-full bg-success-solid" style={{ width: `${(row.best / row.total) * 100}%` }} />
          <div className="rounded-r-full bg-error-solid" style={{ width: `${(row.bad / row.total) * 100}%` }} />
        </div>
        <p className="mt-1 text-xs tabular text-muted">{row.best} best · {row.bad} bad</p>
      </td>
      <td className={`text-right font-black tabular ${toneText}`}>{pct(row.win_rate)}</td>
      <td className="text-right tabular">{secs(row.duration_best.median)}{row.duration_best.p25 !== null && row.duration_best.n > 2 && <span className="block text-xs text-muted">{secs(row.duration_best.p25)}–{secs(row.duration_best.p75)}</span>}</td>
      <td className="hidden text-right tabular text-muted lg:table-cell">{secs(row.duration_bad.median)}</td>
      <td className="hidden text-right tabular lg:table-cell">{row.scene_count_best ?? "—"}</td>
      <td>{row.best > 0 && <IconButton icon="sparkles" size="sm" label="Create a script for this" onClick={onCreate} />}</td>
    </tr>
  );
}

function DurationChart({ buckets }) {
  const max = Math.max(1, ...buckets.map(b => b.total));
  return (
    <ChartContainer
      label={buckets.map(b => `${b.range}: ${b.best} best, ${b.bad} bad`).join("; ")}
      axis={buckets.map(b => <span key={b.range} className="min-w-0 flex-1 truncate text-center">{b.range}</span>)}
      legend={<><LegendItem className="bg-success-solid">Best</LegendItem><LegendItem className="bg-error-solid/80">Bad</LegendItem></>}
    >
      {buckets.map((b, i) => (
        <Tooltip key={b.range} className="h-full min-w-0 flex-1" label={`${b.range}: ${b.best} best, ${b.bad} bad${b.win_rate !== null ? ` (${pct(b.win_rate)} best)` : ""}`}>
          <div className="anim-grow-y flex h-full w-full flex-col justify-end" style={{ animationDelay: `${i * 40}ms` }} tabIndex={0} aria-label={`${b.range}: ${b.best} best, ${b.bad} bad`}>
            <div className="rounded-t-md bg-success-solid shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]" style={{ height: `${(b.best / max) * 100}%` }} />
            <div className="bg-error-solid/80" style={{ height: `${(b.bad / max) * 100}%` }} />
          </div>
        </Tooltip>
      ))}
    </ChartContainer>
  );
}

function PatternCard({ title, subtitle, kind, items, best, bad }) {
  return (
    <Card title={<span className="flex items-center gap-2"><Icon name={kind === "success" ? "checkCircle" : "xCircle"} className={`size-4.5 ${kind === "success" ? "text-success" : "text-error"}`} />{title}</span>} subtitle={subtitle} bodyClass="p-0">
      {!items.length ? <p className="p-4 text-sm text-muted sm:p-5">No clear patterns yet — more labelled videos are needed.</p> : (
        <ul className="divide-y divide-border">
          {items.slice(0, 15).map(p => (
            <li key={`${p.feature}|${p.value}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm sm:px-5">
              <Badge kind="neutral" className="shrink-0">{FEATURE_LABEL[p.feature] || p.feature}</Badge>
              <span className="min-w-0 flex-1 basis-40 break-words font-semibold">{p.value}</span>
              <span className="whitespace-nowrap text-xs tabular text-muted">{p.best}/{best} best · {p.bad}/{bad} bad</span>
              <Tooltip label={kind === "success" ? `${p.lift}× more common in best videos` : `${Math.round((1 / p.lift) * 10) / 10}× more common in bad videos`}>
                <span className={`w-14 text-right font-black tabular ${kind === "success" ? "text-success" : "text-error"}`}>×{kind === "success" ? p.lift : Math.round((1 / p.lift) * 10) / 10}</span>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The team's own sheet columns, best vs bad: metric medians, and win rate by platform / series / creator / audience. */
function SheetMetadataCard({ sm, baseline }) {
  return (
    <Card title="From your sheet" subtitle="Your own metrics and categories, compared between best and bad videos. Groups under 3 videos are greyed out." bodyClass="p-0">
      {sm.metrics.length > 0 && (
        <TableScroll label="Sheet metrics, best vs bad">
          <table className="table min-w-[560px]">
            <thead><tr><th>Metric</th><th className="text-right">Best (median)</th><th className="text-right">Bad (median)</th><th className="text-right">Best ÷ bad</th><th className="text-right">Videos</th></tr></thead>
            <tbody>
              {sm.metrics.map(m => (
                <tr key={m.key} className={m.low_sample ? "opacity-55" : ""}>
                  <td className="font-bold">{m.label}</td>
                  <td className="text-right tabular text-success">{fmtMeta(m.type, m.best.median)}</td>
                  <td className="text-right tabular text-error">{fmtMeta(m.type, m.bad.median)}</td>
                  <td className="text-right tabular">{m.ratio ? `×${m.ratio}` : "—"}</td>
                  <td className="text-right tabular text-muted">{m.best.n} / {m.bad.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {sm.categories.length > 0 && (
        <div className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:p-5 lg:grid-cols-2">
          {sm.categories.map(c => (
            <div key={c.key} className="min-w-0">
              <p className="mb-2 text-sm font-bold">{c.label} <span className="font-normal text-muted">· {c.coverage} videos</span></p>
              <ul className="grid gap-1.5">
                {c.values.map(v => (
                  <li key={v.value} className={`flex items-center justify-between gap-3 text-sm ${v.low_sample ? "opacity-55" : ""}`}>
                    <span className="min-w-0 truncate">{v.value}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular text-xs text-muted">{v.best} best · {v.bad} bad</span>
                      <Badge kind={v.low_sample ? "neutral" : v.win_rate >= baseline + 0.15 ? "success" : v.win_rate <= baseline - 0.15 ? "error" : "warning"}>{pct(v.win_rate)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
