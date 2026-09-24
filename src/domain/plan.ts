import type { ControlPoint, Db, Role } from "./model.js";
import { badRequest, conflict, newId, notFound, parseJsonArray, transaction } from "./model.js";

export function createCrew(db: Db, input: { id?: string; name: string }): string {
  const id = input.id ?? newId();
  db.prepare("INSERT INTO crews (id, name) VALUES (?, ?)").run(id, input.name);
  return id;
}

export function createUser(db: Db, input: { id?: string; name: string; role: Role }): string {
  if (!input.name?.trim()) throw badRequest("INVALID_NAME", "人员姓名不能为空");
  const id = input.id ?? newId();
  db.prepare("INSERT INTO users (id, name, role) VALUES (?, ?, ?)").run(id, input.name, input.role);
  return id;
}

export function createDesignVersion(
  db: Db,
  input: { id?: string; label: string; supersedesId?: string | null },
): string {
  const id = input.id ?? newId();
  let supersedes: string | null = input.supersedesId ?? null;
  if (supersedes) {
    const prior = db.prepare("SELECT id FROM design_versions WHERE id = ?").get(supersedes);
    if (!prior) throw notFound("DESIGN_NOT_FOUND", `被换版的设计版本 ${supersedes} 不存在`);
  }
  try {
    db.prepare("INSERT INTO design_versions (id, label, supersedes_id) VALUES (?, ?, ?)").run(
      id,
      input.label,
      supersedes,
    );
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE"))
      throw conflict("DESIGN_LABEL_EXISTS", `设计版本 ${input.label} 已存在`);
    throw error;
  }
  return id;
}

export function createBaseline(
  db: Db,
  input: { id?: string; designVersionId: string; label: string; revision?: number },
): string {
  assertDesignExists(db, input.designVersionId);
  const revision = input.revision ?? 1;
  const id = input.id ?? newId();
  try {
    db.prepare(
      "INSERT INTO baselines (id, design_version_id, label, revision) VALUES (?, ?, ?, ?)",
    ).run(id, input.designVersionId, input.label, revision);
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE"))
      throw conflict("BASELINE_EXISTS", `基线 ${input.label} 修订 ${revision} 已存在`);
    throw error;
  }
  return id;
}

export function createCalibration(
  db: Db,
  input: { id?: string; instrumentCode: string; versionLabel: string; calibratedAt: string },
): string {
  if (Number.isNaN(Date.parse(input.calibratedAt)))
    throw badRequest("INVALID_TIME", "校准时间无法解析");
  const id = input.id ?? newId();
  try {
    db.prepare(
      `INSERT INTO calibrations (id, instrument_code, version_label, calibrated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, input.instrumentCode, input.versionLabel, input.calibratedAt);
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE"))
      throw conflict("CALIBRATION_EXISTS", `仪器 ${input.instrumentCode} 的校准版本 ${input.versionLabel} 已存在`);
    throw error;
  }
  return id;
}

export function createWorkZone(db: Db, input: { id?: string; code: string; name: string }): string {
  const id = input.id ?? newId();
  try {
    db.prepare("INSERT INTO work_zones (id, code, name) VALUES (?, ?, ?)").run(
      id,
      input.code,
      input.name,
    );
  } catch (error: any) {
    if (String(error?.message).includes("UNIQUE"))
      throw conflict("ZONE_EXISTS", `工作区 ${input.code} 已存在`);
    throw error;
  }
  return id;
}

/** 登记两个工作区几何重叠（租约争用与相邻冲突据此传播） */
export function markOverlap(db: Db, zoneAId: string, zoneBId: string): void {
  if (zoneAId === zoneBId) throw badRequest("SELF_OVERLAP", "工作区不能与自身重叠");
  const [a, b] = [zoneAId, zoneBId].sort();
  for (const id of [a, b])
    if (!db.prepare("SELECT 1 FROM work_zones WHERE id = ?").get(id))
      throw notFound("ZONE_NOT_FOUND", `工作区 ${id} 不存在`);
  db.prepare("INSERT OR IGNORE INTO work_zone_overlaps (zone_a_id, zone_b_id) VALUES (?, ?)").run(
    a,
    b,
  );
}

export interface RegisterStepInput {
  id?: string;
  zoneId: string;
  crewId: string;
  code: string;
  title: string;
  designVersionId: string;
  prerequisiteStepIds?: string[];
  controlPoints?: ControlPoint[];
  displacementToleranceMm: number;
  settlementToleranceMm: number;
  observationValiditySeconds: number;
}

/** 为工作区登记工序/停检点：前置工序、控制点集合、位移与沉降容差、观测时效 */
export function registerStep(db: Db, input: RegisterStepInput): string {
  return transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM work_zones WHERE id = ?").get(input.zoneId))
      throw notFound("ZONE_NOT_FOUND", `工作区 ${input.zoneId} 不存在`);
    if (!db.prepare("SELECT 1 FROM crews WHERE id = ?").get(input.crewId))
      throw notFound("CREW_NOT_FOUND", `班组 ${input.crewId} 不存在`);
    assertDesignExists(db, input.designVersionId);

    const prerequisites = input.prerequisiteStepIds ?? [];
    for (const prereqId of prerequisites) {
      const prereq = db
        .prepare("SELECT id, zone_id FROM work_steps WHERE id = ?")
        .get(prereqId) as { id: string; zone_id: string } | undefined;
      if (!prereq) throw notFound("PREREQUISITE_NOT_FOUND", `前置工序 ${prereqId} 不存在`);
      if (prereq.zone_id !== input.zoneId)
        throw badRequest("PREREQUISITE_ZONE_MISMATCH", `前置工序 ${prereqId} 不在同一工作区`);
    }

    for (const point of input.controlPoints ?? [])
      if (
        typeof point.code !== "string" ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isFinite(point.z)
      )
        throw badRequest("INVALID_CONTROL_POINT", `控制点 ${point.code} 坐标不完整`);

    if (
      !(input.displacementToleranceMm >= 0) ||
      !(input.settlementToleranceMm >= 0) ||
      input.observationValiditySeconds <= 0
    )
      throw badRequest("INVALID_TOLERANCE", "容差与观测时效必须为非负/正数");

    const id = input.id ?? newId();
    try {
      db.prepare(
        `INSERT INTO work_steps
           (id, zone_id, crew_id, code, title, design_version_id, prerequisite_step_ids,
            control_points, displacement_tolerance_mm, settlement_tolerance_mm,
            observation_validity_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.zoneId,
        input.crewId,
        input.code,
        input.title,
        input.designVersionId,
        JSON.stringify(prerequisites),
        JSON.stringify(input.controlPoints ?? []),
        input.displacementToleranceMm,
        input.settlementToleranceMm,
        input.observationValiditySeconds,
      );
    } catch (error: any) {
      if (String(error?.message).includes("UNIQUE"))
        throw conflict("STEP_EXISTS", `工作区内工序 ${input.code} 已存在`);
      throw error;
    }
    return id;
  });
}

function assertDesignExists(db: Db, designVersionId: string): void {
  if (!db.prepare("SELECT 1 FROM design_versions WHERE id = ?").get(designVersionId))
    throw notFound("DESIGN_NOT_FOUND", `设计版本 ${designVersionId} 不存在`);
}

/** 读取前置工序（按登记顺序） */
export function prerequisiteSteps(db: Db, stepId: string): string[] {
  const row = db.prepare("SELECT prerequisite_step_ids AS v FROM work_steps WHERE id = ?").get(stepId) as
    | { v: string }
    | undefined;
  return row ? parseJsonArray(row.v) : [];
}
