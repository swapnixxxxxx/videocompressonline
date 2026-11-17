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

// Icon shows the theme you'll switch TO.
const SUN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
const MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

const ICONS: Record<Theme, string> = {
	light: MOON,
	dark: SUN,
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
	// Mirror `.dark` so `dark:` Tailwind utilities fire in dark theme.
	html.classList.toggle("dark", DARK_THEMES.has(next));
	try { localStorage.setItem("theme", next); } catch { /* private mode */ }

	const iconSlot = document.getElementById("theme-icon");
	const labelSpan = document.getElementById("theme-label");
	if (iconSlot) iconSlot.innerHTML = ICONS[next] || ICONS.light;
	const target: Theme = next === "dark" ? "light" : "dark";
	if (labelSpan) labelSpan.textContent = THEME_LABELS[target];
	document.getElementById("theme-toggle")?.setAttribute("aria-label", `Switch to ${THEME_LABELS[target].toLowerCase()} theme`);

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
