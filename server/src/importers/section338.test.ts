import { describe, expect, it } from 'vitest';
import { extractCodes, section } from './misc.js';

const CBP = `Section 338-Canada Modified HTS List
Additional classifications subject to Section 338 duties as of October 30, 2026, are shown in
bold font under HTSUS heading 9903.03.14.
9903.03.12
0406.10.64 0406.10.84 2208.30.6020
Section 338-Canada Modified HTS List
Page 1 of 7
9903.03.13
0402.10.05 3504.00.50
9903.03.14
0406.90.99 9706.90.00
9903.03.15
As provided in heading 9903.03.15, the additional duties imposed by heading 9903.03.13 shall not apply to
7601.10.00
9903.03.16
3917.21.00`;

const codes = (from: string, until?: string) =>
  extractCodes(section(CBP, from, until), false, { headings: false }).map((c) => c.code);

describe('Section 338 CBP list', () => {
  it('splits the consolidated list by heading lines, ignoring mentions in sentences', () => {
    expect(codes('^9903.03.12', '^9903.03.13')).toEqual(['04061064', '04061084', '2208306020']);
    expect(codes('^9903.03.13', '^9903.03.14')).toEqual(['04021005', '35040050']);
    expect(codes('^9903.03.14', '^9903.03.15')).toEqual(['04069099', '97069000']);
  });
  it('reads Annex I of a proclamation from the line that opens it', () => {
    const fr = 'as set forth in Annex I to this proclamation, 2026\nPROCLAMATION 11063\nAnnex I\nNote: excluded\n8711.50.00\nAnnex II\n8711.60.00';
    expect(extractCodes(section(fr, '^Annex I'), false, { headings: false }).map((c) => c.code)).toEqual(['87115000', '87116000']);
  });
});

import { cellToCode } from '../batch.js';
describe('codes saisis dans Excel', () => {
  it('reconstitue les zéros perdus par Excel', () => {
    expect(cellToCode(8483.4)).toBe('8483.40');
    expect(cellToCode(402.1)).toBe('0402.10');
    expect(cellToCode(402100000)).toBe('0402100000');
    expect(cellToCode(8462110035)).toBe('8462110035');
    expect(cellToCode(7326.9086)).toBe('7326.9086');
    expect(cellToCode(' 8462.11.00.35 ')).toBe('8462.11.00.35');
  });
});
