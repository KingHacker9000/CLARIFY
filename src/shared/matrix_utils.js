import { buildCanonicalPaperKey, buildTitleFingerprint, normalizeArxivId, normalizeDoi, normalizePaperUrl } from "./paper_identity.js";

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function computeMatrixDataHash(value) {
  return stableHash(value);
}

export function parseCsvRows(csvText) {
  const text = typeof csvText === "string" ? csvText.replace(/\r\n?/g, "\n") : "";
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
        continue;
      }
      if (char === "\"") {
        inQuotes = false;
        continue;
      }
      cell += char;
      continue;
    }
    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function csvEncode(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

export function serializeCsv(headers, rows) {
  const safeHeaders = Array.isArray(headers) ? headers : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const lines = [safeHeaders.map((item) => csvEncode(item)).join(",")];
  for (const row of safeRows) {
    const source = Array.isArray(row) ? row : [];
    lines.push(source.map((item) => csvEncode(item)).join(","));
  }
  return lines.join("\n");
}

function normalizeImportedValue(value) {
  const normalized = normalizeText(value);
  return normalized;
}

function inferColumnTypeFromValues(values) {
  const nonEmpty = values.map((value) => normalizeImportedValue(value)).filter(Boolean).slice(0, 80);
  if (nonEmpty.length === 0) {
    return "categorical";
  }
  let numericCount = 0;
  let booleanCount = 0;
  for (const value of nonEmpty) {
    const lower = value.toLowerCase();
    if (["yes", "no", "true", "false", "0", "1"].includes(lower)) {
      booleanCount += 1;
    }
    if (Number.isFinite(Number(value))) {
      numericCount += 1;
    }
  }
  const numericRatio = numericCount / nonEmpty.length;
  const boolRatio = booleanCount / nonEmpty.length;
  if (boolRatio >= 0.8) {
    return "boolean";
  }
  if (numericRatio >= 0.8) {
    return "numeric";
  }
  const distinctCount = new Set(nonEmpty.map((value) => value.toLowerCase())).size;
  if (distinctCount <= Math.max(6, Math.floor(nonEmpty.length * 0.4))) {
    return "categorical";
  }
  return "text";
}

export function importCsvToMatrixSeed(csvText) {
  const rows = parseCsvRows(csvText);
  if (!rows.length) {
    return { columns: [], rowObjects: [] };
  }
  const header = (rows[0] || []).map((item) => normalizeText(item));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => normalizeText(cell)));
  const columns = header
    .map((label, index) => {
      const values = dataRows.map((row) => row[index] ?? "");
      const inferredType = inferColumnTypeFromValues(values);
      const suggestedOptions =
        inferredType === "categorical" || inferredType === "boolean"
          ? [...new Set(values.map((item) => normalizeImportedValue(item)).filter(Boolean))].slice(0, 30)
          : [];
      return {
        id: `col_${index + 1}_${stableHash(label || index)}`,
        label: label || `Column ${index + 1}`,
        type: inferredType,
        suggestedOptions,
        clusterEnabled: inferredType !== "text"
      };
    })
    .filter((column) => column.label);
  const rowObjects = dataRows.map((row, rowIndex) => {
    const cellsByColumnId = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const rawValue = row[index] ?? "";
      const normalized = normalizeImportedValue(rawValue);
      if (!normalized) {
        continue;
      }
      cellsByColumnId[column.id] = {
        value: normalized,
        source: "manual",
        locked: true,
        confidence: 1,
        evidenceSnippet: "",
        evidencePage: null,
        insufficientReason: "",
        updatedAt: Date.now(),
        stale: false
      };
    }
    return {
      id: `seed_${rowIndex + 1}_${stableHash(JSON.stringify(row))}`,
      cellsByColumnId
    };
  });
  return { columns, rowObjects };
}

function normalizeMatrixCellString(value) {
  if (typeof value === "number") {
    return String(value);
  }
  return normalizeText(value);
}

