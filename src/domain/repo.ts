import type { Db, Row } from "./model.js";
import { notFound } from "./model.js";

export interface StepRow extends Row {
  id: string;
  zone_id: string;
  crew_id: string;
  code: string;
  title: string;
  design_version_id: string;
  prerequisite_step_ids: string;
  control_points: string;
  displacement_tolerance_mm: number;
  settlement_tolerance_mm: number;
  observation_validity_seconds: number;
  review_pending: number;
  status: string;
}

export interface PackageRow extends Row {
  id: string;
  step_id: string;
  package_version: number;
  baseline_id: string;
  calibration_id: string;
  design_version_id: string;
  submitted_by_crew_id: string;
  submitted_by_user_id: string | null;
  submitted_at: string;
  observed_at: string;
  backfilled: number;
  backfill_reason: string | null;
  observation_summary: string;
  superseded_at: string | null;
}

export function getStep(db: Db, stepId: string): StepRow {
  const step = db.prepare("SELECT * FROM work_steps WHERE id = ?").get(stepId) as
    | StepRow
    | undefined;
  if (!step) throw notFound("STEP_NOT_FOUND", `停检点 ${stepId} 不存在`);
  return step;
}

export function getPackage(db: Db, packageId: string): PackageRow {
  const pkg = db.prepare("SELECT * FROM evidence_packages WHERE id = ?").get(packageId) as
    | PackageRow
    | undefined;
  if (!pkg) throw notFound("PACKAGE_NOT_FOUND", `证据包 ${packageId} 不存在`);
  return pkg;
}

export function getUser(db: Db, userId: string): Row {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Row | undefined;
  if (!user) throw notFound("USER_NOT_FOUND", `签署人 ${userId} 不存在`);
  return user;
}

/** 该停检点当前最新（版本号最大）的证据包 */
export function latestPackage(db: Db, stepId: string): PackageRow | undefined {
  return db
    .prepare("SELECT * FROM evidence_packages WHERE step_id = ? ORDER BY package_version DESC LIMIT 1")
    .get(stepId) as PackageRow | undefined;
}

/** 该停检点当前有效的放行决定（监理已签、未撤销） */
export function activeRelease(db: Db, stepId: string): Row | undefined {
  return db
    .prepare(
      `SELECT * FROM release_decisions
       WHERE step_id = ? AND state = 'RELEASED' AND supervisor_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(stepId) as Row | undefined;
}

export function openFindings(db: Db, stepId: string): Row[] {
  return db
    .prepare("SELECT * FROM findings WHERE step_id = ? AND state = 'OPEN' ORDER BY created_at")
    .all(stepId) as Row[];
}

export function openWaiver(db: Db, findingId: string, atMs: number): Row | undefined {
  const waivers = db
    .prepare(
      `SELECT * FROM waivers WHERE finding_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(findingId) as Row[];
  return waivers.find((w) => Date.parse(w.expires_at) >= atMs);
}

/** 与某区重叠（含自身）的所有区域 */
export function overlappingZones(db: Db, zoneId: string): string[] {
  const rows = db
    .prepare(
      `SELECT zone_a_id AS a, zone_b_id AS b FROM work_zone_overlaps
       WHERE zone_a_id = ? OR zone_b_id = ?`,
    )
    .all(zoneId, zoneId) as { a: string; b: string }[];
  return [zoneId, ...rows.map((r) => (r.a === zoneId ? r.b : r.a))];
}

/** 当前持有未释放租约的工序（排除自身），用于争用判定 */
export function activeLeaseConflict(db: Db, zoneIds: string[], excludeStepId: string): Row | undefined {
  if (zoneIds.length === 0) return undefined;
  const placeholders = zoneIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT cl.* FROM construction_leases cl
       WHERE cl.released_at IS NULL AND cl.zone_id IN (${placeholders})
         AND cl.step_id != ?
       ORDER BY cl.granted_at LIMIT 1`,
    )
    .get(...zoneIds, excludeStepId) as Row | undefined;
}

export function zoneLabel(db: Db, zoneId: string): string {
  const zone = db.prepare("SELECT code, name FROM work_zones WHERE id = ?").get(zoneId) as
    | { code: string; name: string }
    | undefined;
  return zone ? `${zone.code} ${zone.name}` : zoneId;
}
