function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function uniqueStrings(values) {
  const map = new Map();
  for (const value of values) {
    const text = String(value ?? "");
    if (!map.has(text)) {
      map.set(text, map.size);
    }
  }
  return map;
}

function colRef(columnIndex) {
  let index = columnIndex + 1;
  let label = "";
  while (index > 0) {
    const mod = (index - 1) % 26;
    label = String.fromCharCode(65 + mod) + label;
    index = Math.floor((index - 1) / 26);
  }
  return label;
}

function buildSheetXml(rows, sharedStrings) {
  const rowXml = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const cells = [];
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const raw = row[colIndex] ?? "";
      const text = String(raw);
      const sharedIndex = sharedStrings.get(text);
      const cellRef = `${colRef(colIndex)}${rowIndex + 1}`;
      if (sharedIndex == null) {
        continue;
      }
      cells.push(`<c r="${cellRef}" t="s"><v>${sharedIndex}</v></c>`);
    }
    rowXml.push(`<row r="${rowIndex + 1}">${cells.join("")}</row>`);
  }
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
    `<sheetData>${rowXml.join("")}</sheetData>`,
    `</worksheet>`
  ].join("");
}

function buildSharedStringsXml(sharedStrings) {
  const entries = [...sharedStrings.entries()].sort((left, right) => left[1] - right[1]);
  const si = entries.map(([value]) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join("");
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${entries.length}" uniqueCount="${entries.length}">${si}</sst>`
  ].join("");
}

function textEncoder(value) {
  return new TextEncoder().encode(value);
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function zipStore(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder(file.name);
    const dataBytes = file.data;
    const crc = crc32(dataBytes);
    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const localView = new DataView(localHeader);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, dataBytes.length);
    writeUint32(localView, 22, dataBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    new Uint8Array(localHeader, 30).set(nameBytes);
    localChunks.push(new Uint8Array(localHeader), dataBytes);

    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const centralView = new DataView(centralHeader);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, dataBytes.length);
    writeUint32(centralView, 24, dataBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    new Uint8Array(centralHeader, 46).set(nameBytes);
    centralChunks.push(new Uint8Array(centralHeader));

    offset += localHeader.byteLength + dataBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const chunk of centralChunks) {
    centralSize += chunk.length;
  }
  offset += centralSize;

  const end = new ArrayBuffer(22);
  const endView = new DataView(end);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, centralOffset);
  writeUint16(endView, 20, 0);

  return new Blob([...localChunks, ...centralChunks, new Uint8Array(end)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

export function buildXlsxBlob(rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const sheetNameRaw = typeof options.sheetName === "string" ? options.sheetName : "Matrix";
  const sheetName = escapeXml(sheetNameRaw.slice(0, 31) || "Matrix");
  const allValues = safeRows.flatMap((row) => (Array.isArray(row) ? row : []).map((value) => String(value ?? "")));
  const sharedStrings = uniqueStrings(allValues);
  const files = [
    {
      name: "[Content_Types].xml",
      data: textEncoder(
        [
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
          `<Default Extension="xml" ContentType="application/xml"/>`,
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
          `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`,
          `</Types>`
        ].join("")
      )
    },
    {
      name: "_rels/.rels",
      data: textEncoder(
        [
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`,
          `</Relationships>`
        ].join("")
      )
    },
    {
      name: "xl/workbook.xml",
      data: textEncoder(
        [
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
          `<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>`,
          `</workbook>`
        ].join("")
      )
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: textEncoder(
        [
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`,
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
          `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
          `</Relationships>`
        ].join("")
      )
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: textEncoder(buildSheetXml(safeRows, sharedStrings))
    },
    {
      name: "xl/styles.xml",
      data: textEncoder(
        [
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
          `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
          `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
          `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`,
          `<borders count="1"><border/></borders>`,
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`,
          `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>`,
          `</styleSheet>`
        ].join("")
      )
    },
    {
      name: "xl/sharedStrings.xml",
      data: textEncoder(buildSharedStringsXml(sharedStrings))
    }
  ];
  return zipStore(files);
}

