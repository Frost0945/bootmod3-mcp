// Safety and performance assessment for tunes and datalogs.
//
// Pure by design, like compare.ts and datalog.ts: no `fs`, no `fetch`. The
// tools in index.ts fetch maps and logs, then hand them here.
//
// None of this proves a tune is safe. It encodes conservative rules of thumb for
// one specific setup (see DEFAULT_PROFILE) and flags anything that breaks them,
// so a human looks before a risky value reaches the car. Every limit lives in the
// profile so it can be tightened or loosened without touching the logic.

import { compareMaps, type CellDelta, type TableDiff, type TableEntryLike, type TableTreeLike } from "./compare.js";
import { splitColumn, type ParsedDatalog } from "./datalog.js";

export type Severity = "critical" | "warning" | "info";

export interface SafetyProfile {
  name: string;
  /** Engine type prefix the limits were chosen for, matched against map.engineType. */
  engine: string;
  tune: {
    ignitionWarnDeg: number;
    ignitionCritDeg: number;
    /** Leaner than reference, in lambda (AFR targets are converted at 14.7:1). */
    lambdaLeanWarn: number;
    lambdaLeanCrit: number;
    boostIncreaseWarnPct: number;
    boostIncreaseCritPct: number;
    /** Absolute boost-target ceilings, applied only to tables in hPa/mbar absolute. */
    boostAbsWarnHpa: number;
    boostAbsCritHpa: number;
    loadIncreaseWarnPct: number;
    loadIncreaseCritPct: number;
    /** A jump between neighbouring cells larger than this fraction of the table's span looks like a typo. */
    spikeSpanFraction: number;
  };
  log: {
    /** Pedal position (%) at or above which a row counts as wide-open throttle. */
    wotPedalPct: number;
    wotMinRpm: number;
    timingCorrEventDeg: number;
    timingCorrWarnDeg: number;
    timingCorrCritDeg: number;
    wotLambdaWarn: number;
    wotLambdaCrit: number;
    leanVsTargetWarn: number;
    leanVsTargetCrit: number;
    /** Samples in a row a lean/overshoot condition must persist before it counts — filters single-sample noise. */
    sustainSamples: number;
    railPressureWarnFraction: number;
    railPressureCritFraction: number;
    railPressureWarnBar: number;
    railPressureCritBar: number;
    lowPressureWarnBar: number;
    lowPressureCritBar: number;
    boostOvershootWarnPsi: number;
    boostOvershootCritPsi: number;
    peakBoostWarnPsi: number;
    peakBoostCritPsi: number;
    iatWarnC: number;
    iatCritC: number;
    coolantWarnC: number;
    coolantCritC: number;
    oilWarnC: number;
    oilCritC: number;
    /** Hard pulls below this oil temperature are flagged. */
    coldOilC: number;
  };
}

/**
 * Conservative limits for an N20 on 91 octane (US) / 95 RON with the stock
 * turbo, stock intercooler and stock fuel system — only a cold-air intake. 91 is
 * the most knock-limited pump fuel, so timing headroom is small; the stock
 * turbo and HPFP set the boost and fuel-pressure ceilings.
 */
export const DEFAULT_PROFILE: SafetyProfile = {
  name: "N20 · 91 octane · stock turbo, intercooler and fuel system · intake only",
  engine: "N20",
  tune: {
    ignitionWarnDeg: 1.5,
    ignitionCritDeg: 3,
    lambdaLeanWarn: 0.02,
    lambdaLeanCrit: 0.04,
    boostIncreaseWarnPct: 10,
    boostIncreaseCritPct: 20,
    boostAbsWarnHpa: 2300,
    boostAbsCritHpa: 2450,
    loadIncreaseWarnPct: 10,
    loadIncreaseCritPct: 25,
    spikeSpanFraction: 0.25,
  },
  log: {
    wotPedalPct: 90,
    wotMinRpm: 2000,
    timingCorrEventDeg: 1.5,
    timingCorrWarnDeg: 3,
    timingCorrCritDeg: 5,
    wotLambdaWarn: 0.88,
    wotLambdaCrit: 0.92,
    leanVsTargetWarn: 0.05,
    leanVsTargetCrit: 0.08,
    sustainSamples: 3,
    railPressureWarnFraction: 0.85,
    railPressureCritFraction: 0.7,
    railPressureWarnBar: 150,
    railPressureCritBar: 120,
    lowPressureWarnBar: 4,
    lowPressureCritBar: 3,
    boostOvershootWarnPsi: 2,
    boostOvershootCritPsi: 3.5,
    peakBoostWarnPsi: 19,
    peakBoostCritPsi: 21,
    iatWarnC: 50,
    iatCritC: 65,
    coolantWarnC: 110,
    coolantCritC: 116,
    oilWarnC: 130,
    oilCritC: 140,
    coldOilC: 70,
  },
};

