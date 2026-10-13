// Reading files for import. No libraries, so it works offline and from file://.
//   await Importer.readTable(file) → array of rows; each row is an array of cell values
//                                    (strings, or numbers for numeric Excel cells).
// Supports .xlsx (first sheet), .csv (comma / semicolon / tab), and text (this app's text export,
// or tab / multi-space separated columns).

const Importer = (() => {
  async function readTable(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx')) return readXlsx(await file.arrayBuffer());
    if (name.endsWith('.xls')) throw new Error('Old .xls files aren\'t supported. In Excel, use "Save as" → .xlsx or CSV, then import that.');
    const text = (await file.text()).replace(/^﻿/, '');
    if (name.endsWith('.csv')) return parseDelimited(text, guessDelimiter(text));
    if (name.endsWith('.tsv')) return parseDelimited(text, '\t');
    return parseText(text);
  }

  // ---------- CSV / TSV ----------

  function guessDelimiter(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const count = (ch) => first.split(ch).length - 1;
    return [',', ';', '\t'].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
  }

  /** RFC 4180-style parser: quoted fields may contain the delimiter, quotes ("") and line breaks. */
  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"' && field === '') quoted = true;
      else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  // ---------- plain text ----------

  function parseText(text) {
    const lines = text.split(/\r?\n/);
    if (lines.some((l) => l.includes('\t'))) return parseDelimited(text, '\t');

    // This app's text export: a header line, then a "----   ------" line that marks each column.
    const dashIdx = lines.findIndex((l) => /^-+( +-+)+\s*$/.test(l));
    if (dashIdx > 0) {
      const spans = [...lines[dashIdx].matchAll(/-+/g)].map((m) => m.index);
      const cut = (line) => spans.map((start, i) => line.slice(start, spans[i + 1] ?? line.length).trim());
      const body = lines.slice(dashIdx + 1).filter((l) => l.trim());
      return [cut(lines[dashIdx - 1]), ...body.map(cut)];
    }

    // Anything else: columns separated by 2+ spaces.
    return lines.filter((l) => l.trim()).map((l) => l.trim().split(/ {2,}/));
  }

  // ---------- XLSX ----------

  async function readXlsx(buffer) {
    const files = unzipIndex(buffer);
    const text = async (path) => {
      const entry = files.get(path);
      return entry ? new TextDecoder().decode(await inflate(entry)) : null;
    };
    const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
    const all = (doc, tag) => [...doc.getElementsByTagNameNS('*', tag)];

    // First sheet: workbook.xml → its relationship → worksheet path.
    const workbook = xml((await text('xl/workbook.xml')) || '');
    const firstSheet = all(workbook, 'sheet')[0];
    if (!firstSheet) throw new Error('This Excel file has no sheets.');
    const relId = firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rels = xml((await text('xl/_rels/workbook.xml.rels')) || '');
    const rel = all(rels, 'Relationship').find((r) => r.getAttribute('Id') === relId);
    let target = rel ? rel.getAttribute('Target') : 'worksheets/sheet1.xml';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

    const sharedXml = await text('xl/sharedStrings.xml');
    const shared = sharedXml ? all(xml(sharedXml), 'si').map((si) => all(si, 't').map((t) => t.textContent).join('')) : [];

    const sheet = xml((await text(target)) || '');
    const rows = [];
    for (const rowEl of all(sheet, 'row')) {
      const r = Number(rowEl.getAttribute('r')) - 1;
      const row = [];
      for (const c of all(rowEl, 'c')) {
        const ref = c.getAttribute('r') || '';
        const col = colIndex(ref.replace(/\d+/g, ''));
        const type = c.getAttribute('t');
        const v = all(c, 'v')[0]?.textContent ?? '';
        let value;
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = all(c, 't').map((t) => t.textContent).join('');
        else if (type === 'str' || type === 'b' || type === 'e') value = v;
        else value = v === '' ? '' : Number(v);
        row[col] = value;
      }
      rows[Number.isFinite(r) && r >= 0 ? r : rows.length] = Array.from(row, (v) => v ?? '');
    }
    return rows.filter((r) => r && r.some((v) => String(v).trim() !== ''));
  }

  const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

  /** Reads the zip's central directory → Map(path → { method, data }). */
  function unzipIndex(buffer) {
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("This doesn't look like an Excel (.xlsx) file.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();
    for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      files.set(name, { method, data: new Uint8Array(buffer, start, size) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  async function inflate({ method, data }) {
    if (method === 0) return data; // stored
    if (method !== 8) throw new Error('This Excel file uses an unsupported compression.');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error("This browser can't open .xlsx files. Save the sheet as CSV and import that instead.");
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // A line that is only a date: "01/09/2026", "1-9-26", "2026-09-01", "1 Sep 2026", "Mon, 1/09/26".
  const DATE_LINE =
    /^\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s+[a-z]{3,9},?\s+\d{2,4}|[a-z]{3,9}\s+\d{1,2},?\s+\d{4})\s*:?\s*$/i;

  /** Splits "10:30am, 50,000, Salary Received, Bank Transfer" on commas, keeping "50,000" together. */
  function splitEntryLine(line) {
    if (line.includes('\t')) return line.split('\t').map((s) => s.trim());
    if (line.includes(',')) {
      // "quoted, fields" keep their commas; elsewhere split on commas, keeping "50,000" together.
      const parts = line.match(/"(?:[^"]|"")*"|[^"]+/g) || [];
      return parts
        .flatMap((p) => (p.startsWith('"') ? [{ q: p.slice(1, -1).replace(/""/g, '"') }] : p.split(/\s*,\s+|\s*,(?=\D)/)))
        .map((s) => (typeof s === 'string' ? s.trim() : s.q.trim()))
        .filter((s) => s !== '');
    }
    const parts = line.trim().split(/ {2,}/);
    if (parts.length > 1) return parts;
    // "10:30am 50000 Salary" or "50000 Salary": optional time, amount, then the rest.
    const m = line.trim().match(/^(\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?\s+)?([-+−]?\s*(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d+)?(?:\s*(?:cr|dr)\.?(?=\s))?)\s+(.*)$/i);
    return m ? [m[1]?.trim() ?? '', m[2], m[3]].filter((s, i) => i > 0 || s) : [line.trim()];
  }

  /**
   * Day blocks: a date on its own line, then that day's entries (one per line) until the next date.
   *   01/09/2026
   *   10:30am, 50000, Salary Received, Bank Transfer
   * Each entry becomes [date, ...its fields].
   */
  function readDayBlocks(lines) {
    const rows = [];
    let date = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (DATE_LINE.test(line)) date = line.replace(/:\s*$/, '');
      else if (date) rows.push([date, ...splitEntryLine(line)]);
    }
    return rows;
  }

  /** Pasted text: rows copied from Excel / Sheets (tabs), this app's text export, CSV, day blocks, or simple lines. */
  function readText(raw) {
    const text = String(raw).replace(/^﻿/, '').trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const dateLines = lines.filter((l) => DATE_LINE.test(l)).length;
    if (dateLines && lines.some((l) => l.trim() && !DATE_LINE.test(l))) return readDayBlocks(lines);
    if (text.includes('\t')) return parseDelimited(text, '\t');
    if (/^-+( +-+)+\s*$/m.test(text)) return parseText(text);
    const delimiter = guessDelimiter(text);
    const firstLine = text.split(/\r?\n/, 1)[0];
    if (firstLine.includes(delimiter) && /[;,]/.test(delimiter)) return parseDelimited(text, delimiter);
    // Lines like "13/10/2026 540 Petrol" (single spaces): date, amount, then the rest.
    return parseText(text).map((row) => {
      if (row.length > 1) return row;
      const m = row[0].match(/^(\S+(?:\s+\d{1,2}:\d{2}\s*(?:[ap]m)?)?)\s+([-+−]?\s*(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d+)?(?:\s*(?:cr|dr)\.?(?=\s))?)\s+(.*)$/i);
      return m ? [m[1], m[2], m[3]] : row;
    });
  }

  return { readTable, readText, parseDelimited, parseText };
})();