export function buildMatrixExportRows(matrix, rows) {
  const safeMatrix = matrix && typeof matrix === "object" ? matrix : { columns: [] };
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => !row?.deletedAt && !row?.hidden);
  const columns = (Array.isArray(safeMatrix.columns) ? safeMatrix.columns : []).filter(
    (column) => !column?.deletedAt && !column?.hidden
  );
  const headers = [
    "Paper Key",
    "Paper Title",
    "DOI",
    "arXiv",
    "URL",
    ...columns
      .filter((column) => column.id !== "paper_key")
      .map((column) => column.label),
    "Auto Fill State",
    "Verification State"
  ];
  const dataRows = safeRows.map((row) => {
    const values = [
      row.paperKey || "",
      row.paperTitle || "",
      row.paperDoi || "",
      row.paperArxivId || "",
      row.paperUrl || ""
    ];
    for (const column of columns) {
      if (column.id === "paper_key") {
        continue;
      }
      const cell = row.cellsByColumnId?.[column.id];
      values.push(normalizeMatrixCellString(cell?.value || ""));
    }
    values.push(row.autoFillState || "");
    values.push(row.verificationState || "");
    return values;
  });
  return { headers, rows: dataRows };
}

function toFloat(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseBoolean(value) {
  const normalized = normalizeText(String(value ?? "")).toLowerCase();
  if (["true", "yes", "1", "y"].includes(normalized)) {
    return 1;
  }
  if (["false", "no", "0", "n"].includes(normalized)) {
    return 0;
  }
  return 0;
}

function columnFeatureKey(columnId, value) {
  return `${columnId}::${String(value).toLowerCase()}`;
}

function getTextHiddenTags(row, columnId) {
  const hidden = row.hiddenFeaturesByColumnId?.[columnId];
  const tags = Array.isArray(hidden?.tags) ? hidden.tags : [];
  return tags.map((tag) => normalizeText(tag).toLowerCase()).filter(Boolean).slice(0, 6);
}

function buildFeatureSpace(matrix, rows, featureColumnIds) {
  const columnsById = new Map((Array.isArray(matrix?.columns) ? matrix.columns : []).map((column) => [column.id, column]));
  const selectedIds = (Array.isArray(featureColumnIds) ? featureColumnIds : [])
    .map((id) => normalizeText(id))
    .filter((id) => columnsById.has(id) && id !== "paper_key");
  const categoricalVocabulary = new Map();
  const featureNames = [];

  for (const columnId of selectedIds) {
    const column = columnsById.get(columnId);
    if (!column) {
      continue;
    }
    if (column.type === "numeric" || column.type === "boolean") {
      featureNames.push(`${columnId}:value`);
      continue;
    }
    const seenValues = new Set();
    for (const row of rows) {
      const cell = row.cellsByColumnId?.[columnId];
      if (column.type === "text") {
        for (const tag of getTextHiddenTags(row, columnId)) {
          seenValues.add(tag);
        }
      } else {
        const normalized = normalizeText(String(cell?.value ?? "")).toLowerCase();
        if (normalized) {
          seenValues.add(normalized);
        }
      }
    }
    const vocab = [...seenValues].slice(0, 120);
    categoricalVocabulary.set(columnId, vocab);
    for (const token of vocab) {
      featureNames.push(columnFeatureKey(columnId, token));
    }
  }

  const data = rows.map((row) => {
    const vector = [];
    for (const columnId of selectedIds) {
      const column = columnsById.get(columnId);
      const cell = row.cellsByColumnId?.[columnId];
      if (!column) {
        continue;
      }
      if (column.type === "numeric") {
        vector.push(toFloat(cell?.value));
        continue;
      }
      if (column.type === "boolean") {
        vector.push(parseBoolean(cell?.value));
        continue;
      }
      const vocab = categoricalVocabulary.get(columnId) || [];
      if (column.type === "text") {
        const tags = new Set(getTextHiddenTags(row, columnId));
        for (const token of vocab) {
          vector.push(tags.has(token) ? 1 : 0);
        }
        continue;
      }
      const normalized = normalizeText(String(cell?.value ?? "")).toLowerCase();
      for (const token of vocab) {
        vector.push(normalized === token ? 1 : 0);
      }
    }
    return vector;
  });

  return { data, featureNames, selectedColumnIds: selectedIds };
}

function computeColumnStats(matrix) {
  if (!matrix.length) {
    return [];
  }
  const columnCount = matrix[0].length;
  const stats = [];
  for (let column = 0; column < columnCount; column += 1) {
    const values = matrix.map((row) => row[column]);
    const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
    const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
    const std = Math.sqrt(variance) || 1;
    stats.push({ mean, std });
  }
  return stats;
}

function standardizeMatrix(matrix) {
  const stats = computeColumnStats(matrix);
  return matrix.map((row) => row.map((value, index) => (value - stats[index].mean) / stats[index].std));
}

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

function matVecMul(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function normalizeVector(vector) {
  const norm = Math.sqrt(dot(vector, vector)) || 1;
  return vector.map((value) => value / norm);
}

function transpose(matrix) {
  if (!matrix.length) {
    return [];
  }
  const rows = matrix.length;
  const cols = matrix[0].length;
  const out = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out[c][r] = matrix[r][c];
    }
  }
  return out;
}