/** Deep-merges user overrides onto the default profile; unknown keys are ignored. */
export function mergeProfile(overrides: unknown, base: SafetyProfile = DEFAULT_PROFILE): SafetyProfile {
  if (!overrides || typeof overrides !== "object") return base;
  const o = overrides as Partial<{ name: string; engine: string; tune: Record<string, unknown>; log: Record<string, unknown> }>;
  const pickNumbers = <T extends object>(target: T, src: Record<string, unknown> | undefined): T => {
    if (!src || typeof src !== "object") return target;
    const out = { ...target } as Record<string, number>;
    for (const k of Object.keys(out)) {
      const v = src[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out as T;
  };
  return {
    name: typeof o.name === "string" ? o.name : base.name,
    engine: typeof o.engine === "string" ? o.engine : base.engine,
    tune: pickNumbers(base.tune, o.tune),
    log: pickNumbers(base.log, o.log),
  };
}

export interface Finding {
  severity: Severity;
  category: string;
  message: string;
  table?: { extId: string; id?: string; name?: string };
  /** Operating point of the worst cell, when the table has real axes. */
  at?: { rpm?: number; load?: number; x?: number; y?: number; time?: number };
}

// ---------------------------------------------------------------------------
// Tune assessment
// ---------------------------------------------------------------------------

export type TableCategory =
  | "knock"
  | "protection"
  | "rev_limit"
  | "speed_limit"
  | "ignition"
  | "lambda"
  | "boost"
  | "load_torque"
  | "fuel_system";

interface TableInfo {
  id?: string;
  name?: string;
  units?: string;
  path?: string;
}

// Order matters: a knock-retard table is in degrees and a component-protection
// table can be a lambda target, so the more specific families are tested first.
// Patterns cover both the MEVD17 internal ids (KF_ZW_*, RKR*, BTS*) and the
// English display names bootmod3 shows.
const CATEGORY_RULES: Array<{ category: TableCategory; id?: RegExp; text?: RegExp }> = [
  { category: "knock", id: /(^|_)(RKR|KR|KRK|KFRKR|KLOPF)|RKRMX|KFZWKR/i, text: /knock|klopf/i },
  {
    category: "protection",
    id: /(^|_)(BTS|TABG|KATS|BAUTEIL)/i,
    text: /component protection|overheat|over-?temp|exhaust (gas )?temp|catalyst (protection|temp)|cat protection|limp|derat/i,
  },
  { category: "rev_limit", id: /(^|_)(NMAX|NMOT_?MAX|NMOTMX|DZBEG)/i, text: /rev(olution)? limit|rpm limit|engine speed limit|rev ?limiter/i },
  { category: "speed_limit", id: /(^|_)(VMAX|VFZG_?MAX)/i, text: /speed limit|vehicle speed max|vmax/i },
  { category: "ignition", id: /(^|_)(KF_?ZW|ZWOPT|ZWBAS|ZW_)/i, text: /ignition|spark|timing/i },
  { category: "lambda", id: /(^|_)(LAMSOLL|LAMBTS|KF_?LA|LAMFA|LAMS)/i, text: /lambda|afr|air[- ]fuel/i },
  {
    category: "boost",
    id: /(^|_)(PLD|PSSOL|KFLD|LDR|LDPM)/i,
    text: /boost|charge (air )?pressure|charging pressure|wastegate|ladedruck/i,
  },
  { category: "load_torque", id: /(^|_)(KFMIRL|KFRLMX|RLMAX|KFMDMAX|MDMAX|KFMIOP|MIZUL)/i, text: /torque|max(imum)? load|load limit|rl ?max/i },
  { category: "fuel_system", id: /(^|_)(KFPRS|PRSOLL|KRKTE|TEVKORR|KFTVSA)/i, text: /injector|rail pressure|fuel pressure|hpfp|fuel pump/i },
];

export function classifyTable(t: TableInfo): TableCategory | null {
  const text = `${t.name ?? ""} ${t.path ?? ""}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.id && t.id && rule.id.test(t.id)) return rule.category;
    if (rule.text && rule.text.test(text)) return rule.category;
  }
  return null;
}

function isRpmAxis(name?: string, units?: string): boolean {
  return /rpm|1\/min|engine speed|nmot|drehzahl/i.test(`${name ?? ""} ${units ?? ""}`);
}

function atFor(cell: CellDelta, entry: TableEntryLike | undefined): Finding["at"] {
  const def = entry?.def;
  const at: NonNullable<Finding["at"]> = {};
  const assign = (v: number | undefined, name?: string) => {
    if (v === undefined) return;
    if (isRpmAxis(name)) at.rpm = v;
    else if (at.load === undefined && /load|rl|air mass|mass|torque|pressure/i.test(name ?? "")) at.load = v;
  };
  if (cell.x !== undefined) {
    at.x = cell.x;
    assign(cell.x, def?.xAxisName);
  }
  if (cell.y !== undefined) {
    at.y = cell.y;
    assign(cell.y, def?.yAxisName);
  }
  return Object.keys(at).length ? at : undefined;
}

function fmtAt(at: Finding["at"]): string {
  if (!at) return "";
  const parts: string[] = [];
  if (at.rpm !== undefined) parts.push(`${at.rpm} rpm`);
  if (at.load !== undefined) parts.push(`load ${at.load}`);
  if (!parts.length) {
    if (at.x !== undefined) parts.push(`x=${at.x}`);
    if (at.y !== undefined) parts.push(`y=${at.y}`);
  }
  return parts.length ? ` at ${parts.join(", ")}` : "";
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function worst(cells: CellDelta[], score: (c: CellDelta) => number): { cell: CellDelta; score: number } | null {
  let best: { cell: CellDelta; score: number } | null = null;
  for (const c of cells) {
    const s = score(c);
    if (!Number.isFinite(s)) continue;
    if (!best || s > best.score) best = { cell: c, score: s };
  }
  return best;
}

function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
}

function grid(entry: TableEntryLike): number[][] {
  return entry.rows.map((r) => r.values);
}

function severityFor(value: number, warn: number, crit: number): Severity | null {
  if (value > crit) return "critical";
  if (value > warn) return "warning";
  return null;
}

function tableRef(d: TableDiff) {
  return { extId: d.extIdB, id: d.id, name: d.nameB ?? d.name };
}

/** Rules for one changed table, given reference (a) and proposed (b) values. */
function assessDiff(
  d: TableDiff,
  category: TableCategory,
  proposedEntry: TableEntryLike | undefined,
  p: SafetyProfile
): Finding[] {
  const out: Finding[] = [];
  const t = p.tune;
  const ref = tableRef(d);
  const label = `${d.nameB ?? d.name ?? d.extIdB}${d.id ? ` (${d.id})` : ""}`;
  const cells = d.cells;

  switch (category) {
    case "ignition": {
      const w = worst(cells, (c) => c.delta);
      if (w && w.score > 0) {
        const sev = severityFor(w.score, t.ignitionWarnDeg, t.ignitionCritDeg);
        const at = atFor(w.cell, proposedEntry);
        if (sev) {
          out.push({
            severity: sev,
            category,
            table: ref,
            at,
            message: `${label}: timing advanced up to +${r2(w.score)}° over the reference${fmtAt(at)} (${r2(w.cell.a)}° → ${r2(w.cell.b)}°). On 91 octane extra timing is the most common cause of knock; limit here is +${t.ignitionWarnDeg}° (warn) / +${t.ignitionCritDeg}° (stop).`,
          });
        } else {
          out.push({ severity: "info", category, table: ref, at, message: `${label}: timing advanced up to +${r2(w.score)}°${fmtAt(at)} — within limits.` });
        }
      } else {
        out.push({ severity: "info", category, table: ref, message: `${label}: timing only reduced (safer, costs some power).` });
      }
      break;
    }
    case "lambda": {
      // AFR-scaled targets sit around 11–15; lambda around 0.7–1.1.
      const isAfr = median(cells.map((c) => c.a)) > 5;
      const toLambda = (v: number) => (isAfr ? v / 14.7 : v);
      const w = worst(cells, (c) => toLambda(c.b) - toLambda(c.a));
      if (w && w.score > 0) {
        const sev = severityFor(w.score, t.lambdaLeanWarn, t.lambdaLeanCrit);
        const at = atFor(w.cell, proposedEntry);
        const msg = `${label}: mixture made leaner by up to ${r2(w.score)} lambda${fmtAt(at)} (${r2(toLambda(w.cell.a))} → ${r2(toLambda(w.cell.b))}). Leaner full-load mixture raises combustion and exhaust temperatures.`;
        out.push({ severity: sev ?? "info", category, table: ref, at, message: sev ? msg : `${msg} Within limits.` });
      } else {
        out.push({ severity: "info", category, table: ref, message: `${label}: mixture only made richer (safer).` });
      }
      break;
    }
    case "boost": {
      const w = worst(cells, (c) => (c.a > 0 ? ((c.b - c.a) / c.a) * 100 : NaN));
      if (w && w.score > 0) {
        const sev = severityFor(w.score, t.boostIncreaseWarnPct, t.boostIncreaseCritPct);
        const at = atFor(w.cell, proposedEntry);
        const msg = `${label}: boost target raised up to ${r2(w.score)}% over the reference${fmtAt(at)} (${r2(w.cell.a)} → ${r2(w.cell.b)}${d.unitsB ? " " + d.unitsB : ""}).`;
        out.push({ severity: sev ?? "info", category, table: ref, at, message: sev ? `${msg} The stock turbo and intercooler have little headroom.` : `${msg} Within limits.` });
      }
      // Absolute ceiling only where the units make the scale unambiguous.
      const units = (d.unitsB ?? d.units ?? "").toLowerCase();
      if (/hpa|mbar/.test(units)) {
        const peak = worst(cells, (c) => (c.b > 1000 && c.b > c.a ? c.b : NaN));
        if (peak) {
          const sev = severityFor(peak.score, t.boostAbsWarnHpa, t.boostAbsCritHpa);
          if (sev) {
            const at = atFor(peak.cell, proposedEntry);
            out.push({
              severity: sev,
              category,
              table: ref,
              at,
              message: `${label}: boost target of ${r2(peak.score)} ${units} absolute (≈${r2((peak.score - 1013) * 0.0145038)} psi gauge)${fmtAt(at)} is beyond what's comfortable for the stock N20 turbo (warn above ${t.boostAbsWarnHpa}, stop above ${t.boostAbsCritHpa} hPa).`,
            });
          }
        }
      }
      break;
    }
    case "load_torque": {
      const w = worst(cells, (c) => (c.a > 0 ? ((c.b - c.a) / c.a) * 100 : NaN));
      if (w && w.score > 0) {
        const sev = severityFor(w.score, t.loadIncreaseWarnPct, t.loadIncreaseCritPct);
        const at = atFor(w.cell, proposedEntry);
        const msg = `${label}: load/torque limit raised up to ${r2(w.score)}%${fmtAt(at)} (${r2(w.cell.a)} → ${r2(w.cell.b)}).`;
        out.push({ severity: sev ?? "info", category, table: ref, at, message: sev ? `${msg} More load means more cylinder pressure on stock internals and clutch/transmission.` : `${msg} Within limits.` });
      }
      break;
    }
    case "knock":
      out.push({
        severity: "critical",
        category,
        table: ref,
        message: `${label}: knock-control table changed (${d.changedCells}/${d.totalCells} cells). Whether this loosens or tightens knock protection can't be judged automatically — have a tuner confirm before saving.`,
      });
      break;
    case "protection":
      out.push({
        severity: "critical",
        category,
        table: ref,
        message: `${label}: engine/component protection table changed (${d.changedCells}/${d.totalCells} cells). These tables protect against overheating and exhaust-temperature damage; weakening them is a common way tunes kill engines.`,
      });
      break;
    case "rev_limit": {
      const w = worst(cells, (c) => c.delta);
      if (w && w.score > 0) {
        out.push({ severity: "critical", category, table: ref, message: `${label}: rev limit raised by ${r2(w.score)} (${r2(w.cell.a)} → ${r2(w.cell.b)}). The stock N20 valvetrain and rods aren't meant to rev higher.` });
      } else {
        out.push({ severity: "info", category, table: ref, message: `${label}: rev limit lowered or unchanged.` });
      }
      break;
    }
    case "speed_limit":
      out.push({ severity: "info", category, table: ref, message: `${label}: speed limiter changed — make sure your tyres are rated for the new top speed.` });
      break;
    case "fuel_system":
      out.push({
        severity: "warning",
        category,
        table: ref,
        message: `${label}: fuel-system table changed (${d.changedCells}/${d.totalCells} cells). Injector or rail-pressure scaling errors change the actual mixture everywhere — verify with a datalog.`,
      });
      break;
  }
  return out;
}

