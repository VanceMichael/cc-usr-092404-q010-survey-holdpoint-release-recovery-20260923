import { createHash } from "node:crypto";
import type { ControlPoint, Db, ObservationInput, Row } from "./model.js";
import {
  badRequest,
  newId,
  parseControlPoints,
  recordEvent,
  transaction,
} from "./model.js";
import { activeRelease, getStep, latestPackage, type PackageRow } from "./repo.js";

export interface SubmitPackageInput {
  stepId: string;
  baselineId: string;
  calibrationId: string;
  designVersionId?: string;
  submittedByCrewId: string;
  /** 代提交的持证人员账户；签署时禁止其自批 */
  submittedByUserId?: string | null;
  observedAt: string;
  submittedAt?: string;
  backfilled?: boolean;
  backfillReason?: string | null;
  observations: ObservationInput[];
  note?: string;
}

export interface SubmitPackageResult {
  packageId: string;
  packageVersion: number;
  observationSummary: string;
  backfilled: boolean;
  releaseCancelled: boolean;
}

/** 提交证据包：固定原始观测摘要、基线与仪器校准版本；永不覆盖旧包 */
export function submitPackage(db: Db, input: SubmitPackageInput, atIso: string): SubmitPackageResult {
  return transaction(db, () => {
    const step = getStep(db, input.stepId);
    const submittedAt = input.submittedAt ?? atIso;
    if (Number.isNaN(Date.parse(input.observedAt)))
      throw badRequest("INVALID_TIME", "观测时间无法解析");
    if (Date.parse(input.observedAt) > Date.parse(submittedAt) + 60_000)
      throw badRequest("OBSERVATION_IN_FUTURE", "观测时间不能晚于提交时间");

    const baseline = db.prepare("SELECT * FROM baselines WHERE id = ?").get(input.baselineId) as
      | Row
      | undefined;
    if (!baseline) throw badRequest("BASELINE_NOT_FOUND", `基线 ${input.baselineId} 不存在`);

    const calibration = db
      .prepare("SELECT * FROM calibrations WHERE id = ?")
      .get(input.calibrationId) as Row | undefined;
    if (!calibration)
      throw badRequest("CALIBRATION_NOT_FOUND", `仪器校准 ${input.calibrationId} 不存在`);
    if (calibration.revoked_at)
      throw badRequest("CALIBRATION_REVOKED", `校准版本 ${calibration.version_label} 已撤销，不能作为新证据`);

    if (!db.prepare("SELECT 1 FROM crews WHERE id = ?").get(input.submittedByCrewId))
      throw badRequest("CREW_NOT_FOUND", `班组 ${input.submittedByCrewId} 不存在`);
    if (
      input.submittedByUserId &&
      !db.prepare("SELECT 1 FROM users WHERE id = ?").get(input.submittedByUserId)
    )
      throw badRequest("USER_NOT_FOUND", `提交人 ${input.submittedByUserId} 不存在`);

    const designVersionId = input.designVersionId ?? step.design_version_id;
    if (designVersionId !== step.design_version_id)
      throw badRequest(
        "DESIGN_VERSION_MISMATCH",
        "证据包必须按工序当前设计版本提交；设计换版后请使用新版本重新出证",
      );
    if (baseline.design_version_id !== designVersionId)
      throw badRequest(
        "BASELINE_DESIGN_MISMATCH",
        "基线不属于该证据包声明的设计版本",
      );

    const backfilled = input.backfilled ? 1 : 0;
    if (backfilled && !input.backfillReason?.trim())
      throw badRequest("BACKFILL_REASON_REQUIRED", "观测补录必须填写原因");

    const planned = parseControlPoints(step.control_points);
    const byCode = new Map(input.observations.map((o) => [o.pointCode, o]));
    for (const code of byCode.keys())
      if (!planned.some((p) => p.code === code))
        throw badRequest("UNKNOWN_CONTROL_POINT", `控制点 ${code} 不在工序登记的控制点集合内`);

    // 固定原始观测摘要：规范化后做 SHA-256，附基线/校准版本
    const canonical = JSON.stringify(
      input.observations
        .map((o) => ({
          pointCode: o.pointCode,
          sequenceNo: o.sequenceNo ?? null,
          x: o.x ?? null,
          y: o.y ?? null,
          z: o.z ?? null,
          displacementMm: o.displacementMm ?? null,
          settlementMm: o.settlementMm ?? null,
        }))
        .sort((a, b) => a.pointCode.localeCompare(b.pointCode)),
    );
    const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const observationSummary =
      `sha256:${digest}|baseline:${baseline.label}@${baseline.revision}` +
      `|calibration:${calibration.instrument_code}@${calibration.version_label}` +
      (input.note ? `|note:${input.note}` : "");

    const previous = latestPackage(db, step.id);
    const packageVersion = (previous?.package_version ?? 0) + 1;
    const packageId = newId();

    db.prepare(
      `INSERT INTO evidence_packages
         (id, step_id, package_version, baseline_id, calibration_id, design_version_id,
          submitted_by_crew_id, submitted_by_user_id, submitted_at, observed_at,
          backfilled, backfill_reason, observation_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      packageId,
      step.id,
      packageVersion,
      input.baselineId,
      input.calibrationId,
      designVersionId,
      input.submittedByCrewId,
      input.submittedByUserId ?? null,
      submittedAt,
      input.observedAt,
      backfilled,
      input.backfillReason ?? null,
      observationSummary,
    );

    insertObservations(db, packageId, planned, input.observations);

    // 施工中/已执行工序不能以普通新包整改；补录包走专门的撤销/风险路径
    if (step.status === "IN_PROGRESS" && !backfilled)
      throw badRequest(
        "STEP_IN_PROGRESS",
        "工序已在施工，普通整改包不再受理；观测补录请以补录包提交",
      );
    if ((step.status === "EXECUTED" || step.status === "AT_RISK") && !backfilled)
      throw badRequest(
        "STEP_EXECUTED",
        "工序已执行，不能用普通证据包推翻；观测补录请以补录包提交并转入风险评估",
      );

    // 新证据包到来：若工序尚未开工且放行依据的是旧包，原放行撤销
    // （任何操作不覆盖旧包，旧决定保留为 CANCELLED；已执行工序的原决定必须保留）
    const release = activeRelease(db, step.id);
    let releaseCancelled = false;
    if (release && step.status === "RELEASED" && !backfilled) {
      cancelDecision(db, release.id, submittedAt, "PACKAGE_SUPERSEDED", "承包方提交了新证据包，原放行依据失效");
      releaseCancelled = true;
      db.prepare("UPDATE work_steps SET status = 'PENDING_RELEASE' WHERE id = ?").run(step.id);
      recordEvent(db, "RELEASE_REVOKED", step.id, {
        reason: "PACKAGE_SUPERSEDED",
        oldPackageId: release.package_id,
        newPackageId: packageId,
      }, submittedAt);
    }

    if (backfilled) applyBackfillEffects(db, step.id, packageId, submittedAt, input.backfillReason!);

    recordEvent(db, "EVIDENCE_SUBMITTED", step.id, {
      packageId,
      packageVersion,
      backfilled: Boolean(backfilled),
    }, submittedAt);

    return {
      packageId,
      packageVersion,
      observationSummary,
      backfilled: Boolean(backfilled),
      releaseCancelled,
    };
  });
}

function insertObservations(
  db: Db,
  packageId: string,
  planned: ControlPoint[],
  observations: ObservationInput[],
): void {
  const stmt = db.prepare(
    `INSERT INTO evidence_observations
       (package_id, point_code, sequence_no, x, y, z, displacement_mm, settlement_mm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const obs of observations) {
    stmt.run(
      packageId,
      obs.pointCode,
      obs.sequenceNo ?? null,
      obs.x ?? null,
      obs.y ?? null,
      obs.z ?? null,
      obs.displacementMm ?? derivedDisplacement(planned, obs),
      obs.settlementMm ?? derivedSettlement(planned, obs),
    );
  }
}

/** 未直接给定位移时由坐标推算（坐标单位米，容差单位毫米） */
function derivedDisplacement(planned: ReturnType<typeof parseControlPoints>, obs: ObservationInput): number | null {
  if (obs.x == null || obs.y == null) return null;
  const ref = planned.find((p) => p.code === obs.pointCode);
  if (!ref) return null;
  return Math.hypot(obs.x - ref.x, obs.y - ref.y) * 1000;
}

function derivedSettlement(planned: ReturnType<typeof parseControlPoints>, obs: ObservationInput): number | null {
  if (obs.z == null) return null;
  const ref = planned.find((p) => p.code === obs.pointCode);
  if (!ref) return null;
  return (obs.z - ref.z) * 1000;
}

export function cancelDecision(
  db: Db,
  decisionId: string,
  atIso: string,
  reason: string,
  detail: string,
): void {
  db.prepare(
    `UPDATE release_decisions
       SET state = 'CANCELLED', cancelled_at = ?, cancel_reason = ?
     WHERE id = ?`,
  ).run(atIso, `${reason}:${detail}`, decisionId);
}

/**
 * 观测补录效应：尚未开工的放行撤销；施工中挂起现场复核；已执行转风险评估并保存原决定。
 */
function applyBackfillEffects(
  db: Db,
  stepId: string,
  packageId: string,
  atIso: string,
  reason: string,
): void {
  const step = getStep(db, stepId);
  if (step.status === "RELEASED") {
    const release = activeRelease(db, stepId);
    if (release) {
      cancelDecision(db, release.id, atIso, "OBSERVATION_BACKFILL", reason);
      db.prepare("UPDATE work_steps SET status = 'PENDING_RELEASE' WHERE id = ?").run(stepId);
      recordEvent(db, "RELEASE_REVOKED", stepId, { reason: "OBSERVATION_BACKFILL", packageId }, atIso);
    }
  } else if (step.status === "IN_PROGRESS") {
    db.prepare("UPDATE work_steps SET review_pending = 1 WHERE id = ?").run(stepId);
    recordEvent(db, "IN_PROGRESS_REVIEW", stepId, { reason: "OBSERVATION_BACKFILL", packageId }, atIso);
  } else if (step.status === "EXECUTED" || step.status === "AT_RISK") {
    const decision = lastCompletedDecision(db, stepId);
    if (step.status === "EXECUTED")
      db.prepare("UPDATE work_steps SET status = 'AT_RISK' WHERE id = ?").run(stepId);
    if (decision) openRisk(db, stepId, decision.id, "OBSERVATION_BACKFILL", `观测补录：${reason}`, atIso);
    recordEvent(db, "EXECUTED_TO_RISK", stepId, { reason: "OBSERVATION_BACKFILL", packageId }, atIso);
  }
}

export function lastCompletedDecision(db: Db, stepId: string): Row | undefined {
  return db
    .prepare(
      `SELECT * FROM release_decisions
       WHERE step_id = ? AND supervisor_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(stepId) as Row | undefined;
}

export function openRisk(
  db: Db,
  stepId: string,
  decisionId: string,
  triggerType: "OBSERVATION_BACKFILL" | "CALIBRATION_REVOKE" | "DESIGN_CHANGE",
  detail: string,
  atIso: string,
): string {
  const existing = db
    .prepare(
      `SELECT id FROM risk_assessments
       WHERE step_id = ? AND trigger_type = ? AND state = 'OPEN'`,
    )
    .get(stepId, triggerType) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId();
  db.prepare(
    `INSERT INTO risk_assessments (id, step_id, original_decision_id, trigger_type, detail)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, stepId, decisionId, triggerType, detail);
  return id;
}

/** 读取证据包（旧包始终可追溯） */
export function getPackageHistory(db: Db, stepId: string): PackageRow[] {
  return db
    .prepare("SELECT * FROM evidence_packages WHERE step_id = ? ORDER BY package_version")
    .all(stepId) as PackageRow[];
}
