// Loaded once per page via Layout.astro <script>.
// - Wires the theme cycle pill: walks Light → Dark → Ocean → Sepia → Solar → Light.
// - Wires the language dropdown: opens on click, closes on outside-click/Esc,
//   applies translations + dir on selection, persists to localStorage.
// - The pre-hydration <script is:inline> in Layout.astro has already set
//   <html data-theme> and <html lang> before paint, so this only needs to
//   make the controls interactive after DOMContentLoaded.

import { THEMES, THEME_LABELS, DARK_THEMES, type Theme, type Lang } from "../i18n/index";
import { DICTS, loadStoredLang, setLang } from "../i18n/runtime";

// ───────────────────────────────────────────────────────────────────────────
// THEME
// ───────────────────────────────────────────────────────────────────────────

// Inline SVG per theme. Backticks keep the markup readable. Last `/>` on each
// path is required for XML parsing; we set via innerHTML so the HTML parser
// would auto-close, but explicit `/` is safer (and stricter parsers expect it).
const SUN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41</svg>`;
const MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z</svg>`;
const WAVE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 10c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M2 16c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M2 22c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2</svg>`;
const BOOK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z"/><path d="M19 17V7a3 3 0 0 0-3-3"/><path d="M8 8h7"/><path d="M8 12h7</svg>`;
const SUNBURST = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="m4.2 4.2 2.1 2.1"/><path d="m17.7 17.7 2.1 2.1"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m6.3 17.7-2.1 2.1"/><path d="m19.8 4.2-2.1 2.1</svg>`;

const ICONS: Record<Theme, string> = {
	light: SUN,
	dark: MOON,
	ocean: WAVE,
	sepia: BOOK,
	solar: SUNBURST,
};

function getActiveTheme(): Theme {
	const t = document.documentElement.getAttribute("data-theme");
	return (THEMES as readonly string[]).includes(t || "")
		? (t as Theme)
		: "light";
}

function applyTheme(next: Theme): void {
	const html = document.documentElement;
	html.setAttribute("data-theme", next);
	// Mirror `.dark` so legacy `dark:` Tailwind utilities fire under all dark themes.
	html.classList.toggle("dark", DARK_THEMES.has(next));
	try { localStorage.setItem("theme", next); } catch { /* private mode */ }

	const iconSlot = document.getElementById("theme-icon");
	const labelSpan = document.getElementById("theme-label");
	if (iconSlot) iconSlot.innerHTML = ICONS[next] || ICONS.light;
	if (labelSpan) labelSpan.textContent = THEME_LABELS[next];

	document.querySelectorAll<HTMLElement>("[data-theme-option]").forEach((btn) => {
		btn.setAttribute(
			"data-active",
			btn.getAttribute("data-theme-option") === next ? "true" : "false"
		);
	});

	html.dispatchEvent(new CustomEvent("themechange", { detail: { theme: next } }));
}

// ───────────────────────────────────────────────────────────────────────────
// LANGUAGE
// ───────────────────────────────────────────────────────────────────────────

function paintLangMenus(): void {
	const html = document.documentElement;
	const active = (html.getAttribute("lang") || "en") as Lang;
	const codeSpan = document.getElementById("lang-current");
	if (codeSpan) {
		codeSpan.textContent = (DICTS[active]?.["lang.code"]) || active.toUpperCase();
	}
	document.querySelectorAll<HTMLElement>("[data-lang-option]").forEach((btn) => {
		btn.setAttribute(
			"data-active",
			btn.getAttribute("data-lang-option") === active ? "true" : "false"
		);
	});
}

function setupLangDropdown(): void {
	const wrap = document.getElementById("lang-wrap");
	const toggle = document.getElementById("lang-toggle");
	const menu = document.getElementById("lang-menu");
	if (!wrap || !toggle || !menu) return;

	const openMenu = () => {
		menu.classList.remove("hidden");
		toggle.setAttribute("aria-expanded", "true");
	};
	const closeMenu = () => {
		menu.classList.add("hidden");
		toggle.setAttribute("aria-expanded", "false");
	};
	const isOpen = () => toggle.getAttribute("aria-expanded") === "true";

	toggle.addEventListener("click", (e) => {
		e.stopPropagation();
		isOpen() ? closeMenu() : openMenu();
	});

	menu.addEventListener("click", (e) => {
		const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-lang-option]");
		if (!btn) return;
		const code = btn.getAttribute("data-lang-option") as Lang | null;
		if (!code) return;
		setLang(code);
		paintLangMenus();
		closeMenu();
	});

	document.addEventListener("click", (e) => {
		if (!isOpen()) return;
		if (!wrap.contains(e.target as Node)) closeMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && isOpen()) closeMenu();
	});
}

// ───────────────────────────────────────────────────────────────────────────
// BOOT
// ───────────────────────────────────────────────────────────────────────────

function setupThemeButton(): void {
	const btn = document.getElementById("theme-toggle");
	if (!btn) return;
	applyTheme(getActiveTheme());
	btn.addEventListener("click", () => {
		const order = THEMES as readonly Theme[];
		const active = getActiveTheme();
		const next = order[(order.indexOf(active) + 1) % order.length];
		applyTheme(next);
	});
}

function init(): void {
	setupThemeButton();
	setupLangDropdown();
	paintLangMenus();

	// Apply the stored language for the first time. Pre-hydration already set
	// <html lang>/<html dir>, but we re-call to trigger DICTS swaps.
	const lang = loadStoredLang();
	if (document.documentElement.getAttribute("lang") !== lang) setLang(lang);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
