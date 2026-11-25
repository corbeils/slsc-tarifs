import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, session } from './api';
import { useI18n } from './i18n';
import { useDisplayCurrency } from './currency';

export type Role = 'admin' | 'user';
export interface AuthUser {
  username: string;
  role: Role;
  mustChange: boolean;
  prefs: Record<string, string>;
}

const Ctx = createContext<{ user: AuthUser | null; ready: boolean }>({ user: null, ready: false });
export const useAuth = () => useContext(Ctx);

/** Who is signed in (role decides which tabs are shown). Refreshed on sign-in / sign-out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const load = () => {
      if (!session.get()) {
        setUser(null);
        setReady(true);
        return;
      }
      api.admin
        .me()
        .then((u) => setUser({ username: u.username, role: u.role ?? 'admin', mustChange: u.mustChange, prefs: u.prefs ?? {} }))
        .catch(() => setUser(null))
        .finally(() => setReady(true));
    };
    load();
    window.addEventListener('slsc-session', load);
    return () => window.removeEventListener('slsc-session', load);
  }, []);
  return (
    <Ctx.Provider value={{ user, ready }}>
      <PrefsSync user={user} />
      {children}
    </Ctx.Provider>
  );
}

/** Language, display currency and theme follow the account: restored at sign-in, saved when changed. */
function PrefsSync({ user }: { user: AuthUser | null }) {
  const { lang, setLang } = useI18n();
  const { cur, setCur } = useDisplayCurrency();
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!user) {
      applied.current = null;
      return;
    }
    if (applied.current === user.username) return;
    applied.current = user.username;
    const p = user.prefs;
    if (p.lang === 'en' || p.lang === 'fr') setLang(p.lang);
    if (p.currency === 'CAD' || p.currency === 'USD' || p.currency === 'EUR') setCur(p.currency);
    if (p.theme) window.dispatchEvent(new CustomEvent('slsc-set-theme', { detail: p.theme }));
  }, [user]);
  const save = (p: Record<string, string>) => {
    if (user && applied.current === user.username) api.admin.prefs(p).catch(() => {});
  };
  useEffect(() => save({ lang }), [lang]);
  useEffect(() => save({ currency: cur }), [cur]);
  useEffect(() => {
    const on = (e: Event) => save({ theme: (e as CustomEvent<{ theme: string }>).detail.theme });
    window.addEventListener('slsc-prefs', on);
    return () => window.removeEventListener('slsc-prefs', on);
  });
  return null;
}
