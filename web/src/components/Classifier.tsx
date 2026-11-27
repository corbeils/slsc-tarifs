import type React from 'react';
import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

type J = 'US' | 'CA' | 'EU';
interface Img {
  media_type: string;
  data: string;
  url: string;
}
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  images?: { media_type: string; data: string }[];
}
interface Candidate {
  code: string;
  display?: string;
  description?: string;
  path?: string;
  confidence: number;
  reasoning: string;
  rate?: string | null;
  valid: boolean;
}
type Reply = { type: 'questions'; questions: string[]; note?: string } | { type: 'result'; summary: string; candidates: Candidate[]; warnings?: string[]; model?: string };

const NAME: Record<J, string> = { US: 'INBOUND USA (HTSUS)', CA: 'INBOUND CANADA', EU: 'INBOUND EU (TARIC)' };
const DIR: Record<J, string> = { US: 'CA-US', CA: 'US-CA', EU: 'IN-EU' };

/** Photo → JPEG ≤ 1568 px (what the model reads best), base64 without the data: prefix. */
async function toImg(file: File): Promise<Img> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { media_type: 'image/jpeg', data: url.split(',')[1], url };
}

export default function Classifier({ onCompare }: { onCompare: (hs6: string) => void }) {
  const { t } = useI18n();
  const [j, setJ] = useState<J>('US');
  const [desc, setDesc] = useState('');
  const [imgs, setImgs] = useState<Img[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [reply, setReply] = useState<Reply | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const addPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = [...(input.files ?? [])].slice(0, 4 - imgs.length);
    const add = await Promise.all(files.map(toImg));
    setImgs((x) => [...x, ...add].slice(0, 4));
    input.value = '';
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const send = async (next: Turn[]) => {
    setBusy(true);
    setErr('');
    try {
      const r: Reply = await api.classify(j, next);
      setTurns(next);
      setReply(r);
      if (r.type === 'questions') setAnswers(r.questions.map(() => ''));
    } catch (e) {
      const m = (e as Error).message;
      const busy = m.match(/^(.*) is overloaded or rate-limited \(HTTP (\d+)\)/);
      setErr(busy ? t('{provider} is overloaded right now (HTTP {code}), even after several attempts. Try again in a few minutes, or choose another model or provider in Admin.', { provider: busy[1], code: busy[2] }) : t(m));
    } finally {
      setBusy(false);
    }
  };
  const start = () => send([{ role: 'user', text: desc.trim(), images: imgs.map(({ media_type, data }) => ({ media_type, data })) }]);
  const answer = () => {
    if (reply?.type !== 'questions') return;
    const qa = reply.questions.map((q, i) => `${q}\n→ ${answers[i] || '?'}`).join('\n\n');
    send([...turns, { role: 'assistant', text: reply.questions.join('\n') }, { role: 'user', text: qa }]);
  };
  const reset = () => {
    setTurns([]);
    setReply(null);
    setErr('');
  };
  const simulate = (c: Candidate) => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('slsc-tarifs-form') ?? '{}');
      sessionStorage.setItem(
        'slsc-tarifs-form',
        JSON.stringify({ ...saved, direction: DIR[j], hit: { code: c.code, display: c.display, description: c.description, path: c.path ?? '', is_leaf: 1 }, currency: j === 'US' ? 'USD' : j === 'EU' ? 'EUR' : 'CAD' }),
      );
    } catch {
      /* ignore */
    }
    location.hash = '#/simulateur';
    location.reload();
  };

  return (
    <div className="card classifier">
      <h2 style={{ marginTop: 0 }}>{t('Classification assistant')}</h2>
      <p className="small muted">{t('Describe the goods and/or add photos: the assistant applies the General Rules of Interpretation, asks questions if needed and proposes the tariff line of the chosen country (only codes that exist in the imported tariff).')}</p>

      <div className="chips" style={{ marginBottom: 8 }}>
        {(['US', 'CA', 'EU'] as J[]).map((x) => (
          <button key={x} className={`chip ${j === x ? 'on' : ''}`} disabled={turns.length > 0} onClick={() => setJ(x)}>
            {NAME[x]}
          </button>
        ))}
      </div>

      {turns.length === 0 ? (
        <>
          <textarea
            className="input"
            rows={4}
            style={{ width: '100%' }}
            placeholder={t('e.g. Hydraulic press for closed-die forging of steel parts, 2,500 tonnes, CNC controlled, new')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="row">
            {/* Phones: open the camera directly */}
            <label className="btn ghost only-touch">
              📷 {t('Take a photo')}
              <input type="file" accept="image/*" capture="environment" hidden onChange={addPhotos} />
            </label>
            <label className="btn ghost">
              {t('Add photos')}
              <input type="file" accept="image/*" multiple hidden onChange={addPhotos} />
            </label>
            {imgs.map((im, i) => (
              <span key={i} className="thumb">
                <img src={im.url} alt="" />
                <button onClick={() => setImgs((x) => x.filter((_, k) => k !== i))}>×</button>
              </span>
            ))}
            <button className="btn" disabled={busy || (!desc.trim() && !imgs.length)} onClick={start}>
              {busy ? t('Analysing…') : t('Classify')}
            </button>
          </div>
        </>
      ) : (
        <div className="small muted">
          <b>{t('Goods:')}</b> {turns[0].text} {turns[0].images?.length ? `(${turns[0].images.length} ${t('photo(s)')})` : ''}
          <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={reset}>
            {t('New classification')}
          </button>
        </div>
      )}

      {err && <div className="alert danger">{err}</div>}

      {reply?.type === 'questions' && (
        <div className="cls-questions">
          {reply.note && <p className="small muted">{reply.note}</p>}
          {reply.questions.map((q, i) => (
            <div key={i}>
              <label className="lbl">{q}</label>
              <input className="input" value={answers[i] ?? ''} onChange={(e) => setAnswers((a) => a.map((x, k) => (k === i ? e.target.value : x)))} />
            </div>
          ))}
          <button className="btn" disabled={busy} onClick={answer}>
            {busy ? t('Analysing…') : t('Send answers')}
          </button>
        </div>
      )}

      {reply?.type === 'result' && (
        <div className="cls-result">
          <p>
            <b>{reply.summary}</b>
          </p>
          {reply.candidates.map((c, i) => (
            <div key={i} className={`cls-cand ${i === 0 ? 'best' : ''}`}>
              <div className="cls-head">
                <span className="mono cls-code">{c.display ?? c.code}</span>
                <span className={`badge ${c.confidence >= 75 ? 'ok' : 'warn'}`}>{t('confidence {n}%', { n: c.confidence })}</span>
                {!c.valid && <span className="badge danger">{t('code not found in the tariff')}</span>}
                {c.rate && (
                  <span className="small muted">
                    {t('Base rate')}: <b className="mono">{c.rate}</b>
                  </span>
                )}
              </div>
              {c.description && (
                <div>
                  {c.description}
                  {c.path && <div className="small muted">{c.path}</div>}
                </div>
              )}
              <p className="small">{c.reasoning}</p>
              <div className="row" style={{ marginTop: 4 }}>
                {c.valid && (
                  <button className="btn small" onClick={() => simulate(c)}>
                    {t('Simulate')}
                  </button>
                )}
                <button className="btn ghost small" onClick={() => onCompare(c.code.slice(0, 6))}>
                  {t('Compare HS {hs} in the 3 tariffs', { hs: `${c.code.slice(0, 4)}.${c.code.slice(4, 6)}` })}
                </button>
              </div>
            </div>
          ))}
          {reply.warnings?.length ? (
            <ul className="small">
              {reply.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="small muted">
            {t('Suggestion produced by AI: check it against the tariff and the notes. For certainty, request an advance ruling (CBP, CBSA or EU BTI).')}
            {reply.model && ` (${reply.model})`}
          </p>
        </div>
      )}
    </div>
  );
}
