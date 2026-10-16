// Interactive controls: Popover, Select (listbox), Menu, Tooltip, IconButton, Modal, Drawer, Confirm, Toasts.
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icons.jsx";

const GUTTER = 8;

/** Keeps an overlay mounted while its exit animation plays. */
export function usePresence(open, ms = 220) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/** Locks page scroll while an overlay is open (restores the previous value). */
function useScrollLock(active) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [active]);
}

// ---------- Popover (portal, flips vertically, clamped to the viewport) ----------
export function Popover({ open, anchorRef, onClose, children, matchWidth = true, align = "left", maxHeight = 320, minWidth = 0 }) {
  const [pos, setPos] = useState(null);
  const panel = useRef();
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth, vh = innerHeight;
      const below = vh - r.bottom - 12, above = r.top - 12;
      const up = below < Math.min(maxHeight, 200) && above > below;
      const width = matchWidth ? Math.min(Math.max(r.width, minWidth), vw - GUTTER * 2) : undefined;
      const w = width || panel.current?.offsetWidth || 240;
      const ideal = align === "right" ? r.right - w : r.left;
      const left = Math.max(GUTTER, Math.min(ideal, vw - w - GUTTER));
      setPos({ left, width, maxWidth: vw - GUTTER * 2, top: up ? undefined : r.bottom + 6, bottom: up ? vh - r.top + 6 : undefined, maxHeight: Math.max(120, Math.min(maxHeight, up ? above : below)) });
    };
    place();
    const raf = requestAnimationFrame(place); // re-clamp once the panel has a measured width
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, [open, anchorRef, matchWidth, align, maxHeight, minWidth]);
  useEffect(() => {
    if (!open) return;
    const down = (e) => { if (!anchorRef.current?.contains(e.target) && !panel.current?.contains(e.target)) onClose(); };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  return createPortal(
    <div ref={panel} className="surface-floating anim-pop fixed z-50 overflow-auto p-1.5" style={pos || { left: -9999, top: 0 }}>{children}</div>,
    document.body
  );
}

// ---------- Select ----------
/** options: [{ value, label, hint? }] */
export function Select({ value, onChange, options, label, placeholder = "Select…", className = "", id: idProp }) {
  const autoId = useId();
  const id = idProp || autoId;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef();
  const list = useRef();
  const current = options.find(o => o.value === value);
  useEffect(() => { if (open) setActive(Math.max(0, options.findIndex(o => o.value === value))); }, [open, options, value]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  const pick = (o) => { onChange(o.value); setOpen(false); btn.current?.focus(); };
  const onKeyDown = (e) => {
    if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => (a + 1) % options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a - 1 + options.length) % options.length); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(options[active]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
  };
  return (
    <>
      <button
        ref={btn} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined} aria-label={label ? `${label}: ${current?.label ?? placeholder}` : undefined}
        onClick={() => setOpen(o => !o)} onKeyDown={onKeyDown}
        className={`input flex items-center justify-between gap-2 text-left ${className}`}
      >
        <span className={`truncate ${current ? "font-semibold" : "text-muted"}`}>{current?.label ?? placeholder}</span>
        <Icon name="chevron" className={`size-4 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <Popover open={open} anchorRef={btn} onClose={() => setOpen(false)} minWidth={200}>
        <ul ref={list} role="listbox" id={`${id}-list`} aria-label={label} className="grid gap-0.5">
          {options.map((o, i) => (
            <li
              key={String(o.value)} id={`${id}-${i}`} data-i={i} role="option" aria-selected={o.value === value}
              onPointerMove={() => setActive(i)} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(o)}
              className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${i === active ? "bg-sunken" : ""} ${o.value === value ? "font-bold" : ""}`}
            >
              <span className="min-w-0 flex-1"><span className="block truncate">{o.label}</span>{o.hint && <span className="block truncate text-xs text-muted">{o.hint}</span>}</span>
              {o.value === value && <span className="grid size-5 shrink-0 place-items-center rounded-md bg-[image:var(--mat-accent)] text-black shadow-[var(--key-accent)]"><Icon name="check" className="size-3.5" /></span>}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

// ---------- Menu (button + action list; arrow keys move between items) ----------
export function Menu({ label, icon, items, buttonClass = "btn-secondary", align = "right", ariaLabel }) {
  const [open, setOpen] = useState(false);
  const btn = useRef();
  const menu = useRef();
  const close = useCallback((refocus) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  useEffect(() => { if (open) requestAnimationFrame(() => menu.current?.querySelector("[role=menuitem]:not(:disabled)")?.focus()); }, [open]);
  const onKeyDown = (e) => {
    const els = [...menu.current.querySelectorAll("[role=menuitem]:not(:disabled)")];
    const i = els.indexOf(document.activeElement);
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: els.length - 1 }[e.key];
    if (next !== undefined) { e.preventDefault(); els[(next + els.length) % els.length]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close(false);
  };
  return (
    <>
      <button ref={btn} type="button" className={buttonClass} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {icon && <Icon name={icon} />}{label}<Icon name="chevron" className={`size-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <Popover open={open} anchorRef={btn} onClose={() => close(false)} matchWidth={false} align={align} maxHeight={420}>
        <div ref={menu} role="menu" aria-label={ariaLabel || (typeof label === "string" ? label : undefined)} className="grid w-64 max-w-full gap-0.5" onKeyDown={onKeyDown}>
          {items.map((it, i) => it.divider
            ? <div key={i} role="separator" className="my-1 border-t border-border" />
            : it.heading
              ? <p key={i} className="label px-3 pb-1 pt-2">{it.heading}</p>
              : (
                <button key={i} role="menuitem" type="button" disabled={it.disabled}
                  onClick={() => { close(true); it.onClick(); }}
                  className="flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-semibold outline-none transition-colors hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-none disabled:opacity-40">
                  {it.icon && <Icon name={it.icon} className="size-4 shrink-0 text-muted" />}<span className="min-w-0">{it.label}</span>
                </button>
              ))}
        </div>
      </Popover>
    </>
  );
}
export const DropdownMenu = Menu;

// ---------- Tooltip (portal; positioned above, flips below, clamped horizontally) ----------
export function Tooltip({ label, children, className = "" }) {
  const [anchor, setAnchor] = useState(null);
  const ref = useRef();
  const tip = useRef();
  const id = useId();
  const show = () => setAnchor(ref.current?.getBoundingClientRect() || null);
  const hide = () => setAnchor(null);
  useLayoutEffect(() => {
    const t = tip.current;
    if (!anchor || !t) return;
    const vw = document.documentElement.clientWidth;
    const left = Math.max(GUTTER, Math.min(anchor.left + anchor.width / 2 - t.offsetWidth / 2, vw - t.offsetWidth - GUTTER));
    const top = anchor.top - t.offsetHeight - 8 < GUTTER ? anchor.bottom + 8 : anchor.top - t.offsetHeight - 8;
    Object.assign(t.style, { left: `${left}px`, top: `${top}px`, visibility: "visible" });
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    addEventListener("scroll", hide, true);
    return () => removeEventListener("scroll", hide, true);
  }, [anchor]);
  const child = isValidElement(children) && anchor ? cloneElement(children, { "aria-describedby": id }) : children;
  return (
    <span ref={ref} className={`inline-flex ${className}`} onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} onKeyDown={(e) => e.key === "Escape" && hide()}>
      {child}
      {anchor && createPortal(<span ref={tip} id={id} role="tooltip" className="tooltip fixed" style={{ left: 0, top: 0, visibility: "hidden" }}>{label}</span>, document.body)}
    </span>
  );
}

/** Square icon-only button with an accessible name and a tooltip. */
export function IconButton({ icon, label, onClick, variant = "ghost", size = "md", className = "", tooltip = true, ...rest }) {
  const button = (
    <button type="button" aria-label={label} onClick={onClick} className={`btn-${variant} btn-icon ${size === "sm" ? "btn-sm" : ""} ${className}`} {...rest}>
      <Icon name={icon} className={size === "sm" ? "size-4" : "size-4.5"} />
    </button>
  );
  return tooltip ? <Tooltip label={label}>{button}</Tooltip> : button;
}

// ---------- Modal + Drawer ----------
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus the first [data-autofocus] (or focusable) element on open, trap Tab, restore focus on close. */
function useDialogFocus(open, panel) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement;
    const t = setTimeout(() => (panel.current?.querySelector("[data-autofocus]") || panel.current?.querySelector(FOCUSABLE) || panel.current)?.focus(), 30);
    return () => { clearTimeout(t); prev?.focus?.(); };
  }, [open, panel]);
  return (e, onClose) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const els = [...panel.current.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!els.length) return;
    if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0].focus(); }
  };
}

export function Modal({ open, onClose, title, children, size = "max-w-lg", role = "dialog", footer }) {
  const panel = useRef();
  const titleId = useId();
  const { mounted, closing } = usePresence(open, 200);
  const trap = useDialogFocus(open, panel);
  useScrollLock(open);
  if (!mounted) return null;
  return createPortal(
    <div className={`fixed inset-0 z-40 flex items-end justify-center bg-black/55 backdrop-blur-[2px] sm:items-center sm:p-6 ${closing ? "anim-scrim-out" : "anim-scrim-in"}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel} role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(e) => trap(e, onClose)}
        className={`surface-dialog pb-safe flex max-h-[92dvh] w-full ${size} flex-col rounded-b-none outline-none sm:max-h-[88dvh] sm:rounded-b-[22px] ${closing ? "anim-dialog-out" : "anim-dialog-in"}`}
      >
        <header className="flex items-start gap-3 px-5 pb-2 pt-5 sm:px-6">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg">{title}</h2>
          <IconButton icon="x" label="Close" size="sm" onClick={onClose} tooltip={false} className="-mr-1 -mt-1" />
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

/** Side panel (navigation on small screens). Slides in from the left. */
export function Drawer({ open, onClose, label, children, className = "" }) {
  const panel = useRef();
  const { mounted, closing } = usePresence(open, 220);
  const trap = useDialogFocus(open, panel);
  useScrollLock(open);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className={`absolute inset-0 bg-black/55 backdrop-blur-[2px] ${closing ? "anim-scrim-out" : "anim-scrim-in"}`} onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={(e) => trap(e, onClose)}
        className={`absolute inset-y-0 left-0 flex w-[min(300px,86vw)] flex-col outline-none shadow-[var(--e4)] ${closing ? "anim-drawer-out" : "anim-drawer-in"} ${className}`}>
        {children}
      </div>
    </div>,
    document.body
  );
}

// ---------- Confirm ----------
const ConfirmCtx = createContext(() => Promise.resolve(false));
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const [open, setOpen] = useState(false);
  const confirm = useCallback((opts) => new Promise(resolve => { setReq({ ...opts, resolve }); setOpen(true); }), []);
  const done = (ok) => { req?.resolve(ok); setOpen(false); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={open} onClose={() => done(false)} title={req?.title} role="alertdialog" size="sm:max-w-md"
        footer={<>
          <button className="btn-secondary" data-autofocus onClick={() => done(false)}>Cancel</button>
          <button className={req?.danger ? "btn-danger" : "btn-primary"} onClick={() => done(true)}>{req?.confirmLabel || "Confirm"}</button>
        </>}>
        <p className="text-sm text-muted">{req?.body}</p>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const ConfirmationDialog = ConfirmProvider;

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
const TOAST_ICON = { success: "checkCircle", error: "xCircle", warning: "alert", info: "info" };
const TOAST_TONE = { success: "text-success", error: "text-error", warning: "text-warning", info: "text-info" };

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = useCallback((id) => {
    setItems(t => t.map(x => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setItems(t => t.filter(x => x.id !== id)), 200);
  }, []);
  const toast = useCallback((msg, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setItems(t => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4000);
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="pb-safe pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite">
        {items.map(t => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
            className={`surface-floating pointer-events-auto flex w-full max-w-[420px] items-start gap-3 py-3 pl-4 pr-2 text-sm font-semibold ${t.leaving ? "anim-scrim-out" : "anim-toast"}`}>
            <span className={`mt-0.5 shrink-0 ${TOAST_TONE[t.kind]}`}><Icon name={TOAST_ICON[t.kind]} className="size-4.5" /></span>
            <span className="min-w-0 flex-1 self-center break-words">{t.msg}</span>
            <button type="button" className="btn-ghost btn-sm btn-icon shrink-0" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}><Icon name="x" className="size-3.5" /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
