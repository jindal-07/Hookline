import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, downloads, downloadFile } from "../services/api.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, Alert, Badge, Spinner, MetricCard, TableScroll } from "../components/ui.jsx";
import { Select, useToast } from "../components/controls.jsx";
import { RadioCard } from "../components/forms.jsx";
import Icon from "../components/Icons.jsx";
import { fmtInt } from "../utils/format.js";

const PURPOSES = [
  { value: "generation", icon: "film", title: "Analyse & generate per video", body: "Each qualifying video gets its own original script inspired by it." },
  { value: "dataset", icon: "dna", title: "Training dataset (best / bad)", body: "Analyse your best and worst performers to learn what works. Needs a performance column with best or bad for every row. No per-video scripts." },
];

export default function Upload() {
  const [file, setFile] = useState(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [starting, setStarting] = useState(false);
  const [params] = useSearchParams();
  const [purpose, setPurpose] = useState(params.get("purpose") === "dataset" ? "dataset" : "generation");
  const input = useRef();
  const toast = useToast();
  const navigate = useNavigate();

  async function upload(f) {
    setFile(f); setError(null); setPreview(null); setBusy(true);
    try { setPreview(await api.uploadBatch(f, purpose)); }
    catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  function onPick(f) {
    if (!f) return;
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) { setError(new Error("Choose an Excel or CSV file (.xlsx, .xls or .csv).")); return; }
    upload(f);
  }

  async function start() {
    setStarting(true);
    try {
      const r = await api.processBatch(preview.batch.id);
      toast(preview.batch.purpose === "dataset" ? `Analysing ${r.queued} training videos — review the analysed sheet when they finish` : `Processing started — ${r.queued} videos queued`, "success");
      navigate(`/batches/${preview.batch.id}`);
    } catch (e) { toast(e.message, "error"); setStarting(false); }
  }

  const rows = (preview?.rows || []).filter(r => filter === "all" || (filter === "valid" ? r.valid : filter === "duplicates" ? r.duplicate_of : !r.valid));

  return (
    <>
      <PageHeader title="Upload spreadsheet" subtitle={<>Excel or CSV file with a <code>video_url</code> column. Optional: title, category, views, likes, shares, comments, performance. Training datasets can also include <code>transcript</code>, <code>screenplay</code> and <code>duration_sec</code> to skip re-analysing the videos.</>} />

      {!preview && (
        <div className="grid gap-4">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="label mb-2">What is this upload for?</legend>
            {PURPOSES.map(o => (
              <RadioCard key={o.value} name="purpose" value={o.value} checked={purpose === o.value} onChange={() => setPurpose(o.value)} icon={o.icon} title={o.title}>{o.body}</RadioCard>
            ))}
          </fieldset>

          <Card bodyClass="p-3 sm:p-4">
            <label
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); onPick(e.dataTransfer.files[0]); }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-5 py-12 text-center shadow-[var(--well)] transition-[background,border-color] duration-200 focus-within:border-focus sm:py-16 ${over ? "border-focus bg-accent-tint" : "border-border-strong bg-[image:var(--mat-panel)] hover:border-gray-soft"}`}
            >
              <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={(e) => onPick(e.target.files[0])} />
              <span className={`grid size-16 place-items-center rounded-2xl border shadow-[var(--key)] transition-transform duration-200 ${over ? "-translate-y-1 border-[#c9a800] bg-[image:var(--mat-accent)] text-black" : "border-border bg-[image:var(--mat-key)] text-muted"}`}>
                {busy ? <Spinner className="size-6" /> : <Icon name="upload" className="size-7" />}
              </span>
              <div className="min-w-0">
                <p className="break-words text-lg font-black">{busy ? `Validating ${file?.name}…` : "Drop an Excel or CSV file here or click to browse"}</p>
                <p className="mt-1 text-sm text-muted">.xlsx, .xls or .csv · each row is validated independently — invalid rows won't block the rest</p>
              </div>
              <span className="btn-secondary pointer-events-none">Choose file</span>
            </label>
          </Card>
        </div>
      )}

      {error && <div className="mt-4"><Alert kind="error" title="Upload failed">{error.message}{error.details && <ul className="mt-1 list-disc pl-5">{[].concat(error.details).map((d, i) => <li key={i}>{d}</li>)}</ul>}</Alert></div>}

      {preview && (
        <div className="grid grid-cols-1 gap-5">
          {preview.batch.purpose === "dataset" && <Alert kind="info" title="Training dataset">These videos are transcribed and analysed only. When analysis finishes you'll see the analysed sheet (genre, subgenre, length, hook…) to review, then build the dataset and create scripts in the Scripts tab.</Alert>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <MetricCard label="Rows" value={preview.summary.total_rows} icon="sheet" />
            <MetricCard label="Valid" value={preview.summary.valid} tone="success" icon="checkCircle" />
            <MetricCard label="Invalid" value={preview.summary.invalid} tone={preview.summary.invalid ? "error" : undefined} icon="xCircle" />
            <MetricCard label="Duplicates" value={preview.summary.duplicates} tone={preview.summary.duplicates ? "warning" : undefined} icon="copy" />
            {preview.summary.best !== undefined && <MetricCard label="Labelled best" value={preview.summary.best} tone="success" />}
            {preview.summary.bad !== undefined && <MetricCard label="Labelled bad" value={preview.summary.bad} tone="error" />}
            {preview.summary.imported !== undefined && <MetricCard label="From your text" value={preview.summary.imported} tone="ai" icon="file" hint="no video download" />}
          </div>

          {preview.summary.duplicates > 0 && <Alert kind="warning" title={`${preview.summary.duplicates} duplicate URL(s)`}>Only the first occurrence of each video is processed; duplicates are listed below.</Alert>}
          {preview.summary.imported > 0 && (
            <Alert kind="ai" title={`${preview.summary.imported} video(s) will be analysed from your transcript and screenplay`}>
              These rows are not downloaded or transcribed again. Gemini reads your screenplay text and fills in the same analysis (genre, subgenre, scenes, hook, ending…) — text only, about $0.03–0.04 per video. Your transcript is kept for the originality check.
              {preview.summary.imported < preview.summary.valid && ` The other ${preview.summary.valid - preview.summary.imported} row(s) have no screenplay text and go through the normal video pipeline.`}
            </Alert>
          )}
          {preview.columns.optional_missing.length > 0 && <Alert kind="info">Optional columns not found: {preview.columns.optional_missing.join(", ")}. Engagement metrics won't be shown for this batch.</Alert>}

          <Card
            title={<span className="break-words">{preview.batch.filename}</span>}
            subtitle={`Sheet "${preview.sheet}", header on row ${preview.header_row} · URL column "${preview.columns.video_url}"`}
            action={
              <>
                <div className="w-40"><Select value={filter} onChange={setFilter} label="Show rows" options={[{ value: "all", label: "All rows" }, { value: "valid", label: "Valid only" }, { value: "invalid", label: "Invalid only" }, { value: "duplicates", label: "Duplicates" }]} /></div>
                {preview.summary.invalid > 0 && <button className="btn-secondary" onClick={() => downloadFile(downloads.validationReport(preview.batch.id)).catch(e => toast(e.message, "error"))}><Icon name="download" />Error report</button>}
              </>
            }
            bodyClass="p-0"
          >
            <TableScroll label="Spreadsheet rows" className="max-h-[480px] overflow-y-auto">
              <table className="table min-w-[860px]">
                <thead><tr><th>Row</th><th>Status</th><th>URL</th><th>Title</th><th>Category</th><th>Performance</th>{preview.summary.imported !== undefined && <><th>Source</th><th className="text-right">Length</th></>}<th className="text-right">Views</th><th>Issues</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.row}>
                      <td className="tabular text-muted">{r.row}</td>
                      <td>{r.valid ? <Badge kind="success">Valid</Badge> : r.duplicate_of ? <Badge kind="warning">Duplicate</Badge> : <Badge kind="error">Invalid</Badge>}</td>
                      <td className="mono max-w-72 truncate text-xs" title={r.video_url}>{r.video_url || <span className="text-muted">(empty)</span>}</td>
                      <td className="max-w-48 truncate">{r.title || "—"}</td>
                      <td>{r.category || "—"}</td>
                      <td>{r.performance ? <Badge kind={r.performance === "best" ? "success" : "error"}>{r.performance === "best" ? "Best" : "Bad"}</Badge> : <span className="text-muted">—</span>}</td>
                      {preview.summary.imported !== undefined && <>
                        <td>{r.screenplay_chars ? <span className="whitespace-nowrap text-xs" title={`Screenplay ${r.screenplay_chars.toLocaleString()} chars · transcript ${r.transcript_chars.toLocaleString()} chars`}><Badge kind="ai" icon="file">Text</Badge></span> : <Badge kind="neutral" icon="film">Video</Badge>}</td>
                        <td className="text-right tabular">{r.duration_seconds ? `${Math.floor(r.duration_seconds / 60)}:${String(r.duration_seconds % 60).padStart(2, "0")}` : "—"}</td>
                      </>}
                      <td className="text-right tabular">{fmtInt(r.views)}</td>
                      <td className="min-w-48 text-xs">
                        {r.errors.map((e, i) => <p key={i} className="text-error">{e.message}</p>)}
                        {r.warnings.map((w, i) => <p key={i} className="text-warning">{w}</p>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rows_truncated && <p className="p-3 text-center text-xs text-muted">Preview shows the first 1,000 rows.</p>}
            </TableScroll>
          </Card>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <button className="btn-secondary" onClick={() => { setPreview(null); setFile(null); }}>Upload a different file</button>
            <button className="btn-primary" onClick={start} disabled={starting || !preview.summary.valid}>
              {starting ? <Spinner /> : <Icon name="play" className="size-3.5 fill-current" />}
              {preview.batch.purpose === "dataset" ? "Analyse" : "Start processing"} {preview.summary.valid} video{preview.summary.valid === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
