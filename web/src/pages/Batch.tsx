import { useState } from 'react';
import type { Direction } from '../api';

export default function Batch() {
  const [direction, setDirection] = useState<Direction>('CA-US');
  const [origin, setOrigin] = useState('CA');
  const [currency, setCurrency] = useState<'USD' | 'CAD'>('USD');
  const [preferential, setPref] = useState(true);
  const [province, setProvince] = useState('QC');
  const [mode, setMode] = useState('truck');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setMsg('');
    try {
      const fd = new FormData();
      Object.entries({ direction, origin, currency, preferential: String(preferential), province, mode }).forEach(([k, v]) => fd.append(k, v));
      fd.append('file', file);
      const res = await fetch('/api/batch', { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `simulation-${file.name.replace(/\.[^.]+$/, '')}.xlsx`;
      a.click();
      setMsg(`${res.headers.get('X-Rows')} lines calculated, ${res.headers.get('X-Errors')} error(s).`);
    } catch (e) {
      setMsg('Error: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow">
      <div className="card">
        <h2>Batch simulation (parts list)</h2>
        <p className="muted">
          Upload an Excel file (.xlsx — CSV also accepted): every line is calculated with the same rules as the simulator, and you get the file back with
          rates, measures, AD/CVD, licences and warnings added.
        </p>
        <div className="grid3">
          <div>
            <label className="lbl">Direction</label>
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="CA-US">INBOUND USA — import into the United States</option>
              <option value="US-CA">INBOUND CANADA — import into Canada</option>
            </select>
          </div>
          <div>
            <label className="lbl">Default origin</label>
            <input className="input" value={origin} maxLength={2} onChange={(e) => setOrigin(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className="lbl">Default currency</label>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'CAD')}>
              <option>USD</option>
              <option>CAD</option>
            </select>
          </div>
          <div>
            <label className="lbl">Mode</label>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="truck">Truck</option>
              <option value="rail">Rail</option>
              <option value="ocean">Ocean</option>
              <option value="air">Air</option>
            </select>
          </div>
          <div>
            <label className="lbl">Province (Inbound Canada)</label>
            <input className="input" value={province} maxLength={2} onChange={(e) => setProvince(e.target.value.toUpperCase())} />
          </div>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={preferential} onChange={(e) => setPref(e.target.checked)} />
            <span>Claim USMCA / CUSMA by default</span>
          </label>
        </div>
        <div className="drop">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="row">
          <button className="btn" disabled={!file || busy} onClick={run}>
            {busy ? 'Calculating…' : 'Calculate and download'}
          </button>
          <a className="btn ghost" href="/api/batch/template" download>
            Download Excel template
          </a>
        </div>
        {msg && <div className="alert info">{msg}</div>}
      </div>
      <div className="card">
        <h3>Recognized columns</h3>
        <table className="simple">
          <tbody>
            <tr><td><b>HTS / HS / Tariff / Code</b></td><td>Code to calculate (required)</td></tr>
            <tr><td><b>Value / Price / Amount</b></td><td>Customs value (required)</td></tr>
            <tr><td>Origin / Country / COO</td><td>2-letter ISO code (otherwise the default origin)</td></tr>
            <tr><td>Currency</td><td>USD or CAD</td></tr>
            <tr><td>Qty / Quantity</td><td>Used for specific rates (kg or units)</td></tr>
            <tr><td>USMCA / CUSMA / Pref.</td><td>yes / no — claim the preference</td></tr>
            <tr><td>US content %</td><td>For Section 232 programs calculated on non-U.S. content</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