function matMul(left, right) {
  if (!left.length || !right.length) {
    return [];
  }
  const rows = left.length;
  const inner = left[0].length;
  const cols = right[0].length;
  const out = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r += 1) {
    for (let k = 0; k < inner; k += 1) {
      const value = left[r][k];
      for (let c = 0; c < cols; c += 1) {
        out[r][c] += value * right[k][c];
      }
    }
  }
  return out;
}

function powerIteration(covariance, iterations = 40) {
  const size = covariance.length;
  let vector = Array.from({ length: size }, (_unused, index) => (index === 0 ? 1 : 0.5));
  vector = normalizeVector(vector);
  for (let index = 0; index < iterations; index += 1) {
    const next = matVecMul(covariance, vector);
    vector = normalizeVector(next);
  }
  const eigenValue = dot(vector, matVecMul(covariance, vector));
  return { vector, eigenValue };
}

function deflateCovariance(covariance, eigenVector, eigenValue) {
  const size = covariance.length;
  const out = covariance.map((row) => [...row]);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      out[r][c] -= eigenValue * eigenVector[r] * eigenVector[c];
    }
  }
  return out;
}

function computeCovarianceMatrix(matrix) {
  if (!matrix.length) {
    return [];
  }
  const xt = transpose(matrix);
  const raw = matMul(xt, matrix);
  const divisor = Math.max(1, matrix.length - 1);
  return raw.map((row) => row.map((value) => value / divisor));
}

function projectToPca2(matrix) {
  if (!matrix.length) {
    return [];
  }
  const featureCount = matrix[0].length;
  if (featureCount === 0) {
    return matrix.map((_row, index) => ({ x: index, y: 0 }));
  }
  if (featureCount === 1) {
    return matrix.map((row, index) => ({ x: row[0], y: index * 0.0001 }));
  }
  let covariance = computeCovarianceMatrix(matrix);
  const first = powerIteration(covariance);
  covariance = deflateCovariance(covariance, first.vector, first.eigenValue);
  const second = powerIteration(covariance);
  return matrix.map((row) => ({
    x: dot(row, first.vector),
    y: dot(row, second.vector)
  }));
}

function euclidean(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const diff = left[index] - right[index];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function kmeans(data, k, maxIterations = 24) {
  const safeData = Array.isArray(data) ? data : [];
  if (!safeData.length || k < 1) {
    return { centers: [], assignments: [] };
  }
  const dimensions = safeData[0].length;
  const centers = [];
  for (let index = 0; index < k; index += 1) {
    centers.push([...safeData[index % safeData.length]]);
  }
  let assignments = new Array(safeData.length).fill(0);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let didChange = false;
    assignments = safeData.map((point, pointIndex) => {
      let bestCluster = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
        const distance = euclidean(point, centers[centerIndex]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = centerIndex;
        }
      }
      if (assignments[pointIndex] !== bestCluster) {
        didChange = true;
      }
      return bestCluster;
    });
    const sums = Array.from({ length: k }, () => new Array(dimensions).fill(0));
    const counts = new Array(k).fill(0);
    for (let index = 0; index < safeData.length; index += 1) {
      const cluster = assignments[index];
      counts[cluster] += 1;
      for (let d = 0; d < dimensions; d += 1) {
        sums[cluster][d] += safeData[index][d];
      }
    }
    for (let cluster = 0; cluster < k; cluster += 1) {
      if (counts[cluster] === 0) {
        centers[cluster] = [...safeData[cluster % safeData.length]];
        continue;
      }
      centers[cluster] = sums[cluster].map((value) => value / counts[cluster]);
    }
    if (!didChange) {
      break;
    }
  }
  return { centers, assignments };
}

