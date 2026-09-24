import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as Plan from "../../src/domain/plan.js";
import type { Db, ObservationInput } from "../../src/domain/model.js";

export const BASE_MS = Date.parse("2026-09-20T08:00:00.000Z");
export const iso = (offsetSeconds = 0): string => new Date(BASE_MS + offsetSeconds * 1000).toISOString();

export function openTestDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  const db = new DatabaseSync(join(dir, "release.sqlite3"));
  db.exec("PRAGMA foreign_keys = ON;");
  const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

export interface World {
  db: Db;
  designId: string;
  baselineId: string;
  calibrationId: string;
  zoneA: string;
  zoneB: string;
  zoneC: string;
  crewA: string;
  crewB: string;
  crewC: string;
  /** 测量复核人 */
  surveyor: string;
  /** 第二名测量复核人（自批场景换签） */
  surveyor2: string;
  /** 监理 */
  supervisor: string;
  /** 承包方持证提交人（测量角色，用于自批校验） */
  submitter: string;
  stepA1: string;
  stepA2: string;
  stepB1: string;
}

/** 经典场景：两区重叠 A-B，A 区有前置链 A1→A2，B 区独立 B1 */
export function seedWorld(db: Db): World {
  const designId = Plan.createDesignVersion(db, { id: "d1", label: "设计-甲-初版" });
  const baselineId = Plan.createBaseline(db, {
    id: "b1",
    designVersionId: designId,
    label: "BL-廊桥",
    revision: 1,
  });
  const calibrationId = Plan.createCalibration(db, {
    id: "c1",
    instrumentCode: "全站仪-07",
    versionLabel: "CAL-2026-09-01",
    calibratedAt: iso(-3600 * 24 * 10),
  });
  const zoneA = Plan.createWorkZone(db, { id: "z-a", code: "A段", name: "北岸廊桥顶升段" });
  const zoneB = Plan.createWorkZone(db, { id: "z-b", code: "B段", name: "中墩廊桥顶升段" });
  const zoneC = Plan.createWorkZone(db, { id: "z-c", code: "C段", name: "南岸廊桥顶升段" });
  Plan.markOverlap(db, zoneA, zoneB);

  const crewA = Plan.createCrew(db, { id: "k-a", name: "甲班顶升组" });
  const crewB = Plan.createCrew(db, { id: "k-b", name: "乙班顶升组" });
  const crewC = Plan.createCrew(db, { id: "k-c", name: "丙班监测组" });

  const surveyor = Plan.createUser(db, { id: "u-survey", name: "测量复核人 林某", role: "SURVEY_REVIEWER" });
  const surveyor2 = Plan.createUser(db, { id: "u-survey-2", name: "测量复核人 顾某", role: "SURVEY_REVIEWER" });
  const supervisor = Plan.createUser(db, { id: "u-sup", name: "监理 方某", role: "SUPERVISOR" });
  const submitter = Plan.createUser(db, { id: "u-sub", name: "承包方测量员 童某", role: "SURVEY_REVIEWER" });

  const points = [
    { code: "P1", x: 0, y: 0, z: 0 },
    { code: "P2", x: 1, y: 0, z: 0 },
  ];
  const stepA1 = Plan.registerStep(db, {
    id: "s-a1",
    zoneId: zoneA,
    crewId: crewA,
    code: "A1-支顶",
    title: "A段支顶停检点",
    designVersionId: designId,
    controlPoints: points,
    displacementToleranceMm: 5,
    settlementToleranceMm: 3,
    observationValiditySeconds: 3600,
  });
  const stepA2 = Plan.registerStep(db, {
    id: "s-a2",
    zoneId: zoneA,
    crewId: crewA,
    code: "A2-顶升至高程",
    title: "A段顶升至设计高程",
    designVersionId: designId,
    prerequisiteStepIds: [stepA1],
    controlPoints: points,
    displacementToleranceMm: 5,
    settlementToleranceMm: 3,
    observationValiditySeconds: 3600,
  });
  const stepB1 = Plan.registerStep(db, {
    id: "s-b1",
    zoneId: zoneB,
    crewId: crewB,
    code: "B1-同步顶升",
    title: "B段同步顶升停检点",
    designVersionId: designId,
    controlPoints: points,
    displacementToleranceMm: 5,
    settlementToleranceMm: 3,
    observationValiditySeconds: 3600,
  });

  return {
    db,
    designId,
    baselineId,
    calibrationId,
    zoneA,
    zoneB,
    zoneC,
    crewA,
    crewB,
    crewC,
    surveyor,
    surveyor2,
    supervisor,
    submitter,
    stepA1,
    stepA2,
    stepB1,
  };
}

/** 合格观测：零位移零沉降，序号与坐标齐全 */
export function goodObservations(): ObservationInput[] {
  return [
    { pointCode: "P1", sequenceNo: 1, x: 0, y: 0, z: 0, displacementMm: 0, settlementMm: 0 },
    { pointCode: "P2", sequenceNo: 2, x: 1, y: 0, z: 0, displacementMm: 0.2, settlementMm: -0.1 },
  ];
}

/** 超差观测：P1 位移 9mm（容差 5） */
export function outOfToleranceObservations(): ObservationInput[] {
  return [
    { pointCode: "P1", sequenceNo: 1, x: 0.009, y: 0, z: 0.004, displacementMm: 9, settlementMm: 4 },
    { pointCode: "P2", sequenceNo: 2, x: 1, y: 0, z: 0, displacementMm: 0.2, settlementMm: -0.1 },
  ];
}

/** 缺项观测：缺 P2，P1 无坐标 */
export function incompleteObservations(): ObservationInput[] {
  return [{ pointCode: "P1", sequenceNo: null, displacementMm: 0, settlementMm: 0 }];
}

export function blockerCodes(result: { blockers: { code: string }[] }): string[] {
  return result.blockers.map((b) => b.code);
}
