// Lightweight runtime i18n — no Paraglide, no URL routing.
// Reads dictionaries from src/i18n/*.json (bundled via Vite import).
// Persists selection to localStorage and reflects onto <html lang> / <html dir>.

import type { Lang } from "./index";
import { LANGS, LANG_DIR } from "./index";

import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import de from "./de.json";
import pt from "./pt.json";
import ar from "./ar.json";

export const DICTS: Record<Lang, Record<string, string>> = { en, es, fr, de, pt, ar };

const LANG_KEY = "lang";
const STORAGE_KEY = "lang-storage-v1";

export function isLang(value: unknown): value is Lang {
	return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

export function loadStoredLang(): Lang {
	try {
		const raw = localStorage.getItem(LANG_KEY);
		if (isLang(raw)) return raw;
		const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
		if (isLang(nav)) return nav;
	} catch {
		// localStorage / navigator blocked — fall through.
	}
	return "en";
}

export function getCurrentLang(): Lang {
	const html = document.documentElement;
	const fromAttr = html.getAttribute("lang");
	return isLang(fromAttr) ? (fromAttr as Lang) : "en";
}

export function setLang(lang: Lang): void {
	const html = document.documentElement;
	html.setAttribute("lang", lang);
	html.setAttribute("dir", LANG_DIR[lang]);
	try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode */ }
	applyTranslations(document, lang);
	html.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
}

/**
 * Walk the DOM, swap `textContent` for every `[data-i18n]` node.
 * Falls back to English if the active dictionary doesn't translate a key —
 * so untranslated keys never show up blank.
 */
export function applyTranslations(root: ParentNode = document, lang: Lang = getCurrentLang()): void {
	const dict = DICTS[lang] || DICTS.en;
	const fallback = DICTS.en;
	const nodes = root.querySelectorAll<HTMLElement>("[data-i18n]");
	nodes.forEach((el) => {
		const key = el.getAttribute("data-i18n");
		if (!key) return;
		const value = dict[key] ?? fallback[key];
		if (value === undefined) return; // no key in english either — leave as-is
		// Preserve nested HTML for `placeholder` and similar attrs.
		const attr = el.getAttribute("data-i18n-attr");
		if (attr) el.setAttribute(attr, value);
		else el.textContent = value;
	});
}

// Tiny helper used by `<Header>` / `<Footer>` for SSR attributes that should differ per language.
export { STORAGE_KEY };
