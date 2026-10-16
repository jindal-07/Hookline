// Surfaces, data display and feedback. Status is never conveyed by colour alone: icon + label always.
import { useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icons.jsx";

const ICONS = { success: "checkCircle", error: "xCircle", warning: "alert", info: "info", ai: "sparkles", neutral: "minusCircle" };
const TONE = {
  success: "text-success bg-success-bg border-success-border",
  error: "text-error bg-error-bg border-error-border",
  warning: "text-warning bg-warning-bg border-warning-border",
  info: "text-info bg-info-bg border-info-border",
  ai: "text-ai bg-ai-bg border-ai-border",
  neutral: "text-neutral bg-neutral-bg border-neutral-border",
};
export const TONE_TEXT = { success: "text-success", error: "text-error", warning: "text-warning", info: "text-info", ai: "text-ai", neutral: "text-muted" };

export function Spinner({ className = "size-3.5" }) {
  return <span className={`${className} inline-block animate-spin rounded-full border-2 border-current border-r-transparent`} aria-hidden="true" />;
}

export function Badge({ kind = "neutral", icon, spinning, children, className = "" }) {
  return (
    <span className={`badge ${TONE[kind]} ${className}`}>
      {spinning ? <Spinner className="size-3 shrink-0" /> : <Icon name={icon || ICONS[kind]} className="size-3.5 shrink-0" />}
      <span>{children}</span>
    </span>
  );
}

/** Badge from a {kind,label,spinning} descriptor (see utils/format.js). */
export const StatusBadge = ({ s }) => <Badge kind={s.kind} spinning={s.spinning}>{s.label}</Badge>;

export function Alert({ kind = "info", title, children, action }) {
  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-2xl border p-4 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] ${TONE[kind]}`} role={kind === "error" ? "alert" : "status"}>
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface/60 shadow-[var(--key)]"><Icon name={ICONS[kind]} className="size-4.5" /></span>
      <div className="min-w-0 flex-1 basis-48 self-center text-fg">
        {title && <p className={`font-bold ${TONE_TEXT[kind]}`}>{title}</p>}
        {children && <div className="text-muted">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Elevated card. Header is optional; `action` sits at the top right and wraps under the title on narrow screens. */
export function Card({ title, subtitle, action, children, className = "", bodyClass = "p-4 sm:p-5", as: Tag = "section" }) {
  return (
    <Tag className={`card min-w-0 ${className}`}>
      {(title || action) && <SectionHeader title={title} subtitle={subtitle} action={action} className="border-b border-border px-4 py-3.5 sm:px-5" />}
      <div className={bodyClass}>{children}</div>
    </Tag>
  );
}
export const ElevatedCard = Card;

export function SectionHeader({ title, subtitle, action, className = "", level = 2 }) {
  const H = `h${level}`;
  return (
    <header className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 ${className}`}>
      <div className="min-w-0 flex-1 basis-56">
        {title && <H className="text-base">{title}</H>}
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex min-w-0 flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

/** Recessed panel for grouped secondary content inside a card. */
export function InsetPanel({ title, children, className = "", tone }) {
  const toneCls = tone ? `${TONE[tone]} !shadow-none` : "";
  return (
    <div className={`surface-inset min-w-0 p-4 ${toneCls} ${className}`}>
      {title && <p className={`label mb-2 ${tone ? TONE_TEXT[tone] : ""}`}>{title}</p>}
      {children}
    </div>
  );
}

