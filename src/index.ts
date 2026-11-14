import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { DEFAULT_TIERS, compareMaps, type CompareResult, type MatchTier, type TableDiff } from "./compare.js";
import {
  parseDatalogCsv,
  isCorruptHighlightStore,
  parseHighlights,
  removeHighlight,
  resolveColumn,
  serializeHighlights,
  splitColumn,
  type DatalogHighlight,
  type ParsedDatalog,
} from "./datalog.js";
import { buildTreeText, flattenNodes, type TableTreeResponse } from "./tree.js";
import { DEFAULT_PROFILE, assessDatalog, assessTune, mergeProfile, type SafetyProfile, type TuneSafetyReport } from "./safety.js";

const BASE_URL = "https://www.bootmod3.net";
const TOKEN = process.env.BOOTMOD3_token;           // localStorage "token" → Authorization header
const ACCESS_TOKEN = process.env.BOOTMOD3_access_token; // localStorage "access_token" → jwt header

if (!TOKEN) {
  process.stderr.write("BOOTMOD3_token environment variable is required\n");
  process.exit(1);
}
if (!ACCESS_TOKEN) {
  process.stderr.write("BOOTMOD3_access_token environment variable is required\n");
  process.exit(1);
}

const DEBUG = process.env.BOOTMOD3_DEBUG === "1";

// Safety limits default to the N20 / 91 octane / stock-turbo profile. A JSON file
// of overrides (same shape as SafetyProfile, any subset of keys) can tune them.
function loadSafetyProfile(): SafetyProfile {
  const file = process.env.BOOTMOD3_SAFETY_PROFILE;
  if (!file) return DEFAULT_PROFILE;
  try {
    const profile = mergeProfile(JSON.parse(fs.readFileSync(file, "utf8")));
    process.stderr.write(`[bootmod3] safety profile: ${profile.name}\n`);
    return profile;
  } catch (e) {
    // Fail closed: a typo in the override file must not silently disable the limits
    // someone thought they had set, so refuse to start rather than fall back.
    process.stderr.write(`[bootmod3] could not read BOOTMOD3_SAFETY_PROFILE (${file}): ${e}\n`);
    process.exit(1);
  }
}
const SAFETY_PROFILE = loadSafetyProfile();

// Per-mapId in-memory cache — invalidated on save
const treeCache = new Map<string, TableTreeResponse>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.BOOTMOD3_CACHE_DIR ?? path.join(__dirname, "..", "cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Per-datalog in-memory cache — raw CSV also persisted to disk, never invalidated (logs are immutable)
const datalogCache = new Map<string, ParsedDatalog>();

const DATALOG_CACHE_DIR = path.join(CACHE_DIR, "datalogs");
fs.mkdirSync(DATALOG_CACHE_DIR, { recursive: true });

function cachePath(mapId: string): string {
  return path.join(CACHE_DIR, `${mapId}.json`);
}

function isCached(mapId: string): boolean {
  return treeCache.has(mapId) || fs.existsSync(cachePath(mapId));
}

/**
 * The tabletree endpoint answers HTTP 200 with a soft-rejection body for maps it
 * will not serve — a locked map yields `{"uid":1,"locked":true}`. Casting that to
 * TableTreeResponse and caching it makes every downstream tool fail on the same
 * map forever with an unrelated message ("nodes is not iterable"), because the
 * cache is only cleared by a successful save and a locked map cannot be saved.
 * Same class of failure the save path already guards with its `saveId` check.
 */
function isTableTree(value: unknown): value is TableTreeResponse {
  const t = value as TableTreeResponse | null;
  return !!t && Array.isArray(t.nodes) && typeof t.tableData === "object" && t.tableData !== null;
}

function readDiskCache(mapId: string): TableTreeResponse | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(mapId), "utf8")) as unknown;
    // Reject anything already poisoned by an earlier run so it refetches rather
    // than failing forever on cached garbage.
    return isTableTree(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeDiskCache(mapId: string, data: TableTreeResponse): void {
  try {
    fs.writeFileSync(cachePath(mapId), JSON.stringify(data));
  } catch (e) {
    process.stderr.write(`[bootmod3] cache write failed: ${e}\n`);
  }
}

function deleteDiskCache(mapId: string): void {
  try { fs.unlinkSync(cachePath(mapId)); } catch { /* not cached, fine */ }
}

function debugLog(label: string, data: unknown) {
  if (DEBUG) process.stderr.write(`[bootmod3-debug] ${label}: ${JSON.stringify(data, null, 2)}\n`);
}

const baseHeaders: Record<string, string> = {
  Authorization: `Bearer ${TOKEN}`,
  jwt: ACCESS_TOKEN,
  appBuild: "2.00.005",
  appVersion: "2.00.005",
  client: "web",
  Referer: "https://www.bootmod3.net/www/index.html",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

const jsonHeaders = { ...baseHeaders, "Content-Type": "application/json;charset=UTF-8" };

async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = init.headers as Record<string, string>;
  debugLog("request", {
    url,
    method: init.method ?? "GET",
    headers: {
      ...headers,
      Authorization: headers.Authorization?.slice(0, 30) + "…",
      jwt: headers.jwt?.slice(0, 30) + "…",
    },
    body: init.body,
  });
  const res = await fetch(url, init);
  debugLog("response", { status: res.status, statusText: res.statusText });
  return res;
}

async function fetchTableTree(mapId: string): Promise<TableTreeResponse> {
  if (treeCache.has(mapId)) return treeCache.get(mapId)!;

  const disk = readDiskCache(mapId);
  if (disk) {
    treeCache.set(mapId, disk);
    return disk;
  }

  const res = await apiFetch(`${BASE_URL}/map/v2/tabletree`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mapId }),
  });

  if (!res.ok) throw new Error(`tabletree ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as unknown;

  if (!isTableTree(data)) {
    throw new Error(
      `tabletree returned HTTP ${res.status} but the body is not a table tree — the map may be locked or unavailable. Not caching it. Body: ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  treeCache.set(mapId, data);
  writeDiskCache(mapId, data);
  return data;
}

