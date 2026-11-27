// Simulation report as a downloadable PDF (button "PDF" on a result).
// jsPDF is loaded on demand, only when the button is clicked.
import type { CalcResult, CalcLine } from './api';
import { api, money, pct } from './api';
import { convert } from './currency';

type T = (s: string, v?: Record<string, string | number>) => string;

export interface PdfContext {
  t: T;
  lang: 'en' | 'fr';
  originName: string;
  date: string;
  mode: string;
  place?: string; // province (Canada) or member state (EU)
  shown: string; // display currency chosen at the top
}

// Standard PDF fonts only know Western European characters: replace the others.
const clean = (s: unknown) =>
  String(s ?? '')
    .replace(/[   ]/g, ' ')
    .replace(/[→⇒]/g, '->')
    .replace(/≈/g, '~')
    .replace(/[≤]/g, '<=')
    .replace(/[≥]/g, '>=')
    .replace(/[✓✔]/g, 'Yes')
    .replace(/[✗✕×]/g, 'x')
    .replace(/[\u{1F000}-\u{1FAFF}☀-➿️]/gu, '')
    .replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '')
    .trim();

const GREEN: [number, number, number] = [140, 219, 0];
const DARK: [number, number, number] = [14, 17, 19];
const GREY: [number, number, number] = [110, 116, 122];

async function logoDataUrl(): Promise<string | null> {
  try {
    const b = await (await fetch('/icons/icon-192.png')).blob();
    return await new Promise((ok) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.onerror = () => ok(null);
      fr.readAsDataURL(b);
    });
  } catch {
    return null;
  }
}

