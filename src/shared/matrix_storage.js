import { get, set } from "./storage.js";
import { makeId } from "./models.js";
import { buildCanonicalPaperKey, buildTitleFingerprint, normalizeArxivId, normalizeDoi } from "./paper_identity.js";

const MATRIX_TEMPLATES_BY_ID_KEY = "matrixTemplatesById";
const PROJECT_MATRICES_BY_PROJECT_ID_KEY = "projectMatricesByProjectId";

const MATRIX_COLUMN_TYPES = new Set(["categorical", "numeric", "boolean", "text"]);
const MATRIX_AUTO_FILL_STATES = new Set(["queued", "running", "done", "pending_source", "failed"]);
const MATRIX_VERIFY_STATES = new Set(["fresh", "stale", "error"]);

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncateText(value, maxLength = 220) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength).trim();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function normalizeOptionalTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function normalizeStringList(value, maxItems = 32, maxLength = 120) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => truncateText(item, maxLength))
    .filter(Boolean)
    .slice(0, Math.max(0, maxItems));
}

function normalizeCell(entry) {
  const source = ensureObject(entry);
  return {
    value: typeof source.value === "number" ? source.value : truncateText(String(source.value ?? ""), 420),
    source: source.source === "manual" ? "manual" : "auto",
    locked: Boolean(source.locked),
    confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0)),
    evidenceSnippet: truncateText(source.evidenceSnippet, 320),
    evidencePage: Number.isFinite(Number(source.evidencePage)) ? Math.max(0, Math.floor(Number(source.evidencePage))) : null,
    insufficientReason: truncateText(source.insufficientReason, 180),
    updatedAt: normalizeTimestamp(source.updatedAt, Date.now()),
    stale: Boolean(source.stale)
  };
}

function normalizeCellsByColumnId(value) {
  const source = ensureObject(value);
  const next = {};
  for (const [columnId, entry] of Object.entries(source)) {
    const normalizedId = truncateText(columnId, 80);
    if (!normalizedId) {
      continue;
    }
    next[normalizedId] = normalizeCell(entry);
  }
  return next;
}

function normalizeHiddenFeatureValue(entry) {
  const source = ensureObject(entry);
  return {
    tags: normalizeStringList(source.tags, 6, 60),
    updatedAt: normalizeTimestamp(source.updatedAt, Date.now())
  };
}

function normalizeHiddenFeaturesByColumnId(value) {
  const source = ensureObject(value);
  const next = {};
  for (const [columnId, entry] of Object.entries(source)) {
    const normalizedId = truncateText(columnId, 80);
    if (!normalizedId) {
      continue;
    }
    next[normalizedId] = normalizeHiddenFeatureValue(entry);
  }
  return next;
}

function normalizeMatrixColumn(column) {
  const source = ensureObject(column);
  const type = MATRIX_COLUMN_TYPES.has(source.type) ? source.type : "categorical";
  return {
    id: truncateText(source.id, 80) || makeId("col"),
    label: truncateText(source.label, 120) || "Untitled Column",
    type,
    description: truncateText(source.description, 220),
    suggestedOptions: normalizeStringList(source.suggestedOptions, 40, 80),
    clusterEnabled: source.clusterEnabled !== false,
    hidden: Boolean(source.hidden),
    deletedAt: normalizeOptionalTimestamp(source.deletedAt),
    deletedBy: truncateText(source.deletedBy, 80)
  };
}

function normalizeMatrixColumns(columns) {
  const source = Array.isArray(columns) ? columns : [];
  const seen = new Set();
  const normalized = [];
  for (const raw of source) {
    const column = normalizeMatrixColumn(raw);
    if (!column.id || seen.has(column.id)) {
      continue;
    }
    seen.add(column.id);
    normalized.push(column);
  }
  return normalized.slice(0, 120);
}

