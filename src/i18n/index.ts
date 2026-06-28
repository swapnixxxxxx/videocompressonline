// Typed catalog of every UI string we translate.
// Adding a new key here forces a TS error in every dictionary that's missing it.

export type Lang = "en" | "es" | "fr" | "de" | "pt" | "ar";

export const LANGS: Lang[] = ["en", "es", "fr", "de", "pt", "ar"];

export const LANG_LABELS: Record<Lang, string> = {
	en: "English",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	pt: "Português",
	ar: "العربية",
};

// Hidden auto-direction lookup. Arabic = RTL; everything else LTR.
export const LANG_DIR: Record<Lang, "ltr" | "rtl"> = {
	en: "ltr", es: "ltr", fr: "ltr", de: "ltr", pt: "ltr", ar: "rtl",
};

// All themes, in cycle order on the theme button.
export const THEMES = ["light", "dark", "ocean", "sepia", "solar"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = {
	light: "Light", dark: "Dark", ocean: "Ocean", sepia: "Sepia", solar: "Solar",
};
// Marked as dark equivalents for `dark:` Tailwind utilities (mirrors LIGHT/DARK CSS).
export const DARK_THEMES: ReadonlySet<Theme> = new Set(["dark", "ocean", "solar"]);