export function MetricCard({ label, value, hint, tone, icon }) {
  const toneText = tone ? TONE_TEXT[tone] : "text-fg";
  return (
    <div className="card min-w-0 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="label min-w-0">{label}</span>
        {icon && (
          <span className={`grid size-8 shrink-0 place-items-center rounded-xl border border-border bg-[image:var(--mat-key)] shadow-[var(--key)] ${tone ? toneText : "text-muted"}`}>
            <Icon name={icon} className="size-4" />
          </span>
        )}
      </div>
      <p className={`mt-1 truncate text-2xl font-black tabular sm:text-3xl ${toneText}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted" title={typeof hint === "string" ? hint : undefined}>{hint}</p>}
    </div>
  );
}
export const StatTile = MetricCard;

/** Horizontal meter for a 0–100 score with the threshold marked. */
export function ScoreBar({ label, score, threshold, weight }) {
  const has = score !== null && score !== undefined;
  const pct = has ? Math.max(0, Math.min(100, score)) : 0;
  const tone = !has ? "bg-border-strong" : score >= threshold ? "bg-success-solid" : score >= threshold - 15 ? "bg-warning-solid" : "bg-error-solid";
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 font-bold">{label}{weight !== undefined && <span className="ml-1.5 text-xs font-semibold text-muted">{weight}%</span>}</span>
        <span className="font-black tabular">{has ? Math.round(score) : "—"}<span className="text-xs font-semibold text-muted">/100</span></span>
      </div>
      <Meter pct={pct} className={tone} label={label} value={has ? score : undefined} marker={threshold} />
    </div>
  );
}

function Meter({ pct, className, label, value, marker }) {
  return (
    <div className="relative h-3 rounded-full border border-border bg-[image:var(--mat-well)] shadow-[var(--well)]" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className={`anim-grow-x absolute inset-y-0.5 left-0.5 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] ${className}`} style={{ width: `max(0px, calc(${pct}% - 4px))` }} />
      {marker !== undefined && <span className="absolute -top-1 h-5 w-1 -translate-x-1/2 rounded-full border border-surface bg-fg" style={{ left: `${marker}%` }} title={`Threshold ${marker}`} />}
    </div>
  );
}

export function ProgressBar({ value, max = 1, segments }) {
  const track = "flex h-2.5 overflow-hidden rounded-full border border-border bg-[image:var(--mat-well)] p-px shadow-[var(--well)]";
  if (segments) {
    const total = segments.reduce((t, s) => t + s.value, 0) || 1;
    return (
      <div className={track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((segments.filter(s => s.done).reduce((t, s) => t + s.value, 0) / total) * 100)}>
        {segments.map(s => s.value > 0 && <div key={s.key} className={`first:rounded-l-full last:rounded-r-full transition-[width] duration-500 ${s.className}`} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />)}
      </div>
    );
  }
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={track} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-[image:var(--mat-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ icon = "film", title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center sm:py-14">
      <span className="mb-1 grid size-14 place-items-center rounded-2xl border border-border bg-[image:var(--mat-well)] text-muted shadow-[var(--well)]"><Icon name={icon} className="size-6" /></span>
      <p className="font-bold">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export const EmptyState = Empty;

/**
 * Tabs rendered as a segmented control: recessed track, raised thumb that slides to the selected tab.
 * Arrow keys / Home / End move between tabs (roving tabindex). The track scrolls horizontally when tabs overflow.
 */
export function Tabs({ tabs, value, onChange, label = "Sections", role = "tablist" }) {
  const track = useRef();
  const [thumb, setThumb] = useState(null);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector('[data-active="true"]');
      if (active) setThumb({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, tabs]);
  const item = role === "tablist" ? "tab" : "radio";
  const onKeyDown = (e) => {
    const i = tabs.findIndex(t => t.value === value);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    onChange(t.value);
    requestAnimationFrame(() => track.current?.querySelector(`[data-value="${CSS.escape(String(t.value))}"]`)?.focus());
  };
  return (
    <div className="max-w-full overflow-x-auto" data-scroll-x>
      <div ref={track} role={role} aria-label={label} className="segmented" onKeyDown={onKeyDown}>
        {thumb && <span className="segmented-thumb" style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} aria-hidden="true" />}
        {tabs.map(t => {
          const on = t.value === value;
          return (
            <button
              key={t.value} type="button" role={item} data-value={t.value} data-active={on}
              {...(item === "tab" ? { "aria-selected": on } : { "aria-checked": on })}
              tabIndex={on ? 0 : -1} onClick={() => onChange(t.value)} className="segmented-item"
            >
              {t.icon && <Icon name={t.icon} className="size-4" />}
              {t.label}
              {t.count !== undefined && <span className="count">{t.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Same visuals as Tabs, radio semantics — for picking one of a few options. */
export const SegmentedControl = (props) => <Tabs role="radiogroup" {...props} />;

export function Skeleton({ className = "h-4 w-full" }) {
  return <span className={`skeleton block ${className}`} aria-hidden="true" />;
}

/** Loading placeholder. `page` mirrors a page layout; the default fits inside a card. */
export function Loading({ label = "Loading…", variant = "block" }) {
  if (variant === "page") {
    return (
      <div role="status" aria-live="polite" className="grid grid-cols-1 gap-5">
        <span className="sr-only">{label}</span>
        <div className="grid grid-cols-1 gap-2"><Skeleton className="h-8 w-56 max-w-full" /><Skeleton className="h-4 w-80 max-w-full" /></div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="grid grid-cols-1 gap-3 p-5">
      <span className="sr-only">{label}</span>
      {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}
    </div>
  );
}
export const PageSkeleton = () => <Loading variant="page" />;

export function ErrorState({ error, onRetry }) {
  return (
    <div className="p-4 sm:p-5">
      <Alert kind="error" title="Couldn't load this" action={onRetry && <button className="btn-secondary btn-sm" onClick={() => onRetry()}><Icon name="refresh" className="size-3.5" />Try again</button>}>
        {error?.message || String(error)}
      </Alert>
    </div>
  );
}

/** Two-column definition list that stacks on very narrow screens. */
export function KeyValue({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm min-[400px]:grid-cols-[minmax(0,auto)_minmax(0,1fr)] min-[400px]:gap-y-2">
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="mb-1.5 min-w-0 break-words font-semibold min-[400px]:mb-0">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Chart frame: recessed plot area with gridlines, axis labels and legend. */
export function ChartContainer({ label, children, axis, legend, height = "h-44" }) {
  return (
    <figure className="min-w-0">
      <div className="plot">
        <div className={`flex ${height} items-end gap-1.5 sm:gap-2`} role="img" aria-label={label}>{children}</div>
      </div>
      {axis && <div className="mt-1.5 flex gap-1.5 px-3 text-[10px] font-bold tabular text-muted sm:gap-2">{axis}</div>}
      {legend && <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{legend}</figcaption>}
    </figure>
  );
}
export const LegendItem = ({ className, children }) => <span className="flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${className}`} aria-hidden="true" />{children}</span>;

/** Horizontal scroll region for wide tables — scrolling is intentional and keyboard-reachable. */
export function TableScroll({ label, children, className = "" }) {
  return (
    <div className={`overflow-x-auto ${className}`} data-scroll-x role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