function normalizeSheetSyncState(entry) {
  const source = ensureObject(entry);
  return {
    autoSync: Boolean(source.autoSync),
    spreadsheetId: truncateText(source.spreadsheetId, 120),
    spreadsheetName: truncateText(source.spreadsheetName, 180),
    sheetId: Number.isFinite(Number(source.sheetId)) ? Math.floor(Number(source.sheetId)) : null,
    sheetTitle: truncateText(source.sheetTitle, 120),
    lastSyncAt: Number.isFinite(Number(source.lastSyncAt)) ? Math.floor(Number(source.lastSyncAt)) : null,
    lastSyncReport: {
      successCount: Number.isFinite(Number(source.lastSyncReport?.successCount))
        ? Math.max(0, Math.floor(Number(source.lastSyncReport.successCount)))
        : 0,
      failureCount: Number.isFinite(Number(source.lastSyncReport?.failureCount))
        ? Math.max(0, Math.floor(Number(source.lastSyncReport.failureCount)))
        : 0,
      errors: normalizeStringList(source.lastSyncReport?.errors, 50, 220)
    }
  };
}

function normalizeClusterState(entry) {
  const source = ensureObject(entry);
  const pointsByRowIdSource = ensureObject(source.pointsByRowId);
  const assignmentsByRowIdSource = ensureObject(source.assignmentsByRowId);
  const pointsByRowId = {};
  const assignmentsByRowId = {};
  for (const [rowId, rawPoint] of Object.entries(pointsByRowIdSource)) {
    const normalizedRowId = truncateText(rowId, 80);
    if (!normalizedRowId) {
      continue;
    }
    const point = ensureObject(rawPoint);
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    pointsByRowId[normalizedRowId] = { x, y };
  }
  for (const [rowId, rawCluster] of Object.entries(assignmentsByRowIdSource)) {
    const normalizedRowId = truncateText(rowId, 80);
    const clusterId = Number(rawCluster);
    if (!normalizedRowId || !Number.isFinite(clusterId)) {
      continue;
    }
    assignmentsByRowId[normalizedRowId] = Math.max(0, Math.floor(clusterId));
  }
  return {
    dataHash: truncateText(source.dataHash, 120),
    featureColumnIds: normalizeStringList(source.featureColumnIds, 120, 80),
    k: Number.isFinite(Number(source.k)) ? Math.max(0, Math.floor(Number(source.k))) : 0,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Math.floor(Number(source.updatedAt)) : null,
    pointsByRowId,
    assignmentsByRowId
  };
}

function normalizeMatrixRow(row, requiredProjectId = "") {
  const source = ensureObject(row);
  const autoFillState = MATRIX_AUTO_FILL_STATES.has(source.autoFillState) ? source.autoFillState : "queued";
  const verificationState = MATRIX_VERIFY_STATES.has(source.verificationState) ? source.verificationState : "stale";
  const now = Date.now();
  const paperKey = truncateText(source.paperKey, 420) || buildCanonicalPaperKey(source);
  return {
    id: truncateText(source.id, 80) || makeId("mrow"),
    projectId: truncateText(source.projectId, 120) || requiredProjectId,
    paperId: truncateText(source.paperId, 120),
    paperTitle: truncateText(source.paperTitle || source.title, 260),
    paperKey,
    paperDoi: normalizeDoi(source.paperDoi || source.doi),
    paperArxivId: normalizeArxivId(source.paperArxivId || source.arxivId),
    paperUrl: truncateText(source.paperUrl || source.url, 2200),
    paperTitleFingerprint: truncateText(source.paperTitleFingerprint, 220) || buildTitleFingerprint(source.paperTitle || source.title),
    autoFillState,
    verificationState,
    cellsByColumnId: normalizeCellsByColumnId(source.cellsByColumnId),
    hiddenFeaturesByColumnId: normalizeHiddenFeaturesByColumnId(source.hiddenFeaturesByColumnId),
    hidden: Boolean(source.hidden),
    deletedAt: normalizeOptionalTimestamp(source.deletedAt),
    deletedBy: truncateText(source.deletedBy, 80),
    updatedAt: normalizeTimestamp(source.updatedAt, now),
    lastVerifiedAt: Number.isFinite(Number(source.lastVerifiedAt)) ? Math.floor(Number(source.lastVerifiedAt)) : null
  };
}

