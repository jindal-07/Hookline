import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, downloads, downloadFile } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, PageSkeleton, ErrorState, Alert, Badge, StatusBadge, KeyValue, Spinner } from "../components/ui.jsx";
import { useToast, useConfirm, Menu } from "../components/controls.jsx";
import Icon from "../components/Icons.jsx";
import ScriptView from "../components/ScriptView.jsx";
import { fmtDate, secs, scriptStatus } from "../utils/format.js";

export default function ScriptDetail() {
  const { id } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: s, error, reload } = useApi(() => api.script(id), [id]);
  const refresh = useDebounced(() => reload({ silent: true }), 300);
  useEvents((e) => e.type === "script" && e.script_id === id && refresh());

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!s) return <PageSkeleton />;
  const busy = ["QUEUED", "RUNNING"].includes(s.status);
  const fmt = s.generation_metadata?.format;
  const pb = s.generation_metadata?.playbook;
  const act = async (fn, msg) => { try { await fn(); toast(msg, "success"); reload({ silent: true }); } catch (e) { toast(e.message, "error"); } };

  return (
    <>
      <PageHeader
        crumbs={[{ to: "/scripts", label: "Scripts" }]}
        title={<span className="flex flex-wrap items-center gap-x-3 gap-y-2"><span className="min-w-0 break-words">{s.title || `${s.brief.subgenre || s.brief.genre} episode`}</span><StatusBadge s={scriptStatus(s.status)} /></span>}
        subtitle={`${s.brief.genre}${s.brief.subgenre ? ` · ${s.brief.subgenre}` : ""} · ${secs(s.brief.target_duration_seconds)} · ${s.brief.language} · ${fmtDate(s.created_at)}`}
        actions={<>
          {!busy && <button className="btn-secondary" onClick={() => act(() => api.regenerateStandalone(id), "Rewriting — a new version will replace this one")}><Icon name="refresh" />Rewrite</button>}
          {s.content && <Menu label="Download" icon="download" items={[
            { label: "Word document (.docx)", icon: "file", onClick: () => downloadFile(downloads.scriptFile(id, "docx")).catch(e => toast(e.message, "error")) },
            { label: "PDF", icon: "file", onClick: () => downloadFile(downloads.scriptFile(id, "pdf")).catch(e => toast(e.message, "error")) },
          ]} />}
          {s.content && <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(s.content).then(() => toast("Copied", "success"))}><Icon name="copy" />Copy</button>}
          <button className="btn-ghost !text-error" onClick={async () => { if (await confirm({ title: "Delete this script?", body: "This can't be undone.", confirmLabel: "Delete", danger: true })) act(() => api.deleteScript(id).then(() => navigate("/scripts")), "Script deleted"); }}><Icon name="trash" />Delete</button>
        </>}
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid content-start gap-5">
          {busy && <Alert kind="info" title="Writing…">The skill is generating this episode. This page updates automatically.</Alert>}
          {s.status === "FAILED" && <Alert kind="error" title="Generation failed">{s.error_message}</Alert>}
          {s.status === "DISABLED" && <Alert kind="warning" title="No skill configured">Set SKILL_DIR and SKILL_MODE in .env, then rewrite.</Alert>}
          {s.status === "AWAITING_MANUAL" && (
            <Alert kind="warning" title="Run the skill in Claude Code">
              A job file was written to <code className="break-all">{s.generation_metadata?.exchange_file}</code>. In Claude Code, ask: <code className="break-words">Use the {s.generation_metadata?.skill_identifier?.replace(/^manual:/, "") || "scriptwriter-skill"} skill to write the script for the job in that file, following its requirements.</code> Then paste the script below.
            </Alert>
          )}
          {s.status === "REJECTED" && <Alert kind="error" title="Rejected by the originality check">The script is kept below for reference, but it reuses source material. Rewrite it or import an edited version.</Alert>}

          {s.content && (
            <Card bodyClass="p-5 sm:p-8">
              <ScriptView text={s.content} />
            </Card>
          )}
          {(s.status === "AWAITING_MANUAL" || s.status === "REJECTED" || s.content) && <ImportBox id={id} awaiting={s.status === "AWAITING_MANUAL"} onDone={() => reload({ silent: true })} />}
        </div>

        <div className="grid content-start gap-5">
          <Card title="Brief">
            <KeyValue items={[["Genre", s.brief.genre], ["Subgenre", s.brief.subgenre || "Any"], ["Length", secs(s.brief.target_duration_seconds)], ["Language", s.brief.language], s.brief.premise && ["Premise", s.brief.premise], s.brief.notes && ["Notes", s.brief.notes]]} />
          </Card>
          {s.originality && (
            <Card title="Originality check">
              <p className="flex items-center gap-2 font-bold"><Icon name={s.originality.passed ? "checkCircle" : "xCircle"} className={`size-4.5 ${s.originality.passed ? "text-success" : "text-error"}`} />{s.originality.passed ? "Passed" : "Failed"}</p>
              {s.originality.issues.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{s.originality.issues.map((x, i) => <li key={i}>{x.message}</li>)}</ul>}
              <p className="mt-2 text-xs text-muted">Checked against every training video's dialogue and character names. Longest shared run {s.originality.metrics.longest_shared_run} words · overlap {(s.originality.metrics.five_gram_overlap * 100).toFixed(1)}%.</p>
            </Card>
          )}
          {fmt && (
            <Card title="Format check" subtitle="Against the skill's output rules">
              <KeyValue items={[["Scenes", fmt.scene_count], ["Beat candidates", fmt.beat_candidates]]} />
              {fmt.warnings.length > 0 ? <ul className="mt-2 list-disc pl-5 text-sm text-warning">{fmt.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : <p className="mt-2 text-sm text-success">No issues found.</p>}
            </Card>
          )}
          {pb && (
            <Card title="Guidance used">
              {pb.evidence && <p className="text-sm text-muted">From {pb.evidence.videos} videos ({pb.evidence.best} best, {pb.evidence.bad} bad){pb.evidence.low_sample && " — few videos"}.</p>}
              <p className="label mb-1 mt-3 text-success">Use</p>
              <ul className="list-disc pl-5 text-sm">{pb.use_patterns.slice(0, 6).map((u, i) => <li key={i}>{u.replace(/\s\(.*$/, "")}</li>)}</ul>
              <p className="label mb-1 mt-3 text-error">Avoid</p>
              <ul className="list-disc pl-5 text-sm">{pb.avoid_patterns.slice(0, 6).map((u, i) => <li key={i}>{u.replace(/\s\(.*$/, "")}</li>)}</ul>
            </Card>
          )}
          <Card title="Generated by">
            <KeyValue items={[["Skill", s.skill_identifier || "—"], ["Version", s.skill_version || "—"], s.generation_metadata?.total_cost_usd && ["Cost", `$${s.generation_metadata.total_cost_usd.toFixed(2)}`], s.generation_metadata?.num_turns && ["Turns", s.generation_metadata.num_turns]]} />
            {s.status === "COMPLETED" && <Badge kind="ai" className="mt-3">AI-generated script</Badge>}
          </Card>
        </div>
      </div>
    </>
  );
}


function ImportBox({ id, awaiting, onDone }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try { const r = await api.importStandalone(id, text); toast(r.status === "COMPLETED" ? "Script imported and validated" : "Imported, but it failed the originality check", r.status === "COMPLETED" ? "success" : "warning"); setText(""); onDone(); }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <details className="card group p-4 sm:p-5" open={awaiting}>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-bold [&::-webkit-details-marker]:hidden"><Icon name="chevron" className="size-4 text-muted transition-transform group-open:rotate-180" />{awaiting ? "Paste the script from Claude Code" : "Replace with an edited version"}</summary>
      <p className="mt-2 text-sm text-muted">Imported scripts go through the same originality and format checks.</p>
      <textarea aria-label="Script markdown" className="input mt-3 min-h-56 font-mono text-[13px]" value={text} onChange={e => setText(e.target.value)} placeholder="# Episode 01: …" />
      <div className="mt-3 flex justify-end"><button className="btn-primary" disabled={!text.trim() || busy} onClick={submit}>{busy ? <Spinner /> : <Icon name="upload" />}Import</button></div>
    </details>
  );
}
