import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TableEntryLike, TableTreeLike } from "./compare.js";
import type { ParsedDatalog } from "./datalog.js";
import { DEFAULT_PROFILE, assessDatalog, assessTune, classifyTable, mergeProfile, structuralFindings } from "./safety.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RPM = [1000, 2000, 3000, 4000, 5000, 6000];
const LOAD = [50, 100, 150];

function table(
  extId: string,
  id: string,
  name: string,
  values: number[][],
  extra: Partial<TableEntryLike["def"]> = {}
): TableEntryLike {
  return {
    def: {
      extId,
      id,
      name,
      hasXAxis: true,
      hasYAxis: true,
      xAxisName: "Engine Speed",
      yAxisName: "Load",
      min: -20,
      max: 60,
      core: true,
      ...extra,
    },
    rows: values.map((v) => ({ values: v })),
    hAxis: { values: RPM.slice(0, values[0].length) },
    vAxis: { values: LOAD.slice(0, values.length) },
  };
}

const fill = (v: number) => LOAD.map(() => RPM.map(() => v));

function map(engineType: string, tables: Record<string, TableEntryLike>): TableTreeLike {
  return { mapId: engineType, engineType, nodes: [], tableData: tables };
}

function stockMap(): TableTreeLike {
  return map("N20-EWG-H-P", {
    ign: table("ign", "KF_ZW_PF1", "Base Ignition Timing (Full Load - Warm)", fill(10)),
    lam: table("lam", "KF_LABAS_2", "Lambda Target Bank 2", fill(0.82), { min: 0.5, max: 1.5 }),
    boost: table("boost", "KFLDHBN", "Boost Pressure Target", fill(2000), { min: 900, max: 3000, units: "hPa" }),
    knock: table("knock", "KFRKRMX1N", "Knock Threshold", fill(5)),
    other: table("other", "FKKVS", "Correction Factor", fill(1), { min: 0, max: 2 }),
  });
}

function withChange(base: TableTreeLike, extId: string, values: number[][]): TableTreeLike {
  const t = base.tableData[extId];
  return { ...base, tableData: { ...base.tableData, [extId]: { ...t, rows: values.map((v) => ({ values: v })) } } };
}