function normalizeMatrixRows(rows, projectId) {
  const source = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const normalized = [];
  for (const raw of source) {
    const row = normalizeMatrixRow(raw, projectId);
    if (!row.id || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    normalized.push(row);
  }
  return normalized.slice(0, 1200);
}

function defaultProjectMatrix(projectId) {
  return {
    projectId,
    templateId: "",
    columns: [
      {
        id: "paper_key",
        label: "Paper Key",
        type: "text",
        description: "Canonical paper identifier",
        suggestedOptions: [],
        clusterEnabled: false
      }
    ],
    rows: [],
    sheetsSync: normalizeSheetSyncState({}),
    clusterState: normalizeClusterState({}),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function normalizeProjectMatrix(entry, requiredProjectId = "") {
  const source = ensureObject(entry);
  const projectId = truncateText(source.projectId, 120) || requiredProjectId;
  const now = Date.now();
  const createdAt = normalizeTimestamp(source.createdAt, now);
  const updatedAt = normalizeTimestamp(source.updatedAt, now);
  const columns = normalizeMatrixColumns(source.columns);
  const ensuredColumns = columns.some((column) => column.id === "paper_key")
    ? columns
    : [
        {
          id: "paper_key",
          label: "Paper Key",
          type: "text",
          description: "Canonical paper identifier",
          suggestedOptions: [],
          clusterEnabled: false
        },
        ...columns
      ];
  return {
    projectId,
    templateId: truncateText(source.templateId, 120),
    columns: ensuredColumns,
    rows: normalizeMatrixRows(source.rows, projectId),
    sheetsSync: normalizeSheetSyncState(source.sheetsSync),
    clusterState: normalizeClusterState(source.clusterState),
    createdAt,
    updatedAt
  };
}

function normalizeMatrixTemplate(entry) {
  const source = ensureObject(entry);
  const now = Date.now();
  const createdAt = normalizeTimestamp(source.createdAt, now);
  const updatedAt = normalizeTimestamp(source.updatedAt, now);
  return {
    id: truncateText(source.id, 120) || makeId("mtpl"),
    name: truncateText(source.name, 120) || "Untitled template",
    columns: normalizeMatrixColumns(source.columns),
    createdAt,
    updatedAt
  };
}

async function getMatrixTemplatesByIdMap() {
  const values = await get({ [MATRIX_TEMPLATES_BY_ID_KEY]: {} });
  const source = ensureObject(values?.[MATRIX_TEMPLATES_BY_ID_KEY]);
  const next = {};
  for (const [id, entry] of Object.entries(source)) {
    const normalizedId = truncateText(id, 120);
    if (!normalizedId) {
      continue;
    }
    next[normalizedId] = normalizeMatrixTemplate({ ...(ensureObject(entry)), id: normalizedId });
  }
  return next;
}

async function getProjectMatricesByProjectMap() {
  const values = await get({ [PROJECT_MATRICES_BY_PROJECT_ID_KEY]: {} });
  const source = ensureObject(values?.[PROJECT_MATRICES_BY_PROJECT_ID_KEY]);
  const next = {};
  for (const [projectId, entry] of Object.entries(source)) {
    const normalizedProjectId = truncateText(projectId, 120);
    if (!normalizedProjectId) {
      continue;
    }
    next[normalizedProjectId] = normalizeProjectMatrix(entry, normalizedProjectId);
  }
  return next;
}

export async function listMatrixTemplates() {
  const templatesById = await getMatrixTemplatesByIdMap();
  return Object.values(templatesById).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function getMatrixTemplateById(templateId) {
  const normalizedTemplateId = truncateText(templateId, 120);
  if (!normalizedTemplateId) {
    return null;
  }
  const templatesById = await getMatrixTemplatesByIdMap();
  return templatesById[normalizedTemplateId] || null;
}

export async function saveMatrixTemplate(partial) {
  const now = Date.now();
  const templatesById = await getMatrixTemplatesByIdMap();
  const incoming = ensureObject(partial);
  const id = truncateText(incoming.id, 120) || makeId("mtpl");
  const existing = templatesById[id];
  const nextTemplate = normalizeMatrixTemplate({
    ...(existing || {}),
    ...incoming,
    id,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  });
  templatesById[id] = nextTemplate;
  const didPersist = await set({ [MATRIX_TEMPLATES_BY_ID_KEY]: templatesById });
  return didPersist ? nextTemplate : existing || null;
}

export async function removeMatrixTemplate(templateId) {
  const normalizedTemplateId = truncateText(templateId, 120);
  if (!normalizedTemplateId) {
    return false;
  }
  const templatesById = await getMatrixTemplatesByIdMap();
  if (!(normalizedTemplateId in templatesById)) {
    return true;
  }
  delete templatesById[normalizedTemplateId];
  return set({ [MATRIX_TEMPLATES_BY_ID_KEY]: templatesById });
}

export async function getProjectMatrix(projectId) {
  const normalizedProjectId = truncateText(projectId, 120);
  if (!normalizedProjectId) {
    return null;
  }
  const matricesByProject = await getProjectMatricesByProjectMap();
  return matricesByProject[normalizedProjectId] || defaultProjectMatrix(normalizedProjectId);
}

export async function setProjectMatrix(projectId, entry) {
  const normalizedProjectId = truncateText(projectId, 120);
  if (!normalizedProjectId) {
    return null;
  }
  const matricesByProject = await getProjectMatricesByProjectMap();
  const existing = matricesByProject[normalizedProjectId];
  const now = Date.now();
  const nextMatrix = normalizeProjectMatrix(
    {
      ...(existing || defaultProjectMatrix(normalizedProjectId)),
      ...(ensureObject(entry) || {}),
      projectId: normalizedProjectId,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    },
    normalizedProjectId
  );
  matricesByProject[normalizedProjectId] = nextMatrix;
  const didPersist = await set({ [PROJECT_MATRICES_BY_PROJECT_ID_KEY]: matricesByProject });
  return didPersist ? nextMatrix : existing || null;
}

export async function setProjectMatrixColumns(projectId, columns, options = {}) {
  const matrix = await getProjectMatrix(projectId);
  if (!matrix) {
    return null;
  }
  const nextColumns = normalizeMatrixColumns(columns);
  return setProjectMatrix(projectId, {
    ...matrix,
    templateId: options.templateId === undefined ? matrix.templateId : truncateText(options.templateId, 120),
    columns: nextColumns
  });
}

export async function upsertProjectMatrixRow(projectId, partialRow) {
  const matrix = await getProjectMatrix(projectId);
  if (!matrix) {
    return null;
  }
  const incoming = normalizeMatrixRow(partialRow, matrix.projectId);
  if (!incoming.paperKey) {
    incoming.paperKey = buildCanonicalPaperKey(incoming);
  }
  const existingIndex = matrix.rows.findIndex(
    (row) =>
      (incoming.id && row.id === incoming.id) ||
      (incoming.paperId && row.paperId === incoming.paperId) ||
      (incoming.paperKey && row.paperKey && row.paperKey === incoming.paperKey)
  );
  const now = Date.now();
  if (existingIndex >= 0) {
    const existing = matrix.rows[existingIndex];
    const merged = normalizeMatrixRow(
      {
        ...existing,
        ...incoming,
        id: existing.id,
        projectId: matrix.projectId,
        updatedAt: now
      },
      matrix.projectId
    );
    const nextRows = [...matrix.rows];
    nextRows[existingIndex] = merged;
    const updated = await setProjectMatrix(matrix.projectId, { ...matrix, rows: nextRows, updatedAt: now });
    return updated ? merged : existing;
  }
  const created = normalizeMatrixRow(
    {
      ...incoming,
      id: incoming.id || makeId("mrow"),
      projectId: matrix.projectId,
      updatedAt: now
    },
    matrix.projectId
  );
  const updated = await setProjectMatrix(matrix.projectId, { ...matrix, rows: [created, ...matrix.rows], updatedAt: now });
  return updated ? created : null;
}

export async function removeProjectMatrixRow(projectId, rowId) {
  const matrix = await getProjectMatrix(projectId);
  const normalizedRowId = truncateText(rowId, 80);
  if (!matrix || !normalizedRowId) {
    return false;
  }
  const nextRows = matrix.rows.filter((row) => row.id !== normalizedRowId);
  if (nextRows.length === matrix.rows.length) {
    return false;
  }
  const updated = await setProjectMatrix(matrix.projectId, { ...matrix, rows: nextRows, updatedAt: Date.now() });
  return Boolean(updated);
}

export async function clearProjectMatrix(projectId) {
  const matrix = await getProjectMatrix(projectId);
  if (!matrix) {
    return false;
  }
  const updated = await setProjectMatrix(matrix.projectId, { ...matrix, rows: [], clusterState: normalizeClusterState({}) });
  return Boolean(updated);
}

export function buildMatrixCellPatch({ value, source = "auto", locked = false, confidence = 0, evidenceSnippet = "", evidencePage = null, insufficientReason = "", stale = false }) {
  return normalizeCell({
    value,
    source,
    locked,
    confidence,
    evidenceSnippet,
    evidencePage,
    insufficientReason,
    stale,
    updatedAt: Date.now()
  });
}