export async function downloadResultPdf(r: CalcResult, c: PdfContext) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const { t } = c;
  const cur = r.currency;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const [logo, meta] = await Promise.all([logoDataUrl(), api.meta().catch(() => null)]);
  const alt = (n: number) => {
    if (c.shown === cur) return '';
    const v = convert(n, cur, c.shown as 'CAD' | 'USD' | 'EUR', r.fx);
    return v === null ? '' : money(v, c.shown);
  };
  const dirLabel = r.direction === 'CA-US' ? 'INBOUND USA' : r.direction === 'IN-EU' ? 'INBOUND EU' : 'INBOUND CANADA';

  // ---- Header band
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, 64, 'F');
  doc.setFillColor(...GREEN);
  doc.rect(0, 64, W, 3, 'F');
  if (logo) doc.addImage(logo, 'PNG', M, 10, 44, 44);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('SLSC TARIFF SIMULATOR', M + 56, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(200, 205, 210);
  doc.text(clean(`${t('Simulation report')} · ${dirLabel}`), M + 56, 47);
  doc.text(clean(new Date().toLocaleString(c.lang === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'long', timeStyle: 'short' })), W - M, 32, { align: 'right' });

  // ---- Product
  let y = 92;
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(clean(r.line!.display), M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y += 16;
  const desc = doc.splitTextToSize(clean(r.line!.description), W - 2 * M);
  doc.text(desc, M, y);
  y += desc.length * 12;
  if (r.line!.path) {
    doc.setFontSize(8);
    doc.setTextColor(...GREY);
    const p = doc.splitTextToSize(clean(r.line!.path), W - 2 * M);
    doc.text(p, M, y);
    y += p.length * 10;
  }

  // ---- Shipment details
  const facts: [string, string][] = [
    [t('Direction'), dirLabel],
    [t('Origin'), c.originName],
    [t('Customs value'), `${money(r.valueInput.amount, r.valueInput.currency)}${r.valueInput.currency !== cur ? ` -> ${money(r.value, cur)}` : ''}`],
    [t('Date'), c.date],
    [t('Transport'), c.mode],
  ];
  if (c.place) facts.push([r.destination === 'EU' ? t('Member state') : t('Province'), c.place]);
  if (r.preferential?.claimed) facts.push([t('Preference claimed'), r.preferential.label]);
  autoTable(doc, {
    startY: y + 6,
    body: facts.map(([k, v]) => [clean(k), clean(v)]),
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 0, right: 6 } },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 120, textColor: GREY } },
    margin: { left: M, right: M },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;

  // ---- Breakdown
  const groups: [string, CalcLine['kind'][]][] = [
    [t('Duties and measures'), ['base', 'additional']],
    [t('Anti-dumping / countervailing'), ['adcvd']],
    [t('Fees'), ['fee']],
    [t('Taxes'), ['tax']],
  ];
  const body: (string | { content: string; colSpan: number; styles: Record<string, unknown> })[][] = [];
  for (const [g, kinds] of groups) {
    const ls = r.lines.filter((l) => kinds.includes(l.kind));
    if (!ls.length) continue;
    body.push([{ content: clean(g).toUpperCase(), colSpan: 5, styles: { fontStyle: 'bold', fillColor: [238, 241, 234], textColor: DARK, fontSize: 8 } }]);
    for (const l of ls) {
      const note = [l.exempted ? t('exempted') : '', l.notCumulated ? t('not cumulated') : '', l.note ?? ''].filter(Boolean).join(' · ');
      body.push([
        clean(l.label) + (note ? `\n${clean(note)}` : ''),
        clean(l.ch99 ?? l.legal ?? l.program ?? ''),
        clean(l.ratePct !== null && l.ratePct !== undefined ? pct(l.ratePct) : l.rateText ?? ''),
        clean(money(l.basis, cur)),
        clean(money(l.amount, cur)),
      ]);
    }
  }
  autoTable(doc, {
    startY: y,
    head: [[t('Measure'), t('Heading / ref.'), t('Rate'), t('Basis'), t('Amount')].map(clean)],
    body,
    theme: 'grid',
    headStyles: { fillColor: DARK, textColor: [255, 255, 255], fontSize: 8.5 },
    styles: { fontSize: 8.5, cellPadding: 4, lineColor: [220, 224, 216], lineWidth: 0.5, valign: 'middle' },
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 92, font: 'courier', fontSize: 8 }, 2: { cellWidth: 62, halign: 'right' }, 3: { cellWidth: 78, halign: 'right' }, 4: { cellWidth: 78, halign: 'right', fontStyle: 'bold' } },
    margin: { left: M, right: M },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;

  // ---- Totals
  const tot: [string, number][] = [
    [t('Duties'), r.totals.duties],
    ...(r.totals.adcvd ? ([[t('AD/CVD'), r.totals.adcvd]] as [string, number][]) : []),
    [t('Fees'), r.totals.fees],
    [t('Taxes'), r.totals.taxes],
  ];
  const showAlt = c.shown !== cur;
  autoTable(doc, {
    startY: y,
    body: [
      ...tot.map(([k, v]) => [clean(k), clean(money(v, cur)), showAlt ? clean(alt(v)) : '']),
      [clean(`${t('TOTAL')} (${t('duties')} ${pct(r.totals.dutyPct)})`), clean(money(r.totals.total, cur)), showAlt ? clean(alt(r.totals.total)) : ''],
      [clean(t('Estimated landed cost (value + duties + fees + taxes)')), clean(money(r.totals.landed, cur)), showAlt ? clean(alt(r.totals.landed)) : ''],
    ],
    theme: 'plain',
    tableWidth: 340,
    margin: { left: W - M - 340, right: M },
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { cellWidth: 170 }, 1: { halign: 'right', fontStyle: 'bold' }, 2: { halign: 'right', textColor: GREY, fontSize: 8 } },
    didParseCell: (d) => {
      if (d.section === 'body' && d.row.index >= tot.length) {
        d.cell.styles.fillColor = d.row.index === tot.length + 1 ? GREEN : [238, 241, 234];
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.textColor = DARK;
      }
    },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  if (showAlt) {
    doc.setFontSize(7.5);
    doc.setTextColor(...GREY);
    doc.text(clean(`${c.shown}: ${t('converted at the Bank of Canada rate')}${r.fx.date ? ` (${r.fx.date})` : ''}`), W - M, y + 4, { align: 'right' });
    y += 10;
  }

  // ---- Agreements, alerts and requirements
  const notes: string[][] = [];
  for (const b of r.flags.bans) notes.push([clean(t('PROHIBITED')), clean(`${b.title}${b.detail ? ' — ' + b.detail : ''}`)]);
  for (const a of r.flags.adcvd) notes.push(['AD/CVD', clean(`${a.title}${a.detail ? ' — ' + a.detail : ''}`)]);
  for (const l of r.flags.licences) notes.push([clean(l.agency ?? t('Licence')), clean(`${l.title}${l.detail ? ' — ' + l.detail : ''}`)]);
  for (const w of r.flags.warnings) notes.push([clean(t('Warning')), clean(`${w.title}${w.detail ? ' — ' + w.detail : ''}`)]);
  for (const a of r.agreements ?? []) {
    if (a.applicable === 'no') continue;
    notes.push([clean(t('Agreement')), clean(`${a.name}: ${a.rateText}${a.applicable === 'check' ? ` (${t('to verify')})` : ''}`)]);
  }
  if (notes.length) {
    autoTable(doc, {
      startY: y + 8,
      head: [[{ content: clean(t('Requirements and notes')), colSpan: 2 }]],
      body: notes,
      theme: 'striped',
      headStyles: { fillColor: DARK, textColor: [255, 255, 255], fontSize: 8.5 },
      styles: { fontSize: 8, cellPadding: 4 },
      columnStyles: { 0: { cellWidth: 100, fontStyle: 'bold' } },
      margin: { left: M, right: M },
    });
  }

  // ---- Footer on every page
  const pages = doc.getNumberOfPages();
  const site = (meta as { site?: { version: string; beta: boolean } } | null)?.site;
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...GREEN);
    doc.setLineWidth(1);
    doc.line(M, H - 44, W - M, H - 44);
    doc.setFontSize(7);
    doc.setTextColor(...GREY);
    const disclaimer = doc.splitTextToSize(clean(`${t('Important Notice:')} ${t('This site is provided for informational purposes only, offered without any warranty')}`), W - 2 * M - 70);
    doc.text(disclaimer, M, H - 32);
    doc.text(clean(`${site ? (site.beta ? 'BETA ' : '') + site.version + ' · ' : ''}${i}/${pages}`), W - M, H - 32, { align: 'right' });
  }

  doc.save(`SLSC tariff simulation ${r.line!.display} ${new Date().toISOString().slice(0, 10)}.pdf`);
}