/** Bounds, NaN and neighbour-jump checks on a proposed table. */
export function structuralFindings(
  extId: string,
  proposed: TableEntryLike,
  reference: TableEntryLike | undefined,
  p: SafetyProfile = DEFAULT_PROFILE
): Finding[] {
  const out: Finding[] = [];
  const def = proposed.def;
  const ref = { extId, id: def.id, name: def.name };
  const label = `${def.name ?? extId}${def.id ? ` (${def.id})` : ""}`;
  const g = grid(proposed);

  let nonFinite = 0;
  let below = 0;
  let above = 0;
  const hasBounds = typeof def.min === "number" && typeof def.max === "number" && def.max > def.min;
  for (const row of g) {
    for (const v of row) {
      if (!Number.isFinite(v)) nonFinite++;
      else if (hasBounds && v < def.min!) below++;
      else if (hasBounds && v > def.max!) above++;
    }
  }
  if (nonFinite) out.push({ severity: "critical", category: "structure", table: ref, message: `${label}: ${nonFinite} cell(s) are not numbers.` });
  if (below || above) {
    out.push({
      severity: "critical",
      category: "structure",
      table: ref,
      message: `${label}: ${below + above} cell(s) outside the table's allowed range ${def.min}…${def.max}.`,
    });
  }

  // A sudden step between neighbours that the reference doesn't share is almost
  // always a typo (an extra digit, a sign flip). Only compare against the
  // reference's step where the shapes match cell for cell.
  if (hasBounds) {
    const span = def.max! - def.min!;
    const rg = reference ? grid(reference) : null;
    const sameShape = !!rg && rg.length === g.length && rg.every((r, i) => r.length === g[i].length);
    let worstJump: { jump: number; r: number; c: number } | null = null;
    const consider = (r: number, c: number, r2_: number, c2: number) => {
      const jump = Math.abs(g[r][c] - g[r2_][c2]);
      if (!Number.isFinite(jump) || jump <= span * p.tune.spikeSpanFraction) return;
      if (sameShape) {
        const refJump = Math.abs(rg![r][c] - rg![r2_][c2]);
        if (jump <= refJump * 1.5 + 1e-9) return;
      }
      if (!worstJump || jump > worstJump.jump) worstJump = { jump, r, c };
    };
    for (let r = 0; r < g.length; r++) {
      for (let c = 0; c < g[r].length; c++) {
        if (c + 1 < g[r].length) consider(r, c, r, c + 1);
        if (r + 1 < g.length && c < g[r + 1].length) consider(r, c, r + 1, c);
      }
    }
    if (worstJump) {
      const wj = worstJump as { jump: number; r: number; c: number };
      out.push({
        severity: "warning",
        category: "structure",
        table: ref,
        message: `${label}: sudden jump of ${r2(wj.jump)} between neighbouring cells near row ${wj.r}, column ${wj.c} (more than ${Math.round(p.tune.spikeSpanFraction * 100)}% of the table's range). Check for a typo.`,
      });
    }
  }
  return out;
}

