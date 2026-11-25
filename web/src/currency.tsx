import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type DisplayCur = 'CAD' | 'USD' | 'EUR';
const KEY = 'slsc-tariff-display-currency';

const Ctx = createContext<{ cur: DisplayCur; setCur: (c: DisplayCur) => void }>({ cur: 'CAD', setCur: () => {} });

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [cur, setCur] = useState<DisplayCur>(() => {
    const s = localStorage.getItem(KEY);
    return s === 'USD' || s === 'EUR' || s === 'CAD' ? s : 'CAD';
  });
  useEffect(() => localStorage.setItem(KEY, cur), [cur]);
  return <Ctx.Provider value={{ cur, setCur }}>{children}</Ctx.Provider>;
}

export const useDisplayCurrency = () => useContext(Ctx);

/** Converts an amount between CAD / USD / EUR with the rates of a result (Bank of Canada). */
export function convert(amount: number, from: string, to: string, fx: { usdCad: number; eurCad?: number }): number | null {
  const inCad = (c: string) => (c === 'CAD' ? 1 : c === 'USD' ? fx.usdCad : c === 'EUR' ? fx.eurCad ?? null : null);
  const a = inCad(from);
  const b = inCad(to);
  return a && b ? (amount * a) / b : null;
}

export function CurrencyToggle() {
  const { cur, setCur } = useDisplayCurrency();
  return (
    <div className="theme lang" role="radiogroup" aria-label="Currency / Devise">
      {(['CAD', 'USD', 'EUR'] as const).map((c) => (
        <button key={c} role="radio" aria-checked={cur === c} className={cur === c ? 'on' : ''} onClick={() => setCur(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}