interface DatalogListEntry {
  id: string;
  userId: string;
  name: string;
  createdDate: string;
  duration: number;
  lineCount: number;
}

function datalogCsvPath(id: string): string {
  return path.join(DATALOG_CACHE_DIR, `${id}.csv`);
}

function datalogHighlightsPath(id: string): string {
  return path.join(DATALOG_CACHE_DIR, `${id}.highlights.json`);
}

function isDatalogCached(id: string): boolean {
  return datalogCache.has(id) || fs.existsSync(datalogCsvPath(id));
}

async function fetchDatalog(id: string, refresh = false): Promise<ParsedDatalog> {
  if (!refresh && datalogCache.has(id)) return datalogCache.get(id)!;

  if (!refresh) {
    try {
      const raw = fs.readFileSync(datalogCsvPath(id), "utf8");
      const parsed = parseDatalogCsv(id, raw);
      datalogCache.set(id, parsed);
      return parsed;
    } catch {
      // not cached on disk, fall through to download
    }
  }

  const res = await apiFetch(`${BASE_URL}/dlog?id=${encodeURIComponent(id)}`, { headers: baseHeaders });
  if (!res.ok) throw new Error(`get_datalog ${res.status}: ${await res.text()}`);
  const raw = await res.text();

  try {
    fs.writeFileSync(datalogCsvPath(id), raw);
  } catch (e) {
    process.stderr.write(`[bootmod3] datalog cache write failed: ${e}\n`);
  }

  const parsed = parseDatalogCsv(id, raw);
  datalogCache.set(id, parsed);
  return parsed;
}

function readHighlights(id: string): DatalogHighlight[] {
  let raw: string;
  try {
    raw = fs.readFileSync(datalogHighlightsPath(id), "utf8");
  } catch {
    return []; // no highlights file yet
  }

  // A corrupt store reads as empty so the tool call still succeeds — but the
  // next write would truncate it, and nothing on the server can restore
  // highlights. Move the unreadable file aside before that can happen.
  if (isCorruptHighlightStore(raw)) {
    const from = datalogHighlightsPath(id);
    const to = `${from}.corrupt`;
    try {
      fs.renameSync(from, to);
      process.stderr.write(`[bootmod3] unreadable highlights for ${id} preserved at ${to}\n`);
    } catch (e) {
      process.stderr.write(`[bootmod3] could not preserve unreadable highlights for ${id}: ${e}\n`);
    }
  }

  return parseHighlights(raw);
}

function writeHighlights(id: string, highlights: DatalogHighlight[]): void {
  fs.writeFileSync(datalogHighlightsPath(id), serializeHighlights(highlights));
}

const server = new McpServer({ name: "bootmod3", version: "1.0.0" });

