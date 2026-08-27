'use strict';
// Lector/escritor minimalista de archivos .xlsx (formato ZIP + SpreadsheetML)
// sin dependencias externas, usando solo node:zlib para (des)compresión.
const zlib = require('node:zlib');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- ZIP writer (metodo store, sin compresion) ----------
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// ---------- ZIP reader ----------
function readZip(buf) {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Archivo ZIP/XLSX invalido');
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const files = {};
  let ptr = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    // leer header local para saber donde empieza la data real
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = compData;
    else if (method === 8) data = zlib.inflateRawSync(compData);
    else data = compData;
    files[name] = data;
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- Generacion de SpreadsheetML minimo ----------
function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function colLetter(n) {
  let s = '';
  n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function sheetToXml(headers, rows) {
  const allRows = [headers, ...rows];
  const rowsXml = allRows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = `${colLetter(ci)}${ri + 1}`;
      if (val === null || val === undefined || val === '') return `<c r="${ref}" t="inlineStr"><is><t></t></is></c>`;
      if (typeof val === 'number' && Number.isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

// sheets: [{ name, headers, rows }]
function writeXlsxMultiSheet(sheets) {
  const contentTypesSheets = sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${contentTypesSheets}
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const sheetTags = sheets.map((s, i) => `<sheet name="${xmlEscape(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets>
</workbook>`;
  const workbookRelsTags = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${workbookRelsTags}
</Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
  ];
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetToXml(s.headers, s.rows), 'utf8') });
  });
  return buildZip(files);
}

function writeXlsx(sheetName, headers, rows) {
  return writeXlsxMultiSheet([{ name: sheetName, headers, rows }]);
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsxFirstSheetAsObjects(buf) {
  const files = readZip(buf);
  const sheetXml = files['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('El archivo .xlsx no contiene una hoja valida');
  const xml = sheetXml.toString('utf8');

  let sharedStrings = [];
  if (files['xl/sharedStrings.xml']) {
    const ssXml = files['xl/sharedStrings.xml'].toString('utf8');
    const siMatches = ssXml.match(/<si[\s\S]*?<\/si>/g) || [];
    sharedStrings = siMatches.map((si) => {
      const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      return parts.map((p) => p.replace(/<[^>]+>/g, '')).join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    });
  }

  const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
  const grid = [];
  for (const rowXml of rowMatches) {
    const rowNumMatch = rowXml.match(/<row r="(\d+)"/);
    const rowNum = rowNumMatch ? parseInt(rowNumMatch[1], 10) : grid.length + 1;
    const cellMatches = rowXml.match(/<c [^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    const rowArr = [];
    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/r="([A-Z]+)(\d+)"/);
      const colIdx = refMatch ? colToIndex(refMatch[1]) : rowArr.length;
      const typeMatch = cellXml.match(/t="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : 'n';
      let value = '';
      if (type === 'inlineStr') {
        const t = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = t ? t[1] : '';
      } else if (type === 's') {
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? (sharedStrings[parseInt(v[1], 10)] || '') : '';
      } else {
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? v[1] : '';
      }
      value = value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      rowArr[colIdx] = value;
    }
    grid[rowNum - 1] = rowArr;
  }
  const rows = grid.filter(Boolean);
  if (!rows.length) return [];
  const headers = (rows[0] || []).map((h) => (h || '').trim());
  return rows.slice(1).filter((r) => r && r.some((v) => v !== undefined && v !== '')).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

module.exports = { writeXlsx, writeXlsxMultiSheet, readXlsxFirstSheetAsObjects, crc32 };
