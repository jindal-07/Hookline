import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, downloads, downloadFile } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, PageSkeleton, ErrorState, Empty, Alert, Badge, StatusBadge, ScoreBar, Tabs, KeyValue, Spinner, InsetPanel } from "../components/ui.jsx";
import { useToast, useConfirm, Tooltip } from "../components/controls.jsx";
import Icon from "../components/Icons.jsx";
import ScriptView from "../components/ScriptView.jsx";
import { videoStatus, matchStatus, generationStatus, taskStatus, fmtScore, fmtConf, fmtTime, fmtInt, fmtDate, fmtMs, titleCase, REASON_TEXT, fmtMeta } from "../utils/format.js";

export default function VideoDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState("match");
  const toast = useToast();
  const { data, error, reload } = useApi(() => api.video(id), [id]);
  const settings = useApi(() => api.settings());
  const refresh = useDebounced(() => reload({ silent: true }), 500);
  useEvents((e) => (e.video_id === id || e.type === "resync") && refresh());

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;
  const { video: v, batch, transcript, analysis, match, storyDna, script, logs } = data;
  const threshold = match?.scoring_configuration?.threshold ?? settings.data?.scoring.matchThreshold ?? 75;
  const act = async (fn, msg) => { try { const r = await fn(); toast(msg(r), "success"); refresh(); } catch (e) { toast(e.message, "error"); } };
  const canRetry = ["FAILED", "CANCELLED", "INCONCLUSIVE", "SKIPPED_LOW_SCORE"].includes(v.status);

  const tabs = [
    { value: "match", label: "Matching evidence" },
    { value: "transcript", label: "Transcript", count: transcript ? transcript.normalized_transcript.dialogue_segments.length + transcript.normalized_transcript.narration_segments.length : undefined },
    { value: "screenplay", label: "Screenplay", count: analysis?.normalized_analysis.scenes.length },
    { value: "characters", label: "Characters", count: analysis?.normalized_analysis.characters.length },
    { value: "dna", label: "Story DNA" },
    { value: "script", label: "Script" },
    { value: "history", label: "History", count: logs.length },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ to: "/batches", label: "Batches" }, { to: `/batches/${v.batch_id}`, label: `${batch?.filename || "Batch"} · row ${v.source_row_number}` }]}
        title={<span className="break-words">{v.title || "Untitled video"}</span>}
        subtitle={<a href={v.video_url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 hover:underline"><span className="min-w-0 break-all">{v.video_url}</span><Icon name="external" className="size-3.5 shrink-0" /></a>}
        actions={<>
          {canRetry && <button className="btn-secondary" onClick={() => act(() => api.retry(id), r => `Retrying from ${r.stages.join(" + ")}`)}><Icon name="refresh" />Retry</button>}
          {match?.eligible && storyDna && <button className="btn-secondary" onClick={() => act(() => api.regenerate(id), () => "Script regeneration queued")}><Icon name="sparkles" />Regenerate script</button>}
          <button className="btn-secondary" onClick={() => downloadFile(downloads.videoJson(id)).catch(e => toast(e.message, "error"))}><Icon name="download" />JSON</button>
        </>}
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="grid content-start gap-5">
          <Card title="Status">
            <div className="flex flex-wrap gap-2"><StatusBadge s={videoStatus(v.status)} />{match && <StatusBadge s={matchStatus(match.match_status)} />}</div>
            <div className="mt-4"><KeyValue items={[
              ["Transcription", <StatusBadge key="t" s={taskStatus(v.transcript_status)} />],
              ["Video analysis", <StatusBadge key="a" s={taskStatus(v.analysis_status)} />],
              ["Script", v.generation_status === "COMPLETED" ? <Badge key="g" kind="ai">AI-generated script</Badge> : <StatusBadge key="g" s={generationStatus(v.generation_status)} />],
            ]} /></div>
            {v.status === "FAILED" && <div className="mt-4"><Alert kind="error" title={`Failed at ${v.error_stage || v.current_stage || "a stage"} · ${v.error_code}`}>{v.error_message}</Alert></div>}
          </Card>

          <ScorePanel match={match} threshold={threshold} />

          <Card title="Provided metadata">
            <KeyValue items={[["Category", v.category], ["Views", fmtInt(v.views)], ["Likes", fmtInt(v.likes)], ["Shares", fmtInt(v.shares)], ["Comments", fmtInt(v.comments)], ["Normalised URL", <span key="u" className="mono text-xs">{v.normalized_url}</span>]]} />
            {v.sheet_metadata?.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">From your sheet</p>
                <KeyValue items={v.sheet_metadata.map(e => [e.label, <span key={e.label} className="whitespace-pre-wrap break-words">{fmtMeta(e.type, e.value)}</span>])} />
              </div>
            )}
          </Card>
        </div>

        <Card bodyClass="p-0">
          <div className="border-b border-border p-3"><Tabs tabs={tabs} value={tab} onChange={setTab} label="Video details" /></div>
          <div key={tab} className="anim-fade p-4 sm:p-5" role="tabpanel" aria-label={tabs.find(t => t.value === tab)?.label}>
            {tab === "match" && <MatchTab match={match} />}
            {tab === "transcript" && <TranscriptTab transcript={transcript} />}
            {tab === "screenplay" && <ScreenplayTab analysis={analysis} sheet={v.media_metadata?.sheet?.fields} />}
            {tab === "characters" && <CharactersTab analysis={analysis} match={match} />}
            {tab === "dna" && <DnaTab storyDna={storyDna} match={match} />}
            {tab === "script" && <ScriptTab video={v} script={script} history={data.scriptHistory} match={match} onImported={refresh} />}
            {tab === "history" && <HistoryTab logs={logs} />}
          </div>
        </Card>
      </div>
    </>
  );
}

