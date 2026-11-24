import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { FR } from './i18n-fr';

export type Lang = 'en' | 'fr';
const KEY = 'slsc-tariff-lang';

let current: Lang = 'en';
/** Current UI language (also read by the number/date formatters in api.ts). */
export const getLang = (): Lang => current;

export function storedLang(): Lang {
  const s = localStorage.getItem(KEY);
  if (s === 'en' || s === 'fr') return s;
  return navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Translate an English UI string; {name} placeholders are filled from vars. */
export function translate(l: Lang, en: string, vars?: Record<string, string | number | undefined | null>): string {
  const s = l === 'fr' ? FR[en] ?? en : en;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m)) : s;
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (en: string, vars?: Record<string, string | number | undefined | null>) => string };
const LangContext = createContext<Ctx>({ lang: 'en', setLang: () => {}, t: (s) => s });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (current = storedLang()));
  current = lang;
  useEffect(() => {
    localStorage.setItem(KEY, lang);
    document.documentElement.lang = lang === 'fr' ? 'fr-CA' : 'en-CA';
  }, [lang]);
  const value: Ctx = { lang, setLang: setLangState, t: (en, vars) => translate(lang, en, vars) };
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useI18n = () => useContext(LangContext);

export function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="theme lang" role="radiogroup" aria-label="Language / Langue">
      {(['en', 'fr'] as const).map((l) => (
        <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} title={l === 'en' ? 'English' : 'Français'} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
