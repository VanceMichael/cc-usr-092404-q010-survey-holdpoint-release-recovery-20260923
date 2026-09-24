import type { Db } from "./model.js";
import { computeBlockage } from "./evaluate.js";
import { notFound } from "./model.js";

export interface BoardRow {
  stepId: string;
  zoneCode: string;
  zoneName: string;
  stepCode: string;
  title: string;
  crewName: string;
  status: string;
  reviewPending: boolean;
  packageVersion: number | null;
  designVersionLabel: string;
  releasable: boolean;
  blockers: { code: string; subject: string; detail: string; waived?: unknown }[];
  waivedCount: number;
  activeLease: boolean;
  openRisk: boolean;
}

/**
 * 放行看板：逐停检点给出状态、是否可放行/可施工，以及阻断归因
 * （测量超差/缺项 vs 上游工序 vs 相邻区域争用 vs 校准撤销/换版/时效）。
 */
export function buildBoard(db: Db, atMs: number, filter?: { zoneId?: string }): BoardRow[] {
  const steps = db
    .prepare(
      `SELECT ws.*, wz.code AS zone_code, wz.name AS zone_name, c.name AS crew_name,
              dv.label AS design_label, ep.package_version AS package_version
       FROM work_steps ws
       JOIN work_zones wz ON wz.id = ws.zone_id
       JOIN crews c ON c.id = ws.crew_id
       JOIN design_versions dv ON dv.id = ws.design_version_id
       LEFT JOIN (
         SELECT step_id, MAX(package_version) AS package_version
         FROM evidence_packages GROUP BY step_id
       ) ep ON ep.step_id = ws.id
       ${filter?.zoneId ? "WHERE ws.zone_id = ?" : ""}
       ORDER BY wz.code, ws.code`,
    )
    .all(...(filter?.zoneId ? [filter.zoneId] : [])) as Record<string, any>[];

  return steps.map((step) => {
    const blockage = computeBlockage(db, step.id, atMs, new Set());
    const lease = db
      .prepare(
        `SELECT 1 FROM construction_leases
         WHERE step_id = ? AND released_at IS NULL LIMIT 1`,
      )
      .get(step.id);
    const risk = db
      .prepare(
        `SELECT 1 FROM risk_assessments WHERE step_id = ? AND state = 'OPEN' LIMIT 1`,
      )
      .get(step.id);
    return {
      stepId: step.id,
      zoneCode: step.zone_code,
      zoneName: step.zone_name,
      stepCode: step.code,
      title: step.title,
      crewName: step.crew_name,
      status: step.status,
      reviewPending: Boolean(step.review_pending),
      packageVersion: step.package_version ?? null,
      designVersionLabel: step.design_label,
      releasable: blockage.releasable,
      blockers: blockage.blockers.map((b) => ({
        code: b.code,
        subject: b.subject,
        detail: b.detail,
      })),
      waivedCount: blockage.waived.length,
      activeLease: Boolean(lease),
      openRisk: Boolean(risk),
    };
  });
}

/** 单个停检点详情：方案、证据包谱系、缺陷、豁免、签署、租约、风险 */
export function stepDetail(db: Db, stepId: string, atMs: number): Record<string, unknown> {
  const step = db
    .prepare(
      `SELECT ws.*, wz.code AS zone_code, wz.name AS zone_name, c.name AS crew_name
       FROM work_steps ws
       JOIN work_zones wz ON wz.id = ws.zone_id
       JOIN crews c ON c.id = ws.crew_id
       WHERE ws.id = ?`,
    )
    .get(stepId) as Record<string, any> | undefined;
  if (!step) throw notFound("STEP_NOT_FOUND", `停检点 ${stepId} 不存在`);

  const packages = db
    .prepare(
      `SELECT ep.*, b.label AS baseline_label, b.revision AS baseline_revision,
              ca.instrument_code, ca.version_label AS calibration_label, ca.revoked_at
       FROM evidence_packages ep
       JOIN baselines b ON b.id = ep.baseline_id
       JOIN calibrations ca ON ca.id = ep.calibration_id
       WHERE ep.step_id = ? ORDER BY ep.package_version`,
    )
    .all(stepId) as Record<string, any>[];

  const findings = db
    .prepare(
      `SELECT f.*, (
         SELECT json_group_array(json_object('waiverId', w.id, 'basis', w.basis,
                                            'expiresAt', w.expires_at, 'revokedAt', w.revoked_at))
         FROM waivers w WHERE w.finding_id = f.id
       ) AS waivers_json
       FROM findings f WHERE f.step_id = ? ORDER BY f.created_at`,
    )
    .all(stepId) as Record<string, any>[];

  const decisions = db
    .prepare(
      `SELECT rd.*, su.name AS survey_name, sp.name AS supervisor_name
       FROM release_decisions rd
       LEFT JOIN users su ON su.id = rd.survey_reviewer_id
       LEFT JOIN users sp ON sp.id = rd.supervisor_id
       WHERE rd.step_id = ? ORDER BY rd.created_at`,
    )
    .all(stepId) as Record<string, any>[];

  const risks = db
    .prepare("SELECT * FROM risk_assessments WHERE step_id = ? ORDER BY created_at")
    .all(stepId) as Record<string, any>[];

  const events = db
    .prepare("SELECT event_type, payload, created_at FROM domain_events WHERE step_id = ? ORDER BY created_at")
    .all(stepId) as Record<string, any>[];

  return {
    step: {
      id: step.id,
      code: step.code,
      title: step.title,
      zone: { code: step.zone_code, name: step.zone_name },
      crew: step.crew_name,
      status: step.status,
      reviewPending: Boolean(step.review_pending),
      prerequisites: JSON.parse(step.prerequisite_step_ids),
      controlPoints: JSON.parse(step.control_points),
      tolerance: {
        displacementMm: step.displacement_tolerance_mm,
        settlementMm: step.settlement_tolerance_mm,
      },
      observationValiditySeconds: step.observation_validity_seconds,
    },
    blockage: computeBlockage(db, stepId, atMs, new Set()),
    packages: packages.map((p) => ({
      packageId: p.id,
      version: p.package_version,
      baseline: `${p.baseline_label}@${p.baseline_revision}`,
      calibration: `${p.instrument_code}@${p.calibration_label}`,
      calibrationRevokedAt: p.revoked_at,
      observedAt: p.observed_at,
      submittedAt: p.submitted_at,
      backfilled: Boolean(p.backfilled),
      backfillReason: p.backfill_reason,
      summary: p.observation_summary,
    })),
    findings: findings.map((f) => ({
      findingId: f.id,
      packageId: f.package_id,
      code: f.code,
      subject: f.subject,
      detail: f.detail,
      state: f.state,
      closedAt: f.closed_at,
      waivers: JSON.parse(f.waivers_json ?? "[]"),
    })),
    decisions: decisions.map((d) => ({
      decisionId: d.id,
      packageId: d.package_id,
      state: d.state,
      surveyReviewer: d.survey_name ? { id: d.survey_reviewer_id, name: d.survey_name, at: d.survey_signed_at } : null,
      supervisor: d.supervisor_name ? { id: d.supervisor_id, name: d.supervisor_name, at: d.supervisor_signed_at } : null,
      cancelledAt: d.cancelled_at,
      cancelReason: d.cancel_reason,
    })),
    riskAssessments: risks,
    events: events.map((e) => ({ type: e.event_type, payload: JSON.parse(e.payload), at: e.created_at })),
  };
}