async function fetchMapList(): Promise<Array<Record<string, unknown>>> {
  const res = await apiFetch(`${BASE_URL}/editor/maps`, { headers: baseHeaders });
  if (!res.ok) throw new Error(`list_maps ${res.status}: ${await res.text()}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

/**
 * Picks the map that changes are judged against. An explicit id wins; otherwise
 * the stock map for the same engine/ROM, because safety is about how far a tune
 * has moved from factory — judging only against the previous save would let a
 * tune creep upward in small, individually harmless steps.
 */
async function resolveReference(
  target: TableTreeResponse,
  referenceMapId?: string
): Promise<{ tree: TableTreeResponse; note: string } | null> {
  if (referenceMapId) {
    return { tree: await fetchTableTree(referenceMapId), note: `reference: map ${referenceMapId} (chosen explicitly)` };
  }
  const maps = await fetchMapList();
  const stock = maps.filter((m) => m.stock === true && m.id !== target.mapId);
  const exact = stock.find((m) => m.engineType === target.engineType);
  const family = stock.find(
    (m) => typeof m.engineType === "string" && m.engineType.slice(0, 3) === (target.engineType ?? "").slice(0, 3)
  );
  const pick = exact ?? family;
  if (!pick) return null;
  return {
    tree: await fetchTableTree(pick.id as string),
    note: `reference: stock map "${pick.name}" (${pick.id}, ${pick.engineType})${exact ? "" : " — a different ROM of the same engine; tables are matched across ROMs"}`,
  };
}

function blockingFindings(report: TuneSafetyReport) {
  return report.findings.filter((f) => f.severity !== "info");
}

server.tool(
  "list_maps",
  "List all available ECU maps for your BMW. Returns id, name, description, engine type, stock flag, and tuner info.",
  {},
  async () => {
    const maps = await fetchMapList();
    const summary = maps.map((m) => ({
      id: m.id,
      name: m.name,
      desc: m.desc,
      engineType: m.engineType,
      stock: m.stock,
      vin: m.vin,
      rom: m.rom,
      tunerName: m.tunerName ?? null,
      current: m.current,
      cached: isCached(m.id as string),
    }));

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  "get_map_tree",
  "Get the category tree for a map showing all ECU tables organized by folder. Use this to explore what tables are available before searching or editing.",
  { mapId: z.string().describe("Map ID from list_maps") },
  async ({ mapId }) => {
    const data = await fetchTableTree(mapId);
    const tree = buildTreeText(data.nodes);
    return {
      content: [
        {
          type: "text",
          text: `mapId: ${data.mapId} | engine: ${data.engineType} | total tables: ${data.total}\n\n${tree}`,
        },
      ],
    };
  }
);

server.tool(
  "search_tables",
  "Search for ECU tables by name within a map. Returns matching tables with id, extId, folder path, and axis info.",
  {
    mapId: z.string().describe("Map ID from list_maps"),
    query: z.string().describe("Case-insensitive search term matched against table names"),
  },
  async ({ mapId, query }) => {
    const data = await fetchTableTree(mapId);
    const lq = query.toLowerCase();
    const matches = flattenNodes(data.nodes).filter((t) => t.name.toLowerCase().includes(lq));

    if (matches.length === 0) {
      return { content: [{ type: "text", text: `No tables found matching "${query}"` }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
  }
);

server.tool(
  "find_table_by_id",
  "Find an ECU table by its internal id/label (e.g. \"KF_ZW_PF1\"), not its extId. Case-insensitive substring match. Returns matching tables with id, extId, folder path, and axis info.",
  {
    mapId: z.string().describe("Map ID from list_maps"),
    id: z.string().describe("Table id/label to search for, e.g. KF_ZW_PF1"),
  },
  async ({ mapId, id }) => {
    const data = await fetchTableTree(mapId);
    const lid = id.toLowerCase();
    const matches = flattenNodes(data.nodes).filter((t) => t.id?.toLowerCase().includes(lid));

    if (matches.length === 0) {
      return { content: [{ type: "text", text: `No tables found with id matching "${id}"` }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
  }
);

server.tool(
  "get_table",
  "Get the current values of a specific ECU table by extId. Returns id, axis labels, row/column data, units, and min/max bounds.",
  {
    mapId: z.string().describe("Map ID from list_maps"),
    extId: z.string().describe("Table extId from search_tables or get_map_tree"),
  },
  async ({ mapId, extId }) => {
    const data = await fetchTableTree(mapId);
    const table = data.tableData[extId];

    if (!table) {
      return { content: [{ type: "text", text: `Table "${extId}" not found in map ${mapId}` }] };
    }

    const out = {
      id: table.def.id,
      name: table.def.name,
      extId: table.def.extId,
      units: table.def.units,
      min: table.def.min,
      max: table.def.max,
      hasXAxis: table.def.hasXAxis,
      hasYAxis: table.def.hasYAxis,
      xAxisName: table.def.xAxisName,
      yAxisName: table.def.yAxisName,
      xAxisUnits: table.def.xAxisUnits,
      yAxisUnits: table.def.yAxisUnits,
      columns: table.def.columns,
      rows_count: table.def.rows,
      hAxis: table.hAxis,
      vAxis: table.vAxis,
      rows: table.rows,
    };

    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "save_tables",
  "Save modified values for one or more ECU tables in a map. Only changed tables need to be included — others are unaffected. THIS WRITES TO A REAL CAR'S TUNE. Every save first runs the same safety check as check_tune_safety on the tables being saved, judged against the stock map: if anything is at warning or critical level the save is REFUSED and the findings are returned instead. Show those findings to the user; only pass acknowledgeRisks=true after the user has read them and explicitly said to save anyway. Use dryRun=true to check without saving.",
  {
    mapId: z.string().describe("Map ID from list_maps"),
    mapName: z.string().describe("Map name (from list_maps, required by API)"),
    mapDesc: z.string().describe("Map description (from list_maps, required by API)"),
    mapVersion: z.string().default("0.0").describe("Map version string"),
    tables: z
      .array(
        z.object({
          extId: z.string().describe("Table extId to update"),
          rows: z
            .array(z.object({ values: z.array(z.number()) }))
            .describe("New row data — each row is an object with a values array"),
          hAxis: z
            .object({ values: z.array(z.number()) })
            .optional()
            .describe("Horizontal axis values (omit for scalar tables)"),
          vAxis: z
            .object({ values: z.array(z.number()) })
            .optional()
            .describe("Vertical axis values (omit for scalar or 1D tables)"),
        })
      )
      .describe("Tables to update"),
    referenceMapId: z
      .string()
      .optional()
      .describe("Map to judge the changes against. Default: the stock map for the same engine from list_maps"),
    dryRun: z.boolean().default(false).describe("Run the safety check and report, but don't save"),
    acknowledgeRisks: z
      .boolean()
      .default(false)
      .describe(
        "Save despite warning/critical safety findings. Only set this after showing the user the findings and getting their explicit go-ahead in this conversation"
      ),
  },
  async ({ mapId, mapName, mapDesc, mapVersion, tables, referenceMapId, dryRun, acknowledgeRisks }) => {
    // --- Safety gate -------------------------------------------------------
    // Build the map as it would look after the save, then judge only the tables
    // being written. Definitions (bounds, axis names) come from the current map.
    const current = await fetchTableTree(mapId);
    const proposedData: TableTreeResponse["tableData"] = {};
    for (const t of tables) {
      const existing = current.tableData[t.extId];
      if (!existing) throw new Error(`Table "${t.extId}" not found in map ${mapId}; nothing was saved`);
      proposedData[t.extId] = {
        ...existing,
        rows: t.rows,
        hAxis: t.hAxis ?? existing.hAxis,
        vAxis: t.vAxis ?? existing.vAxis,
      };
    }
    const proposed: TableTreeResponse = { ...current, tableData: { ...current.tableData, ...proposedData } };

    const reference = await resolveReference(current, referenceMapId);
    const report = assessTune(reference?.tree ?? current, proposed, {
      profile: SAFETY_PROFILE,
      onlyExtIds: tables.map((t) => t.extId),
      engineType: current.engineType,
    });
    const referenceNote =
      reference?.note ??
      "reference: no stock map found on the account, so changes are judged against the map's current values only — cumulative changes from stock can't be checked";
    const blocking = blockingFindings(report);
    const safety = { referenceNote, ...report };

    if (dryRun) {
      return { content: [{ type: "text", text: `DRY RUN — nothing saved.\n\n${JSON.stringify(safety, null, 2)}` }] };
    }
    if (blocking.length && !acknowledgeRisks) {
      return {
        content: [
          {
            type: "text",
            text: `NOT SAVED — the safety check found ${blocking.length} issue(s) (verdict ${report.verdict}). Show these to the user. Retry with acknowledgeRisks=true only if they explicitly choose to save anyway.\n\n${JSON.stringify(safety, null, 2)}`,
          },
        ],
      };
    }

    const tableData: Record<string, unknown> = {};
    for (const t of tables) {
      tableData[t.extId] = {
        def: { extId: t.extId },
        rows: t.rows,
        hAxis: t.hAxis ?? { values: [0] },
        vAxis: t.vAxis ?? { values: [0] },
      };
    }

    const payload = {
      mapName,
      mapDesc,
      mapVersion,
      mapId,
      newMap: false,
      tableTree: { tableData },
    };

    const res = await apiFetch(`${BASE_URL}/map/v2/saveall`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    });

    const rawText = await res.text();

    if (!res.ok) throw new Error(`save_tables HTTP ${res.status}: ${rawText.slice(0, 2000)}`);

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw new Error(
        `save_tables got HTTP ${res.status} but the response body was not valid JSON — the save may not have applied. Raw body: ${rawText.slice(0, 2000)}`
      );
    }

    // A genuine success always includes a saveId. The API can return HTTP 200
    // with a body that's missing the expected fields (soft rejection) — treat
    // that as a real failure and surface the raw body instead of silently
    // reporting "Saved" with undefined fields.
    if (!result.saveId) {
      throw new Error(
        `save_tables got HTTP ${res.status} but no saveId in the response — the save did not take effect. Raw response: ${JSON.stringify(result, null, 2).slice(0, 2000)}`
      );
    }

    treeCache.delete(mapId);
    deleteDiskCache(mapId); // invalidate so next read reflects saved values

    return {
      content: [
        {
          type: "text",
          text:
            `Saved. Map: ${result.name} (${result.id}) | saveId: ${result.saveId} | uDate: ${result.uDate}\n` +
            `Safety verdict: ${report.verdict}${blocking.length ? ` — saved with ${blocking.length} acknowledged issue(s)` : ""}. ${report.summary}\n` +
            `Log a full-throttle pull and run check_datalog_health before driving hard on it.`,
        },
      ],
    };
  }
);

server.tool(
  "rename_map",
  "Rename a map and/or update its description. Existing name/desc/version fields not being changed must still be passed through (from list_maps) — the API overwrites the whole record.",
  {
    mapId: z.string().describe("Map ID from list_maps"),
    name: z.string().describe("New map name"),
    desc: z.string().describe("Map description (from list_maps if unchanged)"),
    version: z.string().default("0.0").describe("Map version string (from list_maps if unchanged)"),
  },
  async ({ mapId, name, desc, version }) => {
    const res = await apiFetch(`${BASE_URL}/map/rename`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ id: mapId, name, desc, version }),
    });

    if (!res.ok) throw new Error(`rename_map ${res.status}: ${await res.text()}`);

    const result = (await res.json()) as Record<string, unknown>;

    return {
      content: [
        {
          type: "text",
          text: `Renamed. Map: ${result.name} (${result.id}) | desc: ${result.desc} | uDate: ${result.uDate}`,
        },
      ],
    };
  }
);

function tableDiffSummary(d: TableDiff) {
  return {
    id: d.id,
    name: d.name,
    nameInB: d.nameB,
    path: d.path,
    pathInB: d.pathB,
    extId: d.extId,
    units: d.units,
    unitsInB: d.unitsB,
    matchedBy: d.tier,
    shape: `${d.shapeA[0]}x${d.shapeA[1]}`,
    shapeInB: d.shapeA[0] === d.shapeB[0] && d.shapeA[1] === d.shapeB[1] ? undefined : `${d.shapeB[0]}x${d.shapeB[1]}`,
    axesDiffer: d.axesDiffer || undefined,
    axisAligned: d.axisAligned || undefined,
    axisAlignmentFailed: d.axisAlignmentFailed,
    note: d.note,
    changedCells: d.changedCells,
    totalCells: d.totalCells,
    maxDelta: d.maxDelta,
    maxDeltaPct: d.maxDeltaPct === null ? null : Math.round(d.maxDeltaPct * 100) / 100,
    maxDeltaSpanPct: d.maxDeltaSpanPct === null ? null : Math.round(d.maxDeltaSpanPct * 100) / 100,
    maxAt: d.maxAt,
    meanAbsDelta: d.meanAbsDelta,
    reason: d.reason,
  };
}

server.tool(
  "compare_maps",
  "Compare two ECU maps and report which tables differ. Matching is tiered (extId → id → normalized id → name+shape → name) so maps built from different ROMs still line up despite renamed tables, and tables whose axis breakpoints differ are resampled onto map A's axes before diffing so cell values are compared at the same operating points rather than by index. Both maps must be readable (they are fetched/cached like get_table).",
  {
    mapIdA: z.string().describe("Baseline map ID from list_maps"),
    mapIdB: z.string().describe("Map ID to compare against the baseline"),
    mode: z
      .enum(["summary", "tables", "cells"])
      .default("tables")
      .describe(
        "summary = counts only; tables = one line per changed table; cells = also include the individual changed cells"
      ),
    filter: z
      .string()
      .optional()
      .describe("Only report tables whose id, name, or folder path contains this (case-insensitive)"),
    onlyMainTables: z
      .boolean()
      .default(false)
      .describe(
        "Only compare the main tables — the ones bootmod3 shows in its folder tree (~530 of ~3000). The rest of tableData is hidden internals that a tune rarely touches"
      ),
    maxTables: z.number().default(50).describe("Cap on changed tables reported"),
    maxCellsPerTable: z.number().default(50).describe("Cap on cells reported per table in cells mode"),
    relTol: z
      .number()
      .default(1e-6)
      .describe("Relative tolerance — differences at or below this fraction are treated as identical"),
    absTol: z.number().default(1e-9).describe("Absolute tolerance floor for float noise"),
    alignAxes: z
      .boolean()
      .default(true)
      .describe("Resample B onto A's axes when axis breakpoints differ. Disable to compare strictly by cell index"),
    tiers: z
      .array(z.enum(["extId", "id", "id-normalized", "name+shape", "name"]))
      .nonempty()
      .optional()
      .describe(
        `Matching tiers to attempt, strongest first. Default: ${DEFAULT_TIERS.join(", ")}. Add "name" to also match on display name alone — riskier, since distinct tables can share a name.`
      ),
    includeUnmatched: z
      .boolean()
      .default(false)
      .describe("Include the tables present in only one of the two maps"),
  },
  async ({
    mapIdA,
    mapIdB,
    mode,
    filter,
    onlyMainTables,
    maxTables,
    maxCellsPerTable,
    relTol,
    absTol,
    alignAxes,
    tiers,
    includeUnmatched,
  }) => {
    if (mapIdA === mapIdB) throw new Error("mapIdA and mapIdB are the same map");

    const [a, b] = await Promise.all([fetchTableTree(mapIdA), fetchTableTree(mapIdB)]);

    const result: CompareResult = compareMaps(a, b, {
      relTol,
      absTol,
      alignAxes,
      maxCellsPerTable,
      onlyMainTables,
      tiers: tiers as MatchTier[] | undefined,
    });

    const lf = filter?.toLowerCase();
    const matchesFilter = (d: TableDiff) =>
      !lf ||
      d.id?.toLowerCase().includes(lf) ||
      d.name?.toLowerCase().includes(lf) ||
      d.nameB?.toLowerCase().includes(lf) ||
      d.path.toLowerCase().includes(lf) ||
      d.pathB?.toLowerCase().includes(lf);

    const changed = result.changed.filter(matchesFilter);
    const incomparable = result.incomparable.filter(matchesFilter);

    const out: Record<string, unknown> = {
      mapA: { id: result.mapA, engine: result.engineA, tables: result.counts.tablesA },
      mapB: { id: result.mapB, engine: result.engineB, tables: result.counts.tablesB },
      scope: onlyMainTables ? "main tables only" : "all tables",
      counts: result.counts,
      ...(lf ? { filter, changedMatchingFilter: changed.length } : {}),
    };

    if (mode !== "summary") {
      out.changed = changed.slice(0, maxTables).map((d) =>
        mode === "cells" ? { ...tableDiffSummary(d), cells: d.cells, cellsTruncated: d.cellsTruncated || undefined } : tableDiffSummary(d)
      );
      if (changed.length > maxTables) out.changedTruncated = `${changed.length - maxTables} more changed tables not shown`;

      if (incomparable.length > 0) {
        out.incomparable = incomparable.slice(0, maxTables).map(tableDiffSummary);
        if (incomparable.length > maxTables) {
          out.incomparableTruncated = `${incomparable.length - maxTables} more incomparable tables not shown`;
        }
      }
    }

    if (includeUnmatched) {
      out.onlyInA = result.onlyInA.slice(0, maxTables);
      out.onlyInB = result.onlyInB.slice(0, maxTables);
      if (result.onlyInA.length > maxTables) out.onlyInATruncated = result.onlyInA.length - maxTables;
      if (result.onlyInB.length > maxTables) out.onlyInBTruncated = result.onlyInB.length - maxTables;
    }

    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "check_tune_safety",
  `Check a map for risky changes compared with the stock map, using conservative limits for: ${SAFETY_PROFILE.name}. Flags extra ignition timing, leaner fuelling, higher boost or load limits, any change to knock-control, rev-limit or engine-protection tables, out-of-range values and likely typos. Returns a verdict (OK / REVIEW / UNSAFE), findings with the RPM/load where each problem is worst, and changed tables it couldn't categorize. These are rules of thumb, not a tuner's sign-off — say so when presenting results.`,
  {
    mapId: z.string().describe("Map to check, from list_maps"),
    referenceMapId: z
      .string()
      .optional()
      .describe("Map to compare against. Default: the stock map for the same engine from list_maps"),
    includeInfo: z.boolean().default(true).describe("Include info-level findings (changes that are within limits)"),
  },
  async ({ mapId, referenceMapId, includeInfo }) => {
    const target = await fetchTableTree(mapId);
    const reference = await resolveReference(target, referenceMapId);
    if (!reference) {
      return {
        content: [
          {
            type: "text",
            text: "No stock map for this engine was found on the account, so there is nothing to compare against. Pass referenceMapId with a known-good or stock map.",
          },
        ],
      };
    }
    if (reference.tree.mapId === target.mapId) throw new Error("mapId and referenceMapId are the same map");
    const report = assessTune(reference.tree, target, { profile: SAFETY_PROFILE, engineType: target.engineType });
    const out = {
      referenceNote: reference.note,
      ...report,
      findings: includeInfo ? report.findings : report.findings.filter((f) => f.severity !== "info"),
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "check_datalog_health",
  `Health check for a datalog: finds full-throttle pulls and reports knock/timing corrections per cylinder, lean mixture, fuel-pressure drops (high- and low-pressure pumps), boost overshoot and peak boost, intake/coolant/oil temperatures, plus performance numbers (peak boost, where boost target is reached, timing at WOT, peak load). Limits are for: ${SAFETY_PROFILE.name}. Returns verdict OK / WATCH / STOP, findings with timestamps, and which channels were or weren't logged — missing channels mean those checks didn't run, so say so.`,
  {
    id: z.string().describe("Datalog id from list_datalogs"),
    refresh: z.boolean().default(false).describe("Bypass cache and re-download from server"),
  },
  async ({ id, refresh }) => {
    const dl = await fetchDatalog(id, refresh);
    const report = assessDatalog(dl, SAFETY_PROFILE);
    return { content: [{ type: "text", text: JSON.stringify({ id, ...report }, null, 2) }] };
  }
);

server.tool(
  "list_datalogs",
  "List all saved OBD datalogs for your account. Returns id, name, created date, duration, and line count.",
  {},
  async () => {
    const res = await apiFetch(`${BASE_URL}/getlogs`, { headers: baseHeaders });
    if (!res.ok) throw new Error(`list_datalogs ${res.status}: ${await res.text()}`);

    const logs = (await res.json()) as DatalogListEntry[];
    const summary = logs.map((l) => ({
      id: l.id,
      name: l.name,
      createdDate: l.createdDate,
      duration: l.duration,
      lineCount: l.lineCount,
      cached: isDatalogCached(l.id),
    }));

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  "get_datalog_summary",
  "Download (or use cached) a datalog CSV and summarize it: row count, duration, and the list of logged channels with units. Use before get_datalog_series/get_datalog_stats to see available column names.",
  {
    id: z.string().describe("Datalog id from list_datalogs"),
    refresh: z.boolean().default(false).describe("Bypass cache and re-download from server"),
  },
  async ({ id, refresh }) => {
    const dl = await fetchDatalog(id, refresh);
    const rowCount = dl.rows.length;
    const timeCol = dl.columns[0];
    const durationSec = rowCount > 0 ? dl.rows[rowCount - 1][0] - dl.rows[0][0] : 0;
    const channels = dl.columns.slice(1).map(splitColumn);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id, timeColumn: timeCol, rowCount, durationSec, channels }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_datalog_stats",
  "Compute min/max/avg for one or more datalog channels, including the timestamp where the min and max occurred. Useful for spotting spikes (knock, boost overshoot, AFR excursions) before saving a highlight.",
  {
    id: z.string().describe("Datalog id from list_datalogs"),
    columns: z
      .array(z.string())
      .describe('Channel names or substrings to match, e.g. "Knock", "Boost pressure (Target)"'),
    refresh: z.boolean().default(false).describe("Bypass cache and re-download from server"),
  },
  async ({ id, columns, refresh }) => {
    const dl = await fetchDatalog(id, refresh);

    const stats = columns.map((query) => {
      const idx = resolveColumn(dl, query);
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;
      let timeAtMin = NaN;
      let timeAtMax = NaN;

      for (const row of dl.rows) {
        const v = row[idx];
        if (Number.isNaN(v)) continue;
        sum += v;
        count++;
        if (v < min) {
          min = v;
          timeAtMin = row[0];
        }
        if (v > max) {
          max = v;
          timeAtMax = row[0];
        }
      }

      return {
        column: dl.columns[idx],
        count,
        min: count ? min : null,
        max: count ? max : null,
        avg: count ? sum / count : null,
        timeAtMin: count ? timeAtMin : null,
        timeAtMax: count ? timeAtMax : null,
      };
    });

    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }
);

server.tool(
  "get_datalog_series",
  "Get time-series values for specific datalog channels, optionally windowed by time range and downsampled. Use get_datalog_summary first to see channel names.",
  {
    id: z.string().describe("Datalog id from list_datalogs"),
    columns: z.array(z.string()).describe("Channel names or substrings to match"),
    startTime: z.number().optional().describe("Start of time window in seconds (from the Time column)"),
    endTime: z.number().optional().describe("End of time window in seconds"),
    maxPoints: z.number().default(500).describe("Downsample to at most this many points via even striding"),
  },
  async ({ id, columns, startTime, endTime, maxPoints }) => {
    const dl = await fetchDatalog(id);
    const indices = columns.map((q) => resolveColumn(dl, q));

    let rows = dl.rows;
    if (startTime !== undefined) rows = rows.filter((r) => r[0] >= startTime);
    if (endTime !== undefined) rows = rows.filter((r) => r[0] <= endTime);

    const stride = rows.length > maxPoints ? Math.ceil(rows.length / maxPoints) : 1;
    const sampled = rows.filter((_, i) => i % stride === 0);

    const series: Record<string, number[]> = {};
    for (const idx of indices) series[dl.columns[idx]] = sampled.map((r) => r[idx]);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id, points: sampled.length, time: sampled.map((r) => r[0]), series }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "add_datalog_highlight",
  "Save a highlight/annotation on a datalog — e.g. a knock event, boost spike, or AFR excursion — so it can be recalled later without re-analyzing the raw data.",
  {
    id: z.string().describe("Datalog id from list_datalogs"),
    time: z.number().describe("Time in seconds (from the Time column) the highlight refers to"),
    note: z.string().describe("Description of what's notable at this point"),
    column: z.string().optional().describe("Channel name this highlight relates to, if any"),
    value: z.number().optional().describe("Channel value at this point, if known"),
  },
  async ({ id, time, note, column, value }) => {
    const highlights = readHighlights(id);
    const highlight: DatalogHighlight = {
      uid: randomUUID(),
      time,
      column,
      value,
      note,
      createdAt: new Date().toISOString(),
    };
    highlights.push(highlight);
    writeHighlights(id, highlights);

    return { content: [{ type: "text", text: `Saved highlight ${highlight.uid} at t=${time}s: ${note}` }] };
  }
);

server.tool(
  "list_datalog_highlights",
  "List saved highlights/annotations for a datalog.",
  { id: z.string().describe("Datalog id from list_datalogs") },
  async ({ id }) => {
    const highlights = readHighlights(id);
    return { content: [{ type: "text", text: JSON.stringify(highlights, null, 2) }] };
  }
);

server.tool(
  "delete_datalog_highlight",
  "Delete a saved datalog highlight by its uid.",
  {
    id: z.string().describe("Datalog id from list_datalogs"),
    uid: z.string().describe("Highlight uid from add_datalog_highlight or list_datalog_highlights"),
  },
  async ({ id, uid }) => {
    const filtered = removeHighlight(readHighlights(id), uid, id);
    writeHighlights(id, filtered);
    return { content: [{ type: "text", text: `Deleted highlight ${uid}` }] };
  }
);

async function testAuth(): Promise<void> {
  process.stderr.write("[bootmod3] verifying auth...\n");
  try {
    const res = await apiFetch(`${BASE_URL}/editor/maps`, { headers: baseHeaders });
    if (res.status === 401 || res.status === 403) {
      process.stderr.write(
        `[bootmod3] auth check failed (${res.status}): token rejected. Check BOOTMOD3_token and BOOTMOD3_access_token.\n`
      );
      process.exit(1);
    }
    if (!res.ok) {
      process.stderr.write(`[bootmod3] auth check returned ${res.status}, continuing anyway\n`);
      return;
    }
    process.stderr.write("[bootmod3] auth OK\n");
  } catch (e) {
    process.stderr.write(`[bootmod3] auth check failed (network error), continuing anyway: ${e}\n`);
  }
}

await testAuth();

const transport = new StdioServerTransport();
await server.connect(transport);
