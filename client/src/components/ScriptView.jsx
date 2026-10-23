// Screenplay document: paper pages in industry format — title page, cast page, numbered script pages with
// scene numbers in both margins, cue / parenthetical / dialogue columns, right-aligned transitions, beat sheet.
import { layoutScreenplay } from "../utils/screenplayPages.js";

/** Renders **bold** inline; everything else is plain text (never HTML). */
function Inline({ text }) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}

function BodyBlock({ b }) {
  switch (b.type) {
    case "scene":
      return (
        <h3 className="sp-heading" id={b.number != null ? `scene-${b.number}` : undefined}>
          {b.number != null && <span className="sp-scenenum left" aria-hidden="true">{b.number}</span>}
          {b.stamp && <span>[{b.stamp}] </span>}{b.setting}{b.time && <> — {b.time}</>}
          {b.number != null && <span className="sp-scenenum right" aria-hidden="true">{b.number}</span>}
        </h3>
      );
    case "dialogue":
      return (
        <div className="sp-dialogue">
          <p className="sp-cue">{b.name}{b.ext && ` (${b.ext})`}</p>
          {b.parts.map((p, i) => p.kind === "paren"
            ? <p key={i} className="sp-paren">{p.text}</p>
            : <p key={i} className="sp-line"><Inline text={p.text} /></p>)}
        </div>
      );
    case "transition":
      return <p className="sp-transition">{b.text}</p>;
    case "subheading":
      return <p className="sp-action" style={{ fontWeight: 700, textTransform: "uppercase" }}>{b.text}</p>;
    default:
      return <p className="sp-action"><Inline text={b.text || ""} /></p>;
  }
}

/**
 * meta: { title?, genre?, subgenre?, date?, credit? } — shown on the title page (the script's own title wins).
 */
export default function ScriptView({ text, meta = {} }) {
  const doc = layoutScreenplay(text);
  const title = doc.title || meta.title || "Untitled";
  const kind = [meta.genre, meta.subgenre].filter(Boolean).join(" · ");
  const date = meta.date ? new Date(meta.date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;

  return (
    <div className="sp-desk">
      <section className="sp-page sp-title-page" aria-label="Title page">
        <div className="sp-title-block">
          <p className="sp-title">{title}</p>
          {doc.episode && <p style={{ marginTop: "1.25em" }}>Episode {doc.episode}</p>}
          {kind && <p style={{ marginTop: "1em" }}>{kind}</p>}
          <p style={{ marginTop: "3em" }}>Written by</p>
          <p style={{ marginTop: "1em" }}>{meta.credit || "Scriptwriter skill"}</p>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1em", alignItems: "flex-end" }}>
          <p>{doc.note || "Standalone episode"}</p>
          {date && <p style={{ textAlign: "right" }}>Draft — {date}</p>}
        </div>
      </section>

      {doc.cast.map((page, i) => (
        <section key={`cast-${i}`} id={i === 0 ? "ref-characters" : undefined} className="sp-page" aria-label="Character references">
          <p className="sp-section-title">{i === 0 ? "Character references" : "Character references (cont'd)"}</p>
          {page.map((e, j) => (
            <div key={j} className="sp-ref">
              <p className="sp-ref-name">{e.name || "—"}</p>
              <p className="sp-ref-text"><Inline text={e.text || ""} /></p>
              {e.scenes?.length > 0 && <p className="sp-ref-meta">{e.scenes.length === 1 ? "Scene" : "Scenes"} {e.scenes.join(", ")}{e.times?.length ? ` · ${e.times.join(", ")}` : ""}</p>}
            </div>
          ))}
        </section>
      ))}

      {doc.locations.map((page, i) => (
        <section key={`loc-${i}`} id={i === 0 ? "ref-locations" : undefined} className="sp-page" aria-label="Location references">
          <p className="sp-section-title">{i === 0 ? "Location references" : "Location references (cont'd)"}</p>
          {i === 0 && doc.locationsDerived && <p className="sp-ref-meta" style={{ marginTop: "-0.75em", marginBottom: "1.5em" }}>Taken from the scene headings and each location's first description.</p>}
          {page.map((e, j) => (
            <div key={j} className="sp-ref">
              <p className="sp-ref-name">{e.name}</p>
              {e.text && <p className="sp-ref-text"><Inline text={e.text} /></p>}
              {e.scenes?.length > 0 && <p className="sp-ref-meta">{e.scenes.length === 1 ? "Scene" : "Scenes"} {e.scenes.join(", ")}{e.times?.length ? ` · ${e.times.join(", ")}` : ""}</p>}
            </div>
          ))}
        </section>
      ))}

      {doc.body.map((page, i) => (
        <section key={`p-${i}`} className="sp-page" aria-label={`Page ${i + 1} of ${doc.pageCount}`}>
          {i > 0 && <span className="sp-pagenum">{i + 1}.</span>}
          {page.map((b, j) => <BodyBlock key={j} b={b} />)}
        </section>
      ))}

      {doc.beats.map((page, i) => (
        <section key={`beats-${i}`} className="sp-page" aria-label="Beat sheet">
          <p className="sp-section-title">{i === 0 ? "Beat sheet" : "Beat sheet (cont'd)"}</p>
          {page.map((b, j) => (
            <p key={j} className="sp-beat">
              <span>{b.number ?? j + 1}.</span>
              <span>{b.scene && <>({b.scene}) </>}<Inline text={b.text} /></span>
            </p>
          ))}
        </section>
      ))}
    </div>
  );
}

export { layoutScreenplay };
