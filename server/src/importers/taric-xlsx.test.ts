import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { xlsxRows } from './taric.js';

describe('TARIC xlsx reader', () => {
  it('reads files whose worksheets come before workbook.xml in the zip', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Goods code', 'Description']);
    ws.addRow(['8462000000', 'Machine tools']);
    const src = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
    // Rebuild the zip with the worksheets first (some exporters write them in that order)
    const names = Object.keys(src.files).sort((a, b) => Number(!a.includes('worksheets/')) - Number(!b.includes('worksheets/')));
    const out = new JSZip();
    for (const n of names) if (!src.files[n].dir) out.file(n, await src.files[n].async('uint8array'));
    const buf = await out.generateAsync({ type: 'nodebuffer' });
    const rows: unknown[][] = [];
    for await (const r of xlsxRows(buf)) rows.push(r);
    expect(rows).toEqual([
      ['Goods code', 'Description'],
      ['8462000000', 'Machine tools'],
    ]);
  });
});