function ScorePanel({ match: m, threshold }) {
  if (!m) return <Card title="Match score"><p className="text-sm text-muted">Scores appear once transcription and video analysis are both complete.</p></Card>;
  const w = m.scoring_configuration?.weights || {};
  const reasons = m.evidence?.inconclusive_reasons || [];
  return (
    <Card title="Match score" subtitle={`Scoring v${m.scoring_version} · threshold ${threshold} · min. confidence ${m.scoring_configuration?.min_match_confidence}`}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <span className={`text-5xl font-black tabular ${m.overall_score === null ? "text-muted" : m.overall_score >= threshold ? "text-success" : m.overall_score >= threshold - 15 ? "text-warning" : "text-error"}`}>{fmtScore(m.overall_score)}</span>
        <span className="pb-1.5 text-sm text-muted">/ 100 overall</span>
        <Tooltip label="Confidence measures evidence quality (transcription, speech amount, diarization, embeddings) — not similarity">
          <span className="ml-auto pb-1.5 text-right"><span className="block label">Confidence</span><span className={`text-xl font-black tabular ${m.confidence >= (m.scoring_configuration?.min_match_confidence ?? 0.7) ? "" : "text-warning"}`}>{fmtConf(m.confidence)}</span></span>
        </Tooltip>
      </div>
      <div className="mt-5 grid gap-4">
        <ScoreBar label="Story & event sequence" score={m.story_score} threshold={threshold} weight={w.story} />
        <ScoreBar label="Characters & relationships" score={m.character_score} threshold={threshold} weight={w.character} />
        <ScoreBar label="Dialogue meaning & intent" score={m.dialogue_score} threshold={threshold} weight={w.dialogue} />
      </div>
      {reasons.length > 0 && <div className="mt-4"><Alert kind="warning" title="Inconclusive — flagged for review">{reasons.map(r => REASON_TEXT[r] || r).join(" · ")}</Alert></div>}
      <p className="mt-4 text-sm leading-relaxed text-muted">{m.reasoning}</p>
      {m.scoring_configuration?.embedding && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <Icon name="info" className="size-3.5" />
          Embeddings: {m.scoring_configuration.embedding.provider} / {m.scoring_configuration.embedding.model}
          {!m.scoring_configuration.embedding.semantic && <Badge kind="warning" className="ml-1">lexical fallback</Badge>}
        </p>
      )}
    </Card>
  );
}

