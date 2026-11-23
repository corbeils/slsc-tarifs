import type { Country } from '../api';

const QUICK = ['CA', 'US', 'MX', 'CN', 'DE', 'JP'];

export default function CountrySelect({ countries, value, onChange }: { countries: Country[]; value: string; onChange: (c: string) => void }) {
  return (
    <div>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.en} ({c.code})
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