export interface TuneSafetyReport {
  profile: string;
  verdict: "OK" | "REVIEW" | "UNSAFE";
  summary: string;
  counts: { critical: number; warning: number; info: number; changedTables: number; uncategorizedChanged: number };
  findings: Finding[];
  /** Changed tables that matched no safety category — listed so nothing is silently ignored. */
  uncategorized: Array<{ extId: string; id?: string; name?: string; changedCells: number }>;
  uncategorizedTruncated?: string;
}

export interface TuneSafetyOptions {
  profile?: SafetyProfile;
  /** Restrict the assessment to these extIds of the proposed map (the tables being saved). */
  onlyExtIds?: string[];
  /** Engine type of the proposed map, for the profile-mismatch warning. */
  engineType?: string;
  maxUncategorized?: number;
}

/**
 * Assesses `proposed` against `reference` (normally the stock map for the same
 * ROM). Changes are judged cumulatively against the reference, so a small edit
 * on top of an already aggressive tune is still caught.
 */
export function assessTune(reference: TableTreeLike, proposed: TableTreeLike, options: TuneSafetyOptions = {}): TuneSafetyReport {
  const p = options.profile ?? DEFAULT_PROFILE;
  const only = options.onlyExtIds ? new Set(options.onlyExtIds) : null;

  const scoped: TableTreeLike = only
    ? { ...proposed, tableData: Object.fromEntries(Object.entries(proposed.tableData).filter(([k]) => only.has(k))) }
    : proposed;

  // Every changed cell is needed to find the worst one, not just the first 200.
  const cmp = compareMaps(reference, scoped, { maxCellsPerTable: Number.MAX_SAFE_INTEGER });
  const findings: Finding[] = [];
  const uncategorized: TuneSafetyReport["uncategorized"] = [];

  const engine = options.engineType ?? proposed.engineType;
  if (engine && !engine.toUpperCase().startsWith(p.engine.toUpperCase())) {
    findings.push({
      severity: "warning",
      category: "profile",
      message: `This map is for ${engine}, but the safety limits are set for ${p.engine}. Results may be too strict or too loose.`,
    });
  }

  for (const d of cmp.changed) {
    const entry = scoped.tableData[d.extIdB];
    const category = classifyTable({ id: d.id ?? entry?.def.id, name: d.nameB ?? d.name, units: d.unitsB, path: d.pathB ?? d.path });
    if (category) findings.push(...assessDiff(d, category, entry, p));
    else uncategorized.push({ extId: d.extIdB, id: d.id, name: d.nameB ?? d.name, changedCells: d.changedCells });
  }

  for (const d of cmp.incomparable) {
    const category = classifyTable({ id: d.id, name: d.nameB ?? d.name, units: d.unitsB, path: d.pathB ?? d.path });
    if (category) {
      findings.push({
        severity: "warning",
        category,
        table: tableRef(d),
        message: `${d.nameB ?? d.name ?? d.extIdB}: couldn't be compared with the reference (${d.reason ?? "different layout"}) — check it by hand.`,
      });
    }
  }

  // Proposed tables with no counterpart in the reference can't be judged by delta.
  for (const stub of cmp.onlyInB) {
    const category = classifyTable(stub);
    if (category) {
      findings.push({
        severity: "warning",
        category,
        table: { extId: stub.extId, id: stub.id, name: stub.name },
        message: `${stub.name ?? stub.extId}: not found in the reference map, so changes to it can't be checked.`,
      });
    }
  }

  // Structural checks on every proposed table in scope, changed or not relative to reference.
  const refById = new Map<string, TableEntryLike>();
  for (const [k, e] of Object.entries(reference.tableData)) refById.set(k, e);
  for (const [extId, entry] of Object.entries(scoped.tableData)) {
    if (only || cmp.changed.some((d) => d.extIdB === extId)) {
      findings.push(...structuralFindings(extId, entry, refById.get(extId), p));
    }
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
    changedTables: cmp.changed.length,
    uncategorizedChanged: uncategorized.length,
  };
  const verdict = counts.critical ? "UNSAFE" : counts.warning ? "REVIEW" : "OK";
  const summary =
    verdict === "UNSAFE"
      ? `${counts.critical} change(s) break the safety limits for ${p.name}. Don't flash this without a tuner reviewing it.`
      : verdict === "REVIEW"
        ? `No hard-limit violations, but ${counts.warning} change(s) need a closer look.`
        : cmp.changed.length
          ? `${cmp.changed.length} changed table(s), none outside the safety limits. Confirm with a datalog after flashing.`
          : "No changes from the reference map.";

  const max = options.maxUncategorized ?? 25;
  return {
    profile: p.name,
    verdict,
    summary,
    counts,
    findings,
    uncategorized: uncategorized.slice(0, max),
    ...(uncategorized.length > max ? { uncategorizedTruncated: `${uncategorized.length - max} more uncategorized changed tables not shown` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Datalog assessment
// ---------------------------------------------------------------------------

interface Channel {
  idx: number;
  column: string;
  unit?: string;
}

function findChannels(dl: ParsedDatalog, include: RegExp, exclude?: RegExp): Channel[] {
  const out: Channel[] = [];
  dl.columns.forEach((col, idx) => {
    if (idx === 0) return;
    const { name, unit } = splitColumn(col);
    if (include.test(name) && !(exclude && exclude.test(name))) out.push({ idx, column: col, unit });
  });
  return out;
}

function findChannel(dl: ParsedDatalog, include: RegExp, exclude?: RegExp): Channel | null {
  return findChannels(dl, include, exclude)[0] ?? null;
}

type PressureUnit = "psi" | "bar" | "kpa" | "hpa" | "mpa";

function pressureUnit(unit: string | undefined, sample: number): PressureUnit {
  const u = (unit ?? "").toLowerCase();
  if (u.includes("psi")) return "psi";
  if (u.includes("mpa")) return "mpa";
  if (u.includes("kpa")) return "kpa";
  if (u.includes("hpa") || u.includes("mbar")) return "hpa";
  if (u.includes("bar")) return "bar";
  // No unit: guess from magnitude.
  if (sample > 500) return "hpa";
  if (sample > 60) return "kpa";
  return "psi";
}

const toPsi: Record<PressureUnit, number> = { psi: 1, bar: 14.5038, kpa: 0.145038, hpa: 0.0145038, mpa: 145.038 };
const toBar: Record<PressureUnit, number> = { psi: 1 / 14.5038, bar: 1, kpa: 0.01, hpa: 0.001, mpa: 10 };

/**
 * Whether a boost channel reads absolute pressure (≈1 bar at rest) or gauge (≈0).
 * psi channels are taken as gauge unless named absolute: a log of nothing but
 * full-throttle pulls never shows the resting value, so magnitude can't decide.
 * Metric boost is conventionally absolute, and its resting floor is ~1 bar.
 */
function isAbsolutePressure(ch: Channel, unit: PressureUnit, values: number[]): boolean {
  const name = splitColumn(ch.column).name;
  if (/\babs/i.test(name)) return true;
  if (/gauge|rel(ative)?\b/i.test(name)) return false;
  if (unit === "psi") return false;
  return percentile(values, 0.05) * toBar[unit] > 0.7;
}

function toCelsius(v: number, unit?: string): number {
  return /f/i.test(unit ?? "") && !/c/i.test(unit ?? "") ? ((v - 32) * 5) / 9 : v;
}

function percentile(values: number[], q: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))];
}

/** Longest run of consecutive WOT rows where `pred` holds, with the time it started and the extreme value. */
function sustained(
  rows: number[][],
  wot: boolean[],
  pred: (row: number[]) => number | null,
  minRun: number
): { value: number; time: number } | null {
  let run = 0;
  let runExtreme = -Infinity;
  let runStart = NaN;
  let best: { value: number; time: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const v = wot[i] ? pred(rows[i]) : null;
    if (v === null || !Number.isFinite(v)) {
      run = 0;
      runExtreme = -Infinity;
      continue;
    }
    if (run === 0) runStart = rows[i][0];
    run++;
    if (v > runExtreme) runExtreme = v;
    if (run >= minRun && (!best || runExtreme > best.value)) best = { value: runExtreme, time: runStart };
  }
  return best;
}

export interface DatalogHealthReport {
  profile: string;
  verdict: "OK" | "WATCH" | "STOP";
  summary: string;
  wot: { rows: number; pulls: number; seconds: number; detectedBy: string };
  performance: Record<string, unknown>;
  findings: Finding[];
  channelsUsed: Record<string, string | string[]>;
  channelsMissing: string[];
}

export function assessDatalog(dl: ParsedDatalog, profile: SafetyProfile = DEFAULT_PROFILE): DatalogHealthReport {
  const L = profile.log;
  const rows = dl.rows;
  const findings: Finding[] = [];
  const used: Record<string, string | string[]> = {};
  const missing: string[] = [];
  const note = (key: string, ch: Channel | Channel[] | null) => {
    if (!ch || (Array.isArray(ch) && ch.length === 0)) missing.push(key);
    else used[key] = Array.isArray(ch) ? ch.map((c) => c.column) : ch.column;
  };

  const rpm = findChannel(dl, /^(engine )?(rpm|speed)$|engine speed|^rpm/i, /vehicle|wheel|fan|turbo/i);
  const pedal = findChannel(dl, /pedal|accel/i);
  const throttle = findChannel(dl, /throttle/i, /target|req/i);
  const timingCorr = findChannels(dl, /(timing|ignition|ign\.?).*(corr|retard)|knock.*(retard|corr)|kr ?cyl|cyl.*(corr|retard)/i);
  const timing = findChannel(dl, /^(ignition )?timing|ignition angle|spark advance|ign\.? timing/i, /corr|retard|target/i);
  const lambdaAct = findChannel(dl, /lambda|afr/i, /target|req|desired|setpoint|corr|trim|integr|adapt/i);
  const lambdaTarget = findChannels(dl, /lambda|afr/i).find((c) => /target|req|desired|setpoint/i.test(splitColumn(c.column).name)) ?? null;
  const boost = findChannel(dl, /boost|charge pressure|manifold pressure|map\b/i, /target|req|desired|setpoint|limit|wgdc|wastegate/i);
  const boostTarget = findChannels(dl, /boost|charge pressure|manifold pressure/i).find((c) => /target|req|desired|setpoint/i.test(splitColumn(c.column).name)) ?? null;
  const rail = findChannel(dl, /rail|high pressure|hpfp|fuel pressure(?! low)/i, /target|req|desired|setpoint|low/i);
  const railTarget = findChannels(dl, /rail|high pressure|hpfp/i).find((c) => /target|req|desired|setpoint/i.test(splitColumn(c.column).name)) ?? null;
  const lpfp = findChannel(dl, /low pressure|lpfp|fuel pressure.*low|low.*fuel/i, /target|req|desired/i);
  const iat = findChannel(dl, /iat|intake air temp|intake temp|charge air temp/i);
  const coolant = findChannel(dl, /coolant|ect\b|water temp/i);
  const oil = findChannel(dl, /oil temp/i);
  const load = findChannel(dl, /load/i, /target|req|limit/i);

  note("rpm", rpm);
  note("pedal", pedal ?? throttle);
  note("timingCorrections", timingCorr);
  note("timing", timing);
  note("lambda", lambdaAct);
  note("lambdaTarget", lambdaTarget);
  note("boost", boost);
  note("boostTarget", boostTarget);
  note("railPressure", rail);
  note("railPressureTarget", railTarget);
  note("lowPressureFuel", lpfp);
  note("intakeAirTemp", iat);
  note("coolantTemp", coolant);
  note("oilTemp", oil);
  note("load", load);

  // --- Wide-open-throttle detection -------------------------------------
  const wot: boolean[] = rows.map((row) => {
    const r = rpm ? row[rpm.idx] : NaN;
    if (rpm && !(r >= L.wotMinRpm)) return false;
    if (pedal) return row[pedal.idx] >= L.wotPedalPct;
    if (throttle) return row[throttle.idx] >= L.wotPedalPct - 10;
    return rpm ? r >= 3000 : true;
  });
  const detectedBy = pedal
    ? `pedal ≥ ${L.wotPedalPct}%${rpm ? ` and rpm ≥ ${L.wotMinRpm}` : ""}`
    : throttle
      ? `throttle ≥ ${L.wotPedalPct - 10}%${rpm ? ` and rpm ≥ ${L.wotMinRpm}` : ""}`
      : rpm
        ? "rpm ≥ 3000 (no pedal or throttle channel logged)"
        : "whole log (no rpm, pedal or throttle channel logged)";

  let pulls = 0;
  let wotRows = 0;
  let wotSeconds = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!wot[i]) continue;
    wotRows++;
    if (i === 0 || !wot[i - 1]) pulls++;
    if (i > 0 && wot[i - 1]) wotSeconds += Math.max(0, rows[i][0] - rows[i - 1][0]);
  }

  if (wotRows === 0) {
    findings.push({
      severity: "info",
      category: "coverage",
      message: "No full-throttle driving found in this log, so knock, fuelling and boost under load can't be judged. Log a 3rd-gear pull from ~2500 rpm to redline.",
    });
  }

  const at = (row: number[]): Finding["at"] => ({ time: row[0], ...(rpm ? { rpm: Math.round(row[rpm.idx]) } : {}) });
  const when = (a: Finding["at"]) => (a ? ` at t=${r2(a.time ?? 0)}s${a.rpm !== undefined ? `, ${a.rpm} rpm` : ""}` : "");

  // --- Knock / timing corrections ----------------------------------------
  const perCyl: Array<{ column: string; worst: number; events: number; at?: Finding["at"] }> = [];
  for (const ch of timingCorr) {
    let worstMag = 0;
    let worstAt: Finding["at"];
    let events = 0;
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][ch.idx];
      if (!Number.isFinite(v)) continue;
      // Retard is logged negative by some tools and positive by others.
      const mag = Math.abs(v);
      if (wot[i] && mag >= L.timingCorrEventDeg) events++;
      if (mag > worstMag) {
        worstMag = mag;
        worstAt = at(rows[i]);
      }
    }
    perCyl.push({ column: ch.column, worst: worstMag, events, at: worstAt });
  }
  if (perCyl.length) {
    const w = perCyl.reduce((a, b) => (b.worst > a.worst ? b : a));
    const sev = severityFor(w.worst, L.timingCorrWarnDeg, L.timingCorrCritDeg);
    const totalEvents = perCyl.reduce((s, c) => s + c.events, 0);
    if (sev) {
      findings.push({
        severity: sev,
        category: "knock",
        at: w.at,
        message: `Knock: up to ${r2(w.worst)}° of timing pulled on ${w.column}${when(w.at)} (${totalEvents} correction samples ≥ ${L.timingCorrEventDeg}° at full throttle). ${sev === "critical" ? "That's heavy knock — back off timing or check fuel quality before driving hard again." : "Repeated corrections this size mean the tune is too aggressive for the fuel."}`,
      });
    } else {
      findings.push({ severity: "info", category: "knock", message: `Knock: worst correction ${r2(w.worst)}° — within limits.` });
    }
    // One cylinder doing all the knocking points at hardware rather than the tune.
    if (perCyl.length >= 3 && totalEvents >= 5) {
      const top = perCyl.reduce((a, b) => (b.events > a.events ? b : a));
      if (top.events / totalEvents >= 0.7) {
        findings.push({
          severity: "warning",
          category: "knock",
          message: `Most knock corrections (${top.events}/${totalEvents}) are on ${top.column}. A single cylinder like that usually means a worn spark plug, failing coil or a leaking injector on that cylinder.`,
        });
      }
    }
  }

  // --- Mixture ------------------------------------------------------------
  if (lambdaAct) {
    const isAfr = median(rows.map((r) => r[lambdaAct.idx])) > 5;
    const lam = (v: number) => (isAfr ? v / 14.7 : v);
    const lean = sustained(rows, wot, (row) => {
      const v = lam(row[lambdaAct.idx]);
      return v > L.wotLambdaWarn && (!rpm || row[rpm.idx] >= 3000) ? v : null;
    }, L.sustainSamples);
    if (lean) {
      const sev = lean.value > L.wotLambdaCrit ? "critical" : "warning";
      findings.push({
        severity: sev,
        category: "fuel",
        at: { time: lean.time },
        message: `Lean at full throttle: lambda reached ${r2(lean.value)} (≈${r2(lean.value * 14.7)}:1 AFR) starting t=${r2(lean.time)}s. An N20 at full load should be around 0.78–0.85. ${sev === "critical" ? "Lean full-load running melts pistons — stop and find the cause (fuel pump, injectors, boost leak, tune)." : ""}`.trim(),
      });
    }
    if (lambdaTarget) {
      // The predicate must return null when the condition is not met, or every WOT
      // row extends the run and one noisy sample becomes "sustained".
      const dev = sustained(rows, wot, (row) => {
        const d = lam(row[lambdaAct.idx]) - lam(row[lambdaTarget.idx]);
        return d > L.leanVsTargetWarn ? d : null;
      }, L.sustainSamples);
      if (dev) {
        const sev = dev.value > L.leanVsTargetCrit ? "critical" : "warning";
        findings.push({
          severity: sev,
          category: "fuel",
          at: { time: dev.time },
          message: `Mixture ran ${r2(dev.value)} lambda leaner than the ECU asked for, starting t=${r2(dev.time)}s. The fuel system isn't keeping up with the tune.`,
        });
      }
    }
  }

  // --- Fuel pressure ------------------------------------------------------
  if (rail) {
    const unit = pressureUnit(rail.unit, percentile(rows.map((r) => r[rail.idx]), 0.5));
    let minWot = Infinity;
    let minAt: Finding["at"];
    let worstFrac = Infinity;
    let fracAt: Finding["at"];
    for (let i = 0; i < rows.length; i++) {
      if (!wot[i]) continue;
      const v = rows[i][rail.idx] * toBar[unit];
      if (Number.isFinite(v) && v < minWot) {
        minWot = v;
        minAt = at(rows[i]);
      }
      if (railTarget) {
        const tUnit = pressureUnit(railTarget.unit, rows[i][railTarget.idx]);
        const t = rows[i][railTarget.idx] * toBar[tUnit];
        if (t > 0 && Number.isFinite(v) && v / t < worstFrac) {
          worstFrac = v / t;
          fracAt = at(rows[i]);
        }
      }
    }
    if (Number.isFinite(worstFrac)) {
      const sev = worstFrac < L.railPressureCritFraction ? "critical" : worstFrac < L.railPressureWarnFraction ? "warning" : null;
      if (sev) {
        findings.push({ severity: sev, category: "fuel", at: fracAt, message: `High-pressure fuel dropped to ${Math.round(worstFrac * 100)}% of target${when(fracAt)}. The stock HPFP is at its limit — reduce load or have the pump checked.` });
      }
    } else if (Number.isFinite(minWot)) {
      const sev = minWot < L.railPressureCritBar ? "critical" : minWot < L.railPressureWarnBar ? "warning" : null;
      if (sev) {
        findings.push({ severity: sev, category: "fuel", at: minAt, message: `High-pressure fuel dropped to ${Math.round(minWot)} bar${when(minAt)} at full throttle (N20 normally holds ~200 bar).` });
      }
    }
  }
  if (lpfp) {
    const unit = pressureUnit(lpfp.unit, percentile(rows.map((r) => r[lpfp.idx]), 0.5));
    let min = Infinity;
    let minAt: Finding["at"];
    for (let i = 0; i < rows.length; i++) {
      if (!wot[i]) continue;
      const v = rows[i][lpfp.idx] * toBar[unit];
      if (Number.isFinite(v) && v < min) {
        min = v;
        minAt = at(rows[i]);
      }
    }
    if (Number.isFinite(min)) {
      const sev = min < L.lowPressureCritBar ? "critical" : min < L.lowPressureWarnBar ? "warning" : null;
      if (sev) {
        findings.push({ severity: sev, category: "fuel", at: minAt, message: `Low-pressure fuel (in-tank pump) dropped to ${r2(min)} bar${when(minAt)}. Below ~4 bar the high-pressure pump starts to starve.` });
      }
    }
  }

  // --- Boost --------------------------------------------------------------
  const performance: Record<string, unknown> = {};
  if (boost) {
    const vals = rows.map((r) => r[boost.idx]);
    const unit = pressureUnit(boost.unit, percentile(vals, 0.5));
    const absolute = isAbsolutePressure(boost, unit, vals);
    const gauge = (v: number, u: PressureUnit = unit) => v * toPsi[u] - (absolute ? 14.7 : 0);
    let peak = -Infinity;
    let peakAt: Finding["at"];
    for (let i = 0; i < rows.length; i++) {
      const g = gauge(rows[i][boost.idx]);
      if (Number.isFinite(g) && g > peak) {
        peak = g;
        peakAt = at(rows[i]);
      }
    }
    if (Number.isFinite(peak)) {
      performance.peakBoostPsi = r2(peak);
      performance.peakBoostAt = peakAt;
      const sev = severityFor(peak, L.peakBoostWarnPsi, L.peakBoostCritPsi);
      if (sev) {
        findings.push({ severity: sev, category: "boost", at: peakAt, message: `Peak boost ${r2(peak)} psi${when(peakAt)} is high for the stock N20 turbo (warn above ${L.peakBoostWarnPsi}, stop above ${L.peakBoostCritPsi} psi).` });
      }
    }
    if (boostTarget) {
      const tUnit = pressureUnit(boostTarget.unit, percentile(rows.map((r) => r[boostTarget.idx]), 0.5));
      const tAbsolute = isAbsolutePressure(boostTarget, tUnit, rows.map((r) => r[boostTarget.idx]));
      const over = sustained(
        rows,
        wot,
        (row) => {
          const d = gauge(row[boost.idx]) - (row[boostTarget.idx] * toPsi[tUnit] - (tAbsolute ? 14.7 : 0));
          return d > L.boostOvershootWarnPsi ? d : null;
        },
        L.sustainSamples
      );
      if (over) {
        const sev = over.value > L.boostOvershootCritPsi ? "critical" : "warning";
        findings.push({ severity: sev, category: "boost", at: { time: over.time }, message: `Boost overshot target by ${r2(over.value)} psi starting t=${r2(over.time)}s. Overshoot spikes cylinder pressure — check the wastegate and boost control.` });
      }
      // Spool: lowest rpm at full throttle where boost came within 1 psi of target.
      if (rpm) {
        let spoolRpm = Infinity;
        for (let i = 0; i < rows.length; i++) {
          if (!wot[i]) continue;
          const tgt = rows[i][boostTarget.idx] * toPsi[tUnit] - (tAbsolute ? 14.7 : 0);
          if (tgt > 3 && gauge(rows[i][boost.idx]) >= tgt - 1) spoolRpm = Math.min(spoolRpm, rows[i][rpm.idx]);
        }
        if (Number.isFinite(spoolRpm)) performance.reachesBoostTargetFromRpm = Math.round(spoolRpm);
      }
    }
  }

  // --- Temperatures -------------------------------------------------------
  const tempCheck = (ch: Channel | null, label: string, warn: number, crit: number, advice: string) => {
    if (!ch) return;
    let max = -Infinity;
    let maxAt: Finding["at"];
    for (const row of rows) {
      const v = toCelsius(row[ch.idx], ch.unit);
      if (Number.isFinite(v) && v > max) {
        max = v;
        maxAt = at(row);
      }
    }
    if (!Number.isFinite(max)) return;
    performance[`max${label.replace(/\s/g, "")}C`] = r2(max);
    const sev = severityFor(max, warn, crit);
    if (sev) findings.push({ severity: sev, category: "temperature", at: maxAt, message: `${label} reached ${r2(max)}°C${when(maxAt)}. ${advice}` });
  };
  tempCheck(iat, "Intake Air Temp", L.iatWarnC, L.iatCritC, "Hot intake air knocks more easily on 91 — the stock intercooler heat-soaks; let it cool between pulls.");
  tempCheck(coolant, "Coolant Temp", L.coolantWarnC, L.coolantCritC, "Check the cooling system before driving hard.");
  tempCheck(oil, "Oil Temp", L.oilWarnC, L.oilCritC, "Oil this hot thins out and protects bearings poorly.");

  if (oil && wotRows) {
    let coldest = Infinity;
    let coldAt: Finding["at"];
    for (let i = 0; i < rows.length; i++) {
      if (!wot[i]) continue;
      const v = toCelsius(rows[i][oil.idx], oil.unit);
      if (Number.isFinite(v) && v < coldest) {
        coldest = v;
        coldAt = at(rows[i]);
      }
    }
    if (coldest < L.coldOilC) {
      findings.push({ severity: "warning", category: "temperature", at: coldAt, message: `Full-throttle run with oil at only ${r2(coldest)}°C${when(coldAt)}. Wait for oil to reach ~${L.coldOilC}°C+ before pulls.` });
    }
  }

  // --- Performance summary ------------------------------------------------
  if (rpm) {
    let maxRpm = -Infinity;
    for (const row of rows) if (row[rpm.idx] > maxRpm) maxRpm = row[rpm.idx];
    if (Number.isFinite(maxRpm)) performance.maxRpm = Math.round(maxRpm);
  }
  if (timing && wotRows) {
    const t = rows.filter((_, i) => wot[i]).map((r) => r[timing.idx]).filter(Number.isFinite);
    if (t.length) {
      performance.avgWotTimingDeg = r2(t.reduce((s, v) => s + v, 0) / t.length);
      performance.minWotTimingDeg = r2(Math.min(...t));
      performance.maxWotTimingDeg = r2(Math.max(...t));
    }
  }
  if (load) {
    let maxLoad = -Infinity;
    for (const row of rows) if (row[load.idx] > maxLoad) maxLoad = row[load.idx];
    if (Number.isFinite(maxLoad)) performance.peakLoad = r2(maxLoad);
  }
  if (lambdaAct && wotRows) {
    const isAfr = median(rows.map((r) => r[lambdaAct.idx])) > 5;
    const l = rows.filter((_, i) => wot[i]).map((r) => r[lambdaAct.idx] / (isAfr ? 14.7 : 1)).filter(Number.isFinite);
    if (l.length) performance.avgWotLambda = r2(l.reduce((s, v) => s + v, 0) / l.length);
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const crit = findings.filter((f) => f.severity === "critical").length;
  const warn = findings.filter((f) => f.severity === "warning").length;
  const verdict = crit ? "STOP" : warn ? "WATCH" : "OK";
  const summary =
    verdict === "STOP"
      ? `${crit} serious problem(s) found. Don't drive the car hard until they're fixed.`
      : verdict === "WATCH"
        ? `No serious problems, but ${warn} thing(s) to keep an eye on.`
        : wotRows
          ? "Nothing outside the safety limits in this log."
          : "Nothing unsafe found, but the log has no full-throttle driving to judge.";

  return {
    profile: profile.name,
    verdict,
    summary,
    wot: { rows: wotRows, pulls, seconds: r2(wotSeconds), detectedBy },
    performance,
    findings,
    channelsUsed: used,
    channelsMissing: missing,
  };
}