function EvidenceItem({ e, tone }) {
  const border = { success: "border-l-success-solid", error: "border-l-error-solid", warning: "border-l-warning-solid" }[tone];
  return (
    <li className={`surface-inset !rounded-xl border-l-4 ${border} p-3 text-sm`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{titleCase(e.type)}</span>
        {e.element && <Badge kind="neutral">{titleCase(e.element)}</Badge>}
        {e.intent && <Badge kind="neutral">{e.intent}</Badge>}
        {e.is_reveal && <Badge kind="info">reveal</Badge>}
        {e.timestamp !== undefined && <span className="text-xs tabular text-muted">@ {fmtTime(e.timestamp)}</span>}
        {e.agreement !== undefined && <span className="ml-auto text-xs font-bold tabular text-muted">agreement {e.agreement}</span>}
        {e.mapping_confidence !== undefined && <span className="ml-auto text-xs font-bold tabular text-muted">mapping {e.mapping_confidence}</span>}
      </div>
      {e.text && <p className="mt-1.5 break-words"><span className="label mr-1.5">Screenplay</span>{e.text}</p>}
      {e.transcript_text && <p className="mt-1 break-words"><span className="label mr-1.5">Transcript</span><span lang="">{e.transcript_text}</span>{e.transcript_time !== undefined && <span className="ml-1 text-xs text-muted">({fmtTime(e.transcript_time)})</span>}</p>}
      {e.speaker_id && <p className="mt-1">{e.speaker_id} → <b>{e.label || e.character_id}</b></p>}
      {e.label && !e.speaker_id && e.role && <p className="mt-1"><b>{e.label}</b> — {e.role}</p>}
      {e.note && <p className="mt-1 text-muted">{e.note}</p>}
    </li>
  );
}

function MatchTab({ match: m }) {
  if (!m) return <Empty icon="dashboard" title="Not scored yet">Matching runs after transcription and video analysis both finish.</Empty>;
  const ev = m.evidence || {};
  const sections = [
    { key: "mismatches", title: "Contradictions", items: ev.mismatches || [], tone: "error" },
    { key: "story", title: "Story matches", items: ev.story_matches || [], tone: "success" },
    { key: "character", title: "Character matches", items: ev.character_matches || [], tone: "success" },
    { key: "dialogue", title: "Dialogue matches", items: ev.dialogue_matches || [], tone: "success" },
    { key: "uncertain", title: "Uncertain / not scored", items: ev.uncertain_elements || [], tone: "warning" },
  ];
  const comp = ev.components || {};
  const factors = ev.confidence_factors || {};
  return (
    <div className="grid gap-6">
      <div className="grid gap-3 md:grid-cols-3">
        {[["Story", comp.story], ["Characters", comp.character], ["Dialogue", comp.dialogue]].map(([k, c]) => (
          <InsetPanel key={k} title={`${k} components`}>
            <KeyValue items={Object.entries(c || {}).map(([n, val]) => [titleCase(n), val === null ? <span className="font-normal text-muted" title="Not evaluable for this video">n/a</span> : val])} />
          </InsetPanel>
        ))}
      </div>
      {Object.keys(factors).length > 0 && (
        <InsetPanel title="Confidence factors (evidence quality)">
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(factors).map(([k, val]) => (
              <div key={k} className="text-sm"><span className="text-muted">{titleCase(k)}</span> <b className={`tabular ${val < 0.6 ? "text-warning" : ""}`}>{val}</b></div>
            ))}
          </div>
        </InsetPanel>
      )}
      {sections.map(s => s.items.length > 0 && (
        <section key={s.key}>
          <h3 className="mb-2 flex items-center gap-2 text-sm"><Badge kind={s.tone}>{s.items.length}</Badge>{s.title}</h3>
          <ul className="grid gap-2">{s.items.map((e, i) => <EvidenceItem key={i} e={e} tone={s.tone} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function TranscriptTab({ transcript }) {
  if (!transcript) return <Empty icon="file" title="No transcript yet" />;
  const t = transcript.normalized_transcript;
  const segs = [...t.dialogue_segments, ...t.narration_segments, ...t.uncertain_segments].sort((a, b) => a.start_time - b.start_time);
  const important = new Map(t.important_statements.map(s => [s.segment_id, s.reason]));
  const speakerColor = (id) => ["text-info", "text-ai", "text-success", "text-warning", "text-error"][[...new Set(segs.map(s => s.speaker_id))].indexOf(id) % 5];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge kind="neutral">Language: {t.language}{t.language_confidence !== null && ` (${t.language_confidence})`}</Badge>
        <Badge kind="neutral">{t.speakers.length} speaker{t.speakers.length === 1 ? "" : "s"}</Badge>
        <Badge kind="neutral">{t.stats.word_count} words</Badge>
        <Badge kind={t.stats.mean_confidence !== null && t.stats.mean_confidence < 0.7 ? "warning" : "neutral"}>Mean confidence {fmtConf(t.stats.mean_confidence)}</Badge>
        <Badge kind="neutral">Speech {Math.round(t.stats.speech_ratio * 100)}% of video</Badge>
        {!t.diarized && <Badge kind="warning">No speaker diarization</Badge>}
        {transcript.provider_metadata?.reused_from && <Badge kind="info">Reused from an earlier batch</Badge>}
      </div>
      <p className="text-xs text-muted">Original language and wording — not translated. Speaker labels are identifiers, not character identities.</p>
      {!segs.length ? <Empty icon="file" title="No speech detected" /> : (
        <ol className="surface-inset divide-y divide-border overflow-hidden">
          {segs.map(s => (
            <li key={s.segment_id} className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm sm:grid-cols-[56px_96px_minmax(0,1fr)] ${s.kind === "uncertain" ? "bg-warning-bg" : ""}`}>
              <span className="tabular text-xs text-muted">{fmtTime(s.start_time)}</span>
              <span className={`text-xs font-bold ${speakerColor(s.speaker_id)}`}>{s.speaker_id.replace("SPEAKER_", "Speaker ")}</span>
              <div className="col-span-2 min-w-0 break-words sm:col-span-1">
                <p>{s.text}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {s.kind !== "dialogue" && <Badge kind={s.kind === "uncertain" ? "warning" : "neutral"}>{s.kind}</Badge>}
                  {important.has(s.segment_id) && <Badge kind="info">{important.get(s.segment_id)}</Badge>}
                  {s.confidence !== null && <span className="text-xs tabular text-muted">conf {s.confidence}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {t.repeated_phrases.length > 0 && <div><p className="label mb-2">Repeated phrases</p><div className="flex flex-wrap gap-1.5">{t.repeated_phrases.map(p => <Badge key={p.phrase} kind="neutral">{p.phrase} ×{p.count}</Badge>)}</div></div>}
    </div>
  );
}

/** Gemini's value, plus the sheet's when it differs (the dataset uses the sheet's). */
function withSheet(detected, fromSheet) {
  if (!fromSheet || String(fromSheet).toLowerCase() === String(detected || "").toLowerCase()) return detected;
  return <span key="s">{detected || "—"} <span className="font-normal text-muted">· your sheet: {fromSheet}</span></span>;
}

function ScreenplayTab({ analysis, sheet = {} }) {
  if (!analysis) return <Empty icon="film" title="No screenplay analysis yet" />;
  const a = analysis.normalized_analysis;
  const vs = a.visual_storytelling;
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <InsetPanel title="Metadata"><KeyValue items={[["Duration", fmtTime(a.metadata.duration_seconds)], ["Language", a.metadata.primary_language], ["Genre", withSheet(a.metadata.genre, sheet.genre)], ["Subgenre", withSheet(a.metadata.subgenre, sheet.subgenre)], ["Setting", a.metadata.setting], ["Tone", a.metadata.tone], ["Visual style", a.metadata.visual_style], ["Format", a.metadata.narrative_format]]} /></InsetPanel>
        <InsetPanel title="Hook"><KeyValue items={[["Opening visual", a.hook.opening_visual], ["First seconds", a.hook.first_seconds], ["Attention element", a.hook.attention_element], ["Curiosity mechanism", a.hook.curiosity_mechanism], ["Initial question", a.hook.initial_question]]} /></InsetPanel>
      </div>

      <section>
        <h3 className="mb-2 text-sm">Story structure</h3>
        <div className="flex flex-wrap gap-2">
          {a.story_structure.map(e => (
            <Tooltip key={e.element} label={e.description || "—"}>
              <Badge kind={e.status === "present" ? "success" : e.status === "uncertain" ? "warning" : "neutral"}>{titleCase(e.element)}{e.status !== "present" && ` · ${e.status}`}</Badge>
            </Tooltip>
          ))}
        </div>
        <p className="mt-3 text-sm"><span className="label mr-2">Emotional arc</span>{a.emotional_arc.stages.join(" → ")}</p>
      </section>

      <section>
        <h3 className="mb-2 text-sm">Scenes</h3>
        <ol className="grid gap-2">
          {a.scenes.map(s => (
            <li key={s.scene_id} className="surface-inset p-3.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-black">{s.scene_id.replace("_", " ")}</span>
                <span className="tabular text-xs text-muted">{fmtTime(s.start_time)}–{fmtTime(s.end_time)}{s.boundary_certainty === "approximate" && " (approx.)"}</span>
                <Badge kind="neutral">{s.story_beat}</Badge>
                <span className="text-xs text-muted">{s.location}</span>
              </div>
              <p className="mt-1.5 break-words">{s.visual_description}</p>
              {s.dialogue_summary && <p className="mt-1 text-muted"><span className="label mr-1.5">Dialogue</span>{s.dialogue_summary}</p>}
              <p className="mt-1 text-xs text-muted">{[s.emotional_state && `Emotion: ${s.emotional_state}`, s.conflict && `Conflict: ${s.conflict}`, s.narrative_purpose && `Purpose: ${s.narrative_purpose}`].filter(Boolean).join(" · ")}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3 className="mb-2 text-sm">Narrative beats</h3>
        <ol className="relative grid gap-2 border-l-2 border-border pl-4">
          {a.narrative_beats.map(b => (
            <li key={b.beat_id} className="text-sm">
              <span className="absolute -left-[6px] mt-1.5 size-2.5 rounded-full border border-[#c9a800] bg-yellow shadow-[0_0_6px_rgba(255,214,0,0.6)]" aria-hidden="true" />
              <span className="tabular text-xs text-muted">{fmtTime(b.timestamp)}</span> <b>{b.description}</b>
              <span className="text-muted"> — {b.emotional_impact}; {b.narrative_purpose}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3 className="mb-2 text-sm">Visual storytelling</h3>
        <p className="mb-2 flex gap-3 text-xs text-muted"><span className="flex items-center gap-1"><Icon name="checkCircle" className="size-3.5 text-success" />observed</span><span className="flex items-center gap-1"><Icon name="info" className="size-3.5 text-info" />interpreted</span></p>
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries(vs).filter(([, items]) => items.length).map(([k, items]) => (
            <InsetPanel key={k} title={titleCase(k)}>
              <ul className="grid gap-1 text-sm">{items.map((d, i) => (
                <li key={i} className="flex gap-1.5"><Icon name={d.basis === "observed" ? "checkCircle" : "info"} className={`mt-0.5 size-3.5 shrink-0 ${d.basis === "observed" ? "text-success" : "text-info"}`} title={d.basis} />{d.detail}{d.timestamp !== undefined && <span className="text-xs text-muted">({fmtTime(d.timestamp)})</span>}</li>
              ))}</ul>
            </InsetPanel>
          ))}
        </div>
      </section>
      <p className="text-xs text-muted">Model: {analysis.model_metadata?.provider} / {analysis.model_metadata?.model}{analysis.model_metadata?.attempts > 1 && ` · ${analysis.model_metadata.attempts} attempts`}{analysis.model_metadata?.repairs?.length ? ` · ${analysis.model_metadata.repairs.length} automatic repairs` : ""}</p>
    </div>
  );
}

function CharactersTab({ analysis, match }) {
  if (!analysis) return <Empty icon="user" title="No characters yet" />;
  const a = analysis.normalized_analysis;
  const byId = Object.fromEntries(a.characters.map(c => [c.character_id, c]));
  const mapping = (match?.evidence?.character_matches || []).filter(m => m.type === "speaker_mapping");
  return (
    <div className="grid gap-4">
      {mapping.length > 0 && (
        <InsetPanel title="Speaker → character mapping (from matching)">
          <div className="flex flex-wrap gap-2">{mapping.map(m => <Badge key={m.speaker_id} kind={m.mapping_confidence >= 0.7 ? "success" : "warning"}>{m.speaker_id.replace("SPEAKER_", "Speaker ")} → {m.label} ({m.mapping_confidence})</Badge>)}</div>
        </InsetPanel>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {a.characters.map(c => (
          <div key={c.character_id} className="surface-inset p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-black bg-[linear-gradient(180deg,#2a2a2a,#111)] text-lg font-black text-yellow shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_2px_4px_rgba(0,0,0,0.3)]">{c.label.trim()[0]}</span>
              <div className="min-w-0"><p className="font-black">{c.label}</p><p className="text-xs text-muted">{c.role}{c.age_range && ` · ${c.age_range}`}</p></div>
            </div>
            {c.appearance && <p className="mt-2 text-sm text-muted">{c.appearance}</p>}
            <div className="mt-2"><KeyValue items={[
              ["Motivation", c.motivation],
              c.traits.length && ["Traits", c.traits.join(", ")],
              c.relationships.length && ["Relationships", c.relationships.map(r => `${r.relationship} of ${byId[r.character_id]?.label || r.character_id}`).join("; ")],
              c.key_actions.length && ["Key actions", c.key_actions.join("; ")],
              c.emotional_progression && ["Emotional arc", c.emotional_progression],
            ]} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DnaTab({ storyDna, match }) {
  if (!storyDna) return <Empty icon="dna" title="No Story DNA">{match ? "Story DNA is derived only for videos whose match is approved (MATCHED)." : "Available after matching."}</Empty>;
  const d = storyDna.story_dna;
  return (
    <div className="grid gap-4">
      <Alert kind="info">A structural abstraction of the source — narrative mechanics only, with names and distinctive lines removed. This is what the script skill receives.</Alert>
      <div className="grid gap-4 md:grid-cols-2">
        <InsetPanel><KeyValue items={[["Hook pattern", d.hook_pattern], ["Core conflict", d.core_conflict], ["Pacing", d.pacing], ["Ending", d.ending_type], ["Format", `${d.format.duration_seconds}s · ${d.format.scene_count} scenes · ${d.format.genre} · ${d.format.language}`]]} /></InsetPanel>
        <InsetPanel>
          <p className="label mb-1.5">Emotional arc</p><p className="text-sm font-semibold">{d.emotional_arc.join(" → ")}</p>
          <p className="label mb-1.5 mt-3">Character archetypes</p><div className="flex flex-wrap gap-1.5">{d.character_archetypes.map(a => <Badge key={a} kind="neutral">{a}</Badge>)}</div>
        </InsetPanel>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <InsetPanel title="Story engine"><ol className="list-decimal space-y-1 pl-5 text-sm">{d.story_engine.map((s, i) => <li key={i}>{s}</li>)}</ol></InsetPanel>
        <InsetPanel title="Dialogue functions"><ul className="list-disc space-y-1 pl-5 text-sm">{d.dialogue_functions.map((s, i) => <li key={i}>{s}</li>)}</ul></InsetPanel>
      </div>
      {d.avoid?.length > 0 && <div className="rounded-xl border border-error-border bg-error-bg p-4"><p className="label mb-2 text-error">Must not be reused</p><ul className="list-disc space-y-0.5 pl-5 text-sm">{d.avoid.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
    </div>
  );
}

function ScriptTab({ video, script, history, match, onImported }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const awaiting = video.generation_status === "AWAITING_MANUAL";
  const submit = async () => {
    if (script?.generation_status === "COMPLETED" && !(await confirm({ title: "Replace the current script?", body: "The imported script becomes the latest version. Earlier versions stay in the history.", confirmLabel: "Import" }))) return;
    setBusy(true);
    try { const r = await api.importScript(video.id, text); toast(r.generation_status === "COMPLETED" ? "Script imported and validated" : "Imported, but it failed the originality checks", r.generation_status === "COMPLETED" ? "success" : "warning"); setText(""); onImported(); }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  };
  const orig = script?.generation_metadata?.originality;
  return (
    <div className="grid gap-5">
      {!match?.eligible && <Alert kind="neutral">Scripts are generated only for videos whose match is approved (score ≥ threshold with sufficient confidence).</Alert>}
      {video.generation_status === "DISABLED" && <Alert kind="warning" title="No Claude Skill configured">Set SKILL_MODE=agent-sdk (with SKILL_DIR) or SKILL_MODE=manual, then use “Regenerate script”.</Alert>}
      {awaiting && <Alert kind="warning" title="Waiting for a manually generated script">A job file was exported for the configured skill. Run it in Claude Code, then paste the result below.</Alert>}
      {script?.script_content ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {script.generation_status === "COMPLETED" ? <Badge kind="ai">AI-generated script</Badge> : <StatusBadge s={generationStatus(script.generation_status)} />}
            <span className="text-xs text-muted">{script.skill_identifier}{script.skill_version && ` v${script.skill_version}`} · {fmtDate(script.created_at)}</span>
            <button className="btn-secondary btn-sm ml-auto" onClick={() => navigator.clipboard.writeText(script.script_content).then(() => toast("Copied", "success"))}>Copy</button>
          </div>
          <div className="surface-inset max-h-[720px] overflow-auto bg-[linear-gradient(180deg,#d9d7d0,#cfcdc5)] p-2 sm:p-5 dark:bg-[linear-gradient(180deg,#121212,#0c0c0c)]"><ScriptView text={script.script_content} meta={{ title: video.title }} /></div>
        </div>
      ) : match?.eligible && !awaiting && <Empty icon="sparkles" title="No script yet" />}

      {orig && (
        <div className={`rounded-xl border p-4 ${orig.passed ? "border-success-border bg-success-bg" : "border-error-border bg-error-bg"}`}>
          <p className="flex items-center gap-2 font-bold"><Icon name={orig.passed ? "checkCircle" : "xCircle"} className={`size-4.5 ${orig.passed ? "text-success" : "text-error"}`} />Originality check {orig.passed ? "passed" : "failed"}</p>
          {orig.issues.length > 0 && <ul className="mt-1.5 list-disc pl-6 text-sm">{orig.issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>}
          <p className="mt-2 text-xs text-muted">Longest shared run {orig.metrics.longest_shared_run} words · 5-gram overlap {(orig.metrics.five_gram_overlap * 100).toFixed(1)}%{orig.metrics.paraphrase_share !== null && ` · scene paraphrase ${(orig.metrics.paraphrase_share * 100).toFixed(0)}%`}</p>
        </div>
      )}

      {match?.eligible && (
        <details className="surface-inset group p-4" open={awaiting}>
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-bold [&::-webkit-details-marker]:hidden"><Icon name="chevron" className="size-4 text-muted transition-transform group-open:rotate-180" />Import a script generated in Claude Code</summary>
          <p className="mt-2 text-sm text-muted">The imported script is validated with the same originality rules.</p>
          <label className="mt-3 block"><span className="sr-only">Script</span>
            <textarea className="input min-h-48 font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the finished script…" />
          </label>
          <div className="mt-2 flex justify-end"><button className="btn-primary" disabled={!text.trim() || busy} onClick={submit}>{busy ? <Spinner /> : <Icon name="upload" />}Import script</button></div>
        </details>
      )}

      {history?.length > 1 && (
        <div><p className="label mb-2">Versions</p>
          <ul className="grid gap-1.5 text-sm">{history.map(h => <li key={h.id} className="flex flex-wrap items-center gap-2"><StatusBadge s={generationStatus(h.generation_status)} /><span className="text-muted">{h.skill_identifier} · {fmtDate(h.created_at)}</span></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function HistoryTab({ logs }) {
  if (!logs.length) return <Empty icon="clock" title="No processing history yet" />;
  const tone = (s) => ({ SUCCEEDED: "success", FAILED: "error", ATTEMPT_FAILED: "warning", CANCELLED: "neutral", QUEUED: "info", IMPORTED: "success" }[s] || "neutral");
  return (
    <ol className="grid gap-2">
      {logs.map(l => (
        <li key={l.id} className="surface-inset grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 !rounded-xl px-3.5 py-2.5 text-sm md:grid-cols-[150px_110px_minmax(0,1fr)]">
          <span className="text-xs tabular text-muted">{fmtDate(l.created_at)}</span>
          <span className="font-bold capitalize md:order-none">{l.stage}</span>
          <div className="col-span-2 min-w-0 md:col-span-1">
            <div className="flex flex-wrap items-center gap-2"><Badge kind={tone(l.status)}>{titleCase(l.status)}</Badge>{l.attempt && <span className="text-xs text-muted">attempt {l.attempt}</span>}{l.duration_ms !== null && <span className="text-xs tabular text-muted">{fmtMs(l.duration_ms)}</span>}</div>
            {l.error_details && <p className="mt-1 text-xs text-error">{l.error_details.code}: {l.error_details.message}</p>}
            {Object.keys(l.metadata || {}).length > 0 && <p className="mt-1 truncate text-xs text-muted" title={JSON.stringify(l.metadata)}>{Object.entries(l.metadata).filter(([, v]) => v !== null && typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
