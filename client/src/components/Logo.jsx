// Hookline brand: a beveled yellow key with a black hook whose barb doubles as a play arrow.
import { useId } from "react";

export function LogoMark({ className = "size-9" }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 40 40" className={`shrink-0 ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE24D" />
          <stop offset="0.55" stopColor="#FFD600" />
          <stop offset="1" stopColor="#F0C800" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.85" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="2.5" width="38" height="36.5" rx="11" fill="#A68A00" />
      <rect x="1" y="1" width="38" height="36" rx="11" fill={`url(#${id}-face)`} />
      <rect x="1.75" y="1.75" width="36.5" height="34.5" rx="10.25" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="1.5" />
      <circle cx="24.5" cy="8.6" r="2.5" fill="none" stroke="#111111" strokeWidth="2.6" />
      <path d="M24.5 11.4V22a6.25 6.25 0 0 1-12.5 0v-1.2" fill="none" stroke="#111111" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M12 13.6l-3.9 6.1h7.8z" fill="#111111" stroke="#111111" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className = "", markClass = "size-9", wordClass = "text-lg" }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className={markClass} />
      <span className={`font-black tracking-tight ${wordClass}`}>Hook<span className="text-yellow">line</span></span>
    </span>
  );
}
