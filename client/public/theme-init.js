// Applies the saved/OS theme before first paint (external file: the CSP forbids inline scripts).
try { document.documentElement.dataset.theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch { /* storage unavailable */ }
