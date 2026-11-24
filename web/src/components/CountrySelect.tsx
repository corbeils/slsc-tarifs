import type { Country } from '../api';
import { useI18n } from '../i18n';

const QUICK = ['CA', 'US', 'MX', 'FR', 'CN', 'IT', 'DE', 'ES', 'KR', 'JP'];

export default function CountrySelect({ countries, value, onChange }: { countries: Country[]; value: string; onChange: (c: string) => void }) {
  const { lang } = useI18n();
  const list = lang === 'fr' ? [...countries].sort((a, b) => a.fr.localeCompare(b.fr, 'fr')) : countries;
  return (
    <div>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {list.map((c) => (
          <option key={c.code} value={c.code}>
            {lang === 'fr' ? c.fr : c.en} ({c.code})
          </option>
        ))}
      </select>
      <div className="chips">
        {QUICK.map((c) => (
          <button type="button" key={c} className={`chip ${value === c ? 'on' : ''}`} onClick={() => onChange(c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
