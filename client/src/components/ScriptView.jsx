// Screenplay reader: scene bars, full-width action, an indented dialogue column with the speaker's cue,
// parentheticals in italics, right-aligned transitions, a cast list and a beat timeline.
import { parseScript } from "@reelscript/shared/script";

/** Renders **bold** inline; everything else is plain text (never HTML). */
function Inline({ text }) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-bold text-fg">{part.slice(2, -2)}</strong> : part);
}

function Block({ b }) {
  switch (b.type) {
    case "title":
      return (
        <header className="mb-2">
          {b.episode && <p className="label mb-1">Episode {b.episode}</p>}
          <h2 className="text-2xl sm:text-3xl">{b.text}</h2>
        </header>
      );
    case "note":
      return <p className="surface-inset my-3 px-4 py-2.5 text-sm text-muted"><Inline text={b.text} /></p>;
    case "section":
      return <h3 className="label mb-3 mt-8 flex items-center gap-3 after:h-px after:flex-1 after:bg-border">{b.text}</h3>;
    case "subheading":
      return <h4 className="mb-1 mt-4 text-sm">{b.text}</h4>;
    case "scene":
      return (
        <div className="mb-4 mt-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-3 first:mt-0">
          {b.number != null && (
            <span className="grid h-7 shrink-0 place-items-center rounded-lg border border-[#c9a800] bg-[image:var(--mat-accent)] px-2.5 text-xs font-black tabular text-black shadow-[var(--key-accent)]">
              SCENE {b.number}
            </span>
          )}
          {b.stamp && <span className="badge border-border bg-sunken text-muted tabular">{b.stamp}</span>}
          <h3 className="min-w-0 flex-1 basis-48 text-[15px] font-black uppercase tracking-wide sm:text-base">{b.setting}</h3>
          {b.time && <span className="badge shrink-0 border-border bg-sunken uppercase tracking-wider text-muted">{b.time}</span>}
        </div>
      );
    case "action":
      return <p className="my-3 text-[15px] leading-relaxed text-fg/85"><Inline text={b.text} /></p>;
    case "dialogue":
      return (
        <div className="my-5 ml-3 mr-1 border-l-[3px] border-yellow/70 pl-4 sm:ml-[14%] sm:mr-[12%]">
          <p className="text-[13px] font-black uppercase tracking-[0.14em] text-fg">
            {b.name}{b.ext && <span className="ml-1.5 font-bold tracking-normal text-muted">({b.ext})</span>}
          </p>
          {b.parts.map((p, i) => p.kind === "paren"
            ? <p key={i} className="mt-0.5 text-sm italic text-muted">{p.text}</p>
            : <p key={i} className="mt-1 text-[15.5px] font-semibold leading-relaxed text-fg"><Inline text={p.text} /></p>)}
        </div>
      );
    case "transition":
      return <p className="my-6 text-right text-xs font-black uppercase tracking-[0.2em] text-muted">{b.text}</p>;
    case "bullet":
      return <p className="my-1 pl-4 text-[15px] before:mr-2 before:content-['•']"><Inline text={b.text} /></p>;
    case "numbered":
      return <p className="my-1 pl-4 text-[15px]"><Inline text={b.text} /></p>;
    default:
      return null;
  }
}

/** Groups consecutive cast entries and beats so they render as a list / timeline. */
function group(blocks) {
  const out = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if ((b.type === "cast" || b.type === "beat") && last?.type === `${b.type}-group`) last.items.push(b);
    else if (b.type === "cast" || b.type === "beat") out.push({ type: `${b.type}-group`, items: [b] });
    else out.push(b);
  }
  return out;
}

export default function ScriptView({ text }) {
  const blocks = group(parseScript(text));
  return (
    <article className="mx-auto max-w-3xl break-words">
      {blocks.map((b, i) => {
        if (b.type === "cast-group") return (
          <dl key={i} className="grid gap-2 sm:grid-cols-2">
            {b.items.map((c, j) => (
              <div key={j} className="surface-inset px-3.5 py-2.5">
                <dt className="text-sm font-black">{c.name}</dt>
                <dd className="text-[13px] leading-snug text-muted">{c.text}</dd>
              </div>
            ))}
          </dl>
        );
        if (b.type === "beat-group") return (
          <ol key={i} className="relative grid gap-3 border-l-2 border-border pl-6">
            {b.items.map((x, j) => (
              <li key={j} className="relative text-sm">
                <span className="absolute -left-[37px] grid size-6 place-items-center rounded-full border border-[#c9a800] bg-[image:var(--mat-accent)] text-[11px] font-black text-black shadow-[var(--key-accent)]">{x.number}</span>
                {x.scene && <span className="badge mr-2 border-border bg-sunken text-muted">{x.scene}</span>}
                <span className="font-semibold"><Inline text={x.text} /></span>
              </li>
            ))}
          </ol>
        );
        return <Block key={i} b={b} />;
      })}
    </article>
  );
}