function silhouetteScore(data, assignments, k) {
  if (!data.length || k <= 1) {
    return 0;
  }
  const byCluster = Array.from({ length: k }, () => []);
  for (let index = 0; index < assignments.length; index += 1) {
    byCluster[assignments[index]].push(index);
  }
  let total = 0;
  for (let index = 0; index < data.length; index += 1) {
    const cluster = assignments[index];
    const ownCluster = byCluster[cluster];
    const point = data[index];
    const a =
      ownCluster.length <= 1
        ? 0
        : ownCluster
            .filter((otherIndex) => otherIndex !== index)
            .reduce((acc, otherIndex) => acc + euclidean(point, data[otherIndex]), 0) / (ownCluster.length - 1);
    let b = Number.POSITIVE_INFINITY;
    for (let otherCluster = 0; otherCluster < byCluster.length; otherCluster += 1) {
      if (otherCluster === cluster || byCluster[otherCluster].length === 0) {
        continue;
      }
      const distance =
        byCluster[otherCluster].reduce((acc, otherIndex) => acc + euclidean(point, data[otherIndex]), 0) /
        byCluster[otherCluster].length;
      if (distance < b) {
        b = distance;
      }
    }
    const denom = Math.max(a, b);
    const score = denom > 0 ? (b - a) / denom : 0;
    total += Number.isFinite(score) ? score : 0;
  }
  return total / data.length;
}

export function runMatrixClustering({ matrix, rows, featureColumnIds }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeRows.length < 3) {
    return {
      ok: false,
      reason: "Need at least 3 rows to run PCA + KMeans clustering.",
      dataHash: computeMatrixDataHash({ rows: safeRows.length, features: featureColumnIds || [] }),
      selectedColumnIds: Array.isArray(featureColumnIds) ? featureColumnIds : []
    };
  }
  const featureSpace = buildFeatureSpace(matrix, safeRows, featureColumnIds);
  if (!featureSpace.data.length || !featureSpace.data[0]?.length) {
    return {
      ok: false,
      reason: "No usable feature data for clustering.",
      dataHash: computeMatrixDataHash({ rows: safeRows.length, features: featureSpace.selectedColumnIds }),
      selectedColumnIds: featureSpace.selectedColumnIds
    };
  }
  const standardized = standardizeMatrix(featureSpace.data);
  const points = projectToPca2(standardized);
  const maxK = Math.min(8, safeRows.length - 1);
  if (maxK < 2) {
    return {
      ok: false,
      reason: "Need at least 3 rows to evaluate silhouette score.",
      dataHash: computeMatrixDataHash({ rows: safeRows.length, features: featureSpace.selectedColumnIds }),
      selectedColumnIds: featureSpace.selectedColumnIds
    };
  }
  let best = null;
  for (let k = 2; k <= maxK; k += 1) {
    const candidate = kmeans(standardized, k);
    const score = silhouetteScore(standardized, candidate.assignments, k);
    if (!best || score > best.score) {
      best = {
        k,
        score,
        assignments: candidate.assignments
      };
    }
  }
  const assignmentsByRowId = {};
  const pointsByRowId = {};
  for (let index = 0; index < safeRows.length; index += 1) {
    const rowId = safeRows[index]?.id;
    if (!rowId) {
      continue;
    }
    assignmentsByRowId[rowId] = best?.assignments?.[index] ?? 0;
    pointsByRowId[rowId] = {
      x: points[index]?.x ?? index,
      y: points[index]?.y ?? 0
    };
  }
  return {
    ok: true,
    k: best?.k ?? 1,
    score: best?.score ?? 0,
    assignmentsByRowId,
    pointsByRowId,
    selectedColumnIds: featureSpace.selectedColumnIds,
    dataHash: computeMatrixDataHash({
      selectedColumnIds: featureSpace.selectedColumnIds,
      featureNames: featureSpace.featureNames,
      rows: standardized
    })
  };
}

export function deriveCanonicalPaperFields(paper) {
  const safePaper = paper && typeof paper === "object" ? paper : {};
  const doi = normalizeDoi(safePaper.doi);
  const arxivId = normalizeArxivId(safePaper.arxivId || safePaper.sourceRef?.url || safePaper.docId);
  const url = normalizePaperUrl(safePaper.sourceRef?.url || safePaper.url || safePaper.docId);
  const titleFingerprint = buildTitleFingerprint(safePaper.title);
  const paperKey =
    buildCanonicalPaperKey({
      doi,
      arxivId,
      url,
      title: safePaper.title,
      docId: safePaper.docId
    }) || `title:${titleFingerprint || stableHash(safePaper.title || safePaper.id || "unknown")}`;
  return {
    paperKey,
    paperDoi: doi,
    paperArxivId: arxivId,
    paperUrl: url,
    paperTitleFingerprint: titleFingerprint
  };
}
