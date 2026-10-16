// Form building blocks: labelled fields, search, checkbox, radio cards, toggle switch.
import { cloneElement, isValidElement, useId } from "react";
import Icon from "./Icons.jsx";

/**
 * Label + control + hint/error. The control gets the id, aria-describedby and aria-invalid wired up.
 */
export function FormField({ label, hint, error, children, className = "", optional }) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id: children.props.id || id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true } : {}) })
    : children;
  return (
    <div className={`grid min-w-0 content-start gap-1.5 ${className}`}>
      <label htmlFor={isValidElement(children) ? children.props.id || id : undefined} className="label">
        {label}{optional && <span className="ml-1 font-semibold normal-case tracking-normal text-muted">(optional)</span>}
      </label>
      {control}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p>}
      <ValidationMessage id={`${id}-err`}>{error}</ValidationMessage>
    </div>
  );
}

export function ValidationMessage({ id, children }) {
  if (!children) return null;
  return <p id={id} className="flex items-center gap-1.5 text-xs font-semibold text-error" role="alert"><Icon name="alert" className="size-3.5 shrink-0" />{children}</p>;
}

/** Text input with a leading search icon. */
export function SearchField({ value, onChange, placeholder = "Search", label = "Search", className = "" }) {
  return (
    <label className={`relative block min-w-0 ${className}`}>
      <span className="sr-only">{label}</span>
      <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input type="search" className="input pl-10" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Input with a fixed unit suffix (e.g. %). */
export function SuffixInput({ suffix, className = "", ...props }) {
  return (
    <div className="relative">
      <input className={`input pr-9 tabular ${className}`} {...props} />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-muted" aria-hidden="true">{suffix}</span>
    </div>
  );
}

/** Checkbox with a 40px hit area around the 18px control. */
export function Checkbox({ checked, onChange, label, indeterminate, className = "" }) {
  return (
    <label className={`-m-2.5 inline-grid size-10 cursor-pointer place-items-center rounded-lg ${className}`}>
      <input type="checkbox" className="check" aria-label={label} checked={checked} onChange={onChange} ref={(el) => { if (el) el.indeterminate = !!indeterminate && !checked; }} />
    </label>
  );
}

/** Large selectable card backed by a native radio input. Selected cards sit pressed into the surface. */
export function RadioCard({ name, value, checked, onChange, icon, title, children }) {
  return (
    <label className={`group relative flex min-w-0 cursor-pointer gap-3 rounded-[18px] border p-4 transition-[box-shadow,border-color,background,transform] duration-200 ${checked
      ? "border-focus bg-[image:var(--mat-panel)] shadow-[var(--well),0_0_0_3px_var(--focus-halo)]"
      : "surface-raised surface-interactive"}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="sr-only" />
      <span className="radio-dot mt-0.5" aria-hidden="true" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-bold">{icon && <Icon name={icon} className="size-4 text-muted" />}{title}</span>
        {children && <span className="mt-0.5 block text-sm text-muted">{children}</span>}
      </span>
    </label>
  );
}

/** On/off switch (role="switch"). */
export function Toggle({ checked, onChange, label, showLabel = true, className = "" }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={showLabel ? undefined : label} onClick={() => onChange(!checked)}
      className={`inline-flex min-h-10 items-center gap-3 rounded-xl text-sm font-bold ${className}`}>
      {showLabel && <span>{label}</span>}
      <span className="switch" aria-hidden="true" />
    </button>
  );
}