function bump(v: number, row: number, col: number, to: number): number[][] {
  const g = fill(v);
  g[row][col] = to;
  return g;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("classifyTable", () => {
  test("recognizes MEVD17 ids and English names", () => {
    assert.equal(classifyTable({ id: "KF_ZW_PF1" }), "ignition");
    assert.equal(classifyTable({ name: "Base Ignition Timing" }), "ignition");
    assert.equal(classifyTable({ id: "KFRKRMX1N" }), "knock");
    assert.equal(classifyTable({ name: "Lambda Target Bank 2" }), "lambda");
    assert.equal(classifyTable({ name: "Boost Pressure Target" }), "boost");
    assert.equal(classifyTable({ name: "Rev Limiter (Gear 3)" }), "rev_limit");
    assert.equal(classifyTable({ name: "Component Protection Lambda" }), "protection");
    assert.equal(classifyTable({ name: "Correction Factor", id: "FKKVS" }), null);
  });

  test("knock timing tables are knock, not ignition", () => {
    assert.equal(classifyTable({ name: "Knock Retard Ignition Timing" }), "knock");
  });
});

// ---------------------------------------------------------------------------
// tune assessment
// ---------------------------------------------------------------------------

describe("assessTune", () => {
  test("identical maps are OK with no findings", () => {
    const r = assessTune(stockMap(), stockMap());
    assert.equal(r.verdict, "OK");
    assert.equal(r.counts.changedTables, 0);
  });

  test("small timing increase is info, moderate is warning, large is critical", () => {
    const small = assessTune(stockMap(), withChange(stockMap(), "ign", bump(10, 2, 3, 11)));
    assert.equal(small.verdict, "OK");

    const mid = assessTune(stockMap(), withChange(stockMap(), "ign", bump(10, 2, 3, 12)));
    assert.equal(mid.verdict, "REVIEW");

    const big = assessTune(stockMap(), withChange(stockMap(), "ign", bump(10, 2, 3, 14)));
    assert.equal(big.verdict, "UNSAFE");
    const f = big.findings.find((x) => x.category === "ignition")!;
    assert.equal(f.severity, "critical");
    assert.equal(f.at?.rpm, 4000);
    assert.equal(f.at?.load, 150);
  });

  test("retarding timing is never a problem", () => {
    const r = assessTune(stockMap(), withChange(stockMap(), "ign", fill(6)));
    assert.equal(r.verdict, "OK");
  });

  test("leaner lambda is flagged, richer is not", () => {
    const lean = assessTune(stockMap(), withChange(stockMap(), "lam", bump(0.82, 2, 5, 0.9)));
    assert.equal(lean.verdict, "UNSAFE");
    const rich = assessTune(stockMap(), withChange(stockMap(), "lam", fill(0.78)));
    assert.equal(rich.verdict, "OK");
  });

  test("boost: percentage increase and absolute ceiling", () => {
    // +5% → under the 10% warn, but 2100 hPa is under the absolute limit too.
    assert.equal(assessTune(stockMap(), withChange(stockMap(), "boost", bump(2000, 2, 4, 2100))).verdict, "OK");
    // 2500 hPa is +25% and above the 2450 hPa absolute ceiling.
    const r = assessTune(stockMap(), withChange(stockMap(), "boost", bump(2000, 2, 4, 2500)));
    assert.equal(r.verdict, "UNSAFE");
    assert.ok(r.findings.filter((f) => f.category === "boost" && f.severity === "critical").length >= 2);
  });

  test("any knock-table change is critical", () => {
    const r = assessTune(stockMap(), withChange(stockMap(), "knock", bump(5, 0, 0, 6)));
    assert.equal(r.verdict, "UNSAFE");
    assert.equal(r.findings[0].category, "knock");
  });

  test("uncategorized changes are listed, not hidden", () => {
    const r = assessTune(stockMap(), withChange(stockMap(), "other", bump(1, 0, 0, 1.05)));
    assert.equal(r.verdict, "OK");
    assert.equal(r.uncategorized.length, 1);
    assert.equal(r.uncategorized[0].extId, "other");
  });

  test("onlyExtIds scopes the check to the tables being saved", () => {
    let proposed = withChange(stockMap(), "ign", bump(10, 2, 3, 14));
    proposed = withChange(proposed, "other", bump(1, 0, 0, 1.05));
    const r = assessTune(stockMap(), proposed, { onlyExtIds: ["other"] });
    assert.equal(r.verdict, "OK");
    assert.equal(r.counts.changedTables, 1);
  });

  test("wrong engine gets a profile warning", () => {
    const other = { ...stockMap(), engineType: "B58-TU" };
    const r = assessTune(stockMap(), other);
    assert.ok(r.findings.some((f) => f.category === "profile"));
  });

  test("cumulative change from stock is judged, not just the last edit", () => {
    // Current tune is already +2.5°; adding 1° more is +3.5° from stock.
    const r = assessTune(stockMap(), withChange(stockMap(), "ign", bump(10, 1, 1, 13.5)));
    assert.equal(r.verdict, "UNSAFE");
  });
});

describe("structuralFindings", () => {
  test("out-of-range and NaN values are critical", () => {
    const t = table("ign", "KF_ZW_PF1", "Ignition", bump(10, 0, 0, 99));
    assert.equal(structuralFindings("ign", t, undefined)[0].severity, "critical");
    const n = table("ign", "KF_ZW_PF1", "Ignition", bump(10, 0, 0, NaN));
    assert.ok(structuralFindings("ign", n, undefined).some((f) => f.message.includes("not numbers")));
  });

  test("a typo-sized jump is flagged unless the reference has the same step", () => {
    const typo = table("ign", "KF_ZW_PF1", "Ignition", bump(10, 1, 2, 40));
    assert.ok(structuralFindings("ign", typo, undefined).some((f) => f.message.includes("sudden jump")));
    assert.equal(structuralFindings("ign", typo, typo).length, 0);
  });
});

describe("mergeProfile", () => {
  test("overrides only known numeric keys", () => {
    const p = mergeProfile({ tune: { ignitionCritDeg: 5, bogus: 1, ignitionWarnDeg: "x" }, log: { iatWarnC: 45 } });
    assert.equal(p.tune.ignitionCritDeg, 5);
    assert.equal(p.tune.ignitionWarnDeg, DEFAULT_PROFILE.tune.ignitionWarnDeg);
    assert.equal(p.log.iatWarnC, 45);
    assert.equal((p.tune as unknown as Record<string, unknown>).bogus, undefined);
  });
});

// ---------------------------------------------------------------------------
// datalog assessment
// ---------------------------------------------------------------------------

type Sample = Partial<Record<string, number>>;

const COLS = [
  "Time [s]",
  "RPM [1/min]",
  "Accel. Pedal [%]",
  "Boost (Pre-Throttle) [psi]",
  "Boost Target [psi]",
  "Lambda Act. (Bank 1) [-]",
  "Lambda Target [-]",
  "Ignition Timing Corr. Cyl. 1 [°]",
  "Ignition Timing Corr. Cyl. 2 [°]",
  "Ignition Timing Corr. Cyl. 3 [°]",
  "Ignition Timing Corr. Cyl. 4 [°]",
  "Ignition Timing [°]",
  "Rail Pressure [bar]",
  "IAT [°C]",
  "Oil Temp [°C]",
];

function log(samples: Sample[]): ParsedDatalog {
  const defaults: Sample = {
    "RPM [1/min]": 4000,
    "Accel. Pedal [%]": 100,
    "Boost (Pre-Throttle) [psi]": 16,
    "Boost Target [psi]": 16,
    "Lambda Act. (Bank 1) [-]": 0.82,
    "Lambda Target [-]": 0.82,
    "Ignition Timing Corr. Cyl. 1 [°]": 0,
    "Ignition Timing Corr. Cyl. 2 [°]": 0,
    "Ignition Timing Corr. Cyl. 3 [°]": 0,
    "Ignition Timing Corr. Cyl. 4 [°]": 0,
    "Ignition Timing [°]": 8,
    "Rail Pressure [bar]": 200,
    "IAT [°C]": 30,
    "Oil Temp [°C]": 95,
  };
  return {
    id: "test",
    columns: COLS,
    rows: samples.map((s, i) => COLS.map((c) => (c === "Time [s]" ? i * 0.1 : (s[c] ?? defaults[c] ?? NaN)))),
  };
}

const steady = (n: number, s: Sample = {}) => Array.from({ length: n }, () => ({ ...s }));

describe("assessDatalog", () => {
  test("a clean pull is OK and reports performance", () => {
    const r = assessDatalog(log([...steady(5, { "Accel. Pedal [%]": 10, "RPM [1/min]": 1500 }), ...steady(20)]));
    assert.equal(r.verdict, "OK");
    assert.equal(r.wot.pulls, 1);
    assert.equal(r.performance.peakBoostPsi, 16);
    assert.equal(r.performance.avgWotTimingDeg, 8);
    assert.equal(r.channelsMissing.includes("lowPressureFuel"), true);
  });

  test("heavy knock is STOP, moderate is WATCH", () => {
    const heavy = assessDatalog(log([...steady(10), { "Ignition Timing Corr. Cyl. 2 [°]": -6 }]));
    assert.equal(heavy.verdict, "STOP");
    assert.equal(heavy.findings[0].category, "knock");
    const mid = assessDatalog(log([...steady(10), { "Ignition Timing Corr. Cyl. 2 [°]": -3.5 }]));
    assert.equal(mid.verdict, "WATCH");
  });

  test("knock concentrated on one cylinder is called out", () => {
    const r = assessDatalog(log(steady(10, { "Ignition Timing Corr. Cyl. 3 [°]": -2 })));
    assert.ok(r.findings.some((f) => f.message.includes("single cylinder") || f.message.includes("Cyl. 3")));
  });

  test("sustained lean at WOT is critical; a single noisy sample is not", () => {
    const lean = assessDatalog(log(steady(5, { "Lambda Act. (Bank 1) [-]": 0.95 })));
    assert.equal(lean.verdict, "STOP");
    const blip = assessDatalog(log([...steady(5), { "Lambda Act. (Bank 1) [-]": 0.95 }, ...steady(5)]));
    assert.equal(blip.findings.filter((f) => f.category === "fuel").length, 0);
  });

  test("rail pressure drop and boost overshoot are caught", () => {
    const rail = assessDatalog(log(steady(5, { "Rail Pressure [bar]": 110 })));
    assert.ok(rail.findings.some((f) => f.category === "fuel" && f.severity === "critical"));
    const over = assessDatalog(log(steady(5, { "Boost (Pre-Throttle) [psi]": 20, "Boost Target [psi]": 16 })));
    assert.ok(over.findings.some((f) => f.category === "boost" && f.severity === "critical"));
  });

  test("hot intake air and cold-oil pulls are flagged", () => {
    const r = assessDatalog(log(steady(5, { "IAT [°C]": 70, "Oil Temp [°C]": 50 })));
    assert.ok(r.findings.some((f) => f.message.startsWith("Intake Air Temp") && f.severity === "critical"));
    assert.ok(r.findings.some((f) => f.message.includes("oil at only")));
  });

  test("no full-throttle driving says so instead of claiming it's safe", () => {
    const r = assessDatalog(log(steady(10, { "Accel. Pedal [%]": 20 })));
    assert.equal(r.wot.rows, 0);
    assert.ok(r.summary.includes("no full-throttle"));
  });
});
