import { useState } from 'react';
import type { Direction } from '../api';

const TEMPLATE = `Article,Description,HTS,Origine,Valeur,Quantité,ACEUM,Contenu US %
1,Presse de forgeage,8462.11.00.35,CA,250000,1,oui,
2,Boîte de vitesses,8483.40.50.10,CA,12000,4,oui,
3,Pièce acier usinée,7326.90.86.88,CN,3500,120,non,
`;

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
      setMsg(`${res.headers.get('X-Rows')} lignes calculées, ${res.headers.get('X-Errors')} erreur(s).`);
    } catch (e) {
      setMsg('Erreur : ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dlTemplate = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv' }));
    a.download = 'gabarit-simulation.csv';
    a.click();
  };

  return (
    <div className="narrow">
      <div className="card">
        <h2>Simulation en lot (liste de pièces)</h2>
        <p className="muted">
          Téléversez un fichier Excel ou CSV : chaque ligne est calculée avec les mêmes règles que le simulateur, et vous récupérez le fichier
          enrichi (taux, mesures, AD/CVD, licences, alertes).
        </p>
        <div className="grid3">
          <div>
            <label className="lbl">Direction</label>
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="CA-US">Importation aux États-Unis</option>
              <option value="US-CA">Importation au Canada</option>
            </select>
          </div>
          <div>
            <label className="lbl">Origine par défaut</label>
            <input className="input" value={origin} maxLength={2} onChange={(e) => setOrigin(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className="lbl">Devise par défaut</label>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'CAD')}>
              <option>USD</option>
              <option>CAD</option>
            </select>
          </div>
          <div>
            <label className="lbl">Mode</label>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="truck">Routier</option>
              <option value="rail">Ferroviaire</option>
              <option value="ocean">Maritime</option>
              <option value="air">Aérien</option>
            </select>
          </div>
          <div>
            <label className="lbl">Province (import CA)</label>
            <input className="input" value={province} maxLength={2} onChange={(e) => setProvince(e.target.value.toUpperCase())} />
          </div>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={preferential} onChange={(e) => setPref(e.target.checked)} />
            <span>Réclamer ACEUM par défaut</span>
          </label>
        </div>
        <div className="drop">
          <input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="row">
          <button className="btn" disabled={!file || busy} onClick={run}>
            {busy ? 'Calcul…' : 'Calculer et télécharger'}
          </button>
          <button className="btn ghost" onClick={dlTemplate}>
            Télécharger le gabarit
          </button>
        </div>
        {msg && <div className="alert info">{msg}</div>}
      </div>
      <div className="card">
        <h3>Colonnes reconnues</h3>
        <table className="simple">
          <tbody>
            <tr><td><b>HTS / HS / Tarif / Code</b></td><td>Code à classer (obligatoire)</td></tr>
            <tr><td><b>Valeur / Value / Prix / Montant</b></td><td>Valeur en douane (obligatoire)</td></tr>
            <tr><td>Origine / Pays / COO</td><td>Code ISO à 2 lettres (sinon origine par défaut)</td></tr>
            <tr><td>Devise / Currency</td><td>USD ou CAD</td></tr>
            <tr><td>Quantité / Qty</td><td>Utilisée pour les taux spécifiques (kg ou unités)</td></tr>
            <tr><td>ACEUM / USMCA / CUSMA / Préf.</td><td>oui / non — réclamer la préférence</td></tr>
            <tr><td>Contenu US %</td><td>Pour les programmes 232 calculés sur le contenu non américain</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
