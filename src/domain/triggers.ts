import type { Db } from "./model.js";
import {
  badRequest,
  forbidden,
  newId,
  notFound,
  recordEvent,
  transaction,
} from "./model.js";
import { activeRelease, getStep } from "./repo.js";
import { cancelDecision, lastCompletedDecision, openRisk } from "./evidence.js";

/**
 * 仪器校准撤销：
 * - 未开工的放行撤销；
 * - 施工中挂起现场复核；
 * - 已执行转风险评估并保存原决定。
 * 校准记录本身保留，仅标记 revoked；引用它的旧证据包不被覆盖。
 */
export function revokeCalibration(
  db: Db,
  calibrationId: string,
  reason: string,
  atIso: string,
): { affectedStepIds: string[] } {
  return transaction(db, () => {
    if (!reason?.trim()) throw badRequest("REVOKE_REASON_REQUIRED", "校准撤销必须填写原因");
    const calibration = db.prepare("SELECT * FROM calibrations WHERE id = ?").get(calibrationId) as
      | Record<string, any>
      | undefined;
    if (!calibration) throw notFound("CALIBRATION_NOT_FOUND", `校准版本 ${calibrationId} 不存在`);
    if (calibration.revoked_at)
      throw badRequest("CALIBRATION_ALREADY_REVOKED", "该校准版本已撤销");

    db.prepare("UPDATE calibrations SET revoked_at = ?, revoke_reason = ? WHERE id = ?").run(
      atIso,
      reason,
      calibrationId,
    );

    const packages = db
      .prepare("SELECT DISTINCT step_id FROM evidence_packages WHERE calibration_id = ?")
      .all(calibrationId) as { step_id: string }[];
    const affected = packages.map((p) => p.step_id);
    for (const stepId of affected) propagateTrigger(db, stepId, "CALIBRATION_REVOKE", reason, atIso);
    return { affectedStepIds: affected };
  });
}

export interface DesignChangeResult {
  changeId: string;
  fromDesignVersionId: string;
  toDesignVersionId: string;
  affectedCrewIds: string[];
  dispositions: {
    REVOKE_PENDING: { stepId: string; crewId: string }[];
    IN_PROGRESS_REVIEW: { stepId: string; crewId: string }[];
    EXECUTED_TO_RISK: { stepId: string; crewId: string }[];
  };
}

/**
 * 设计换版：所有引用旧版本的工序按当前状态分流处置，
 * 看板按一次变更分别列出待放行、施工中、已执行工序的去向与波及班组。
 */
export function applyDesignChange(
  db: Db,
  fromDesignVersionId: string,
  toDesignVersionId: string,
  atIso: string,
): DesignChangeResult {
  return transaction(db, () => {
    if (fromDesignVersionId === toDesignVersionId)
      throw badRequest("SAME_DESIGN_VERSION", "换版目标版本不能与旧版本相同");
    const from = db.prepare("SELECT 1 FROM design_versions WHERE id = ?").get(fromDesignVersionId);
    if (!from) throw notFound("DESIGN_NOT_FOUND", `旧设计版本 ${fromDesignVersionId} 不存在`);
    const to = db.prepare("SELECT 1 FROM design_versions WHERE id = ?").get(toDesignVersionId);
    if (!to) throw notFound("DESIGN_NOT_FOUND", `新设计版本 ${toDesignVersionId} 不存在`);

    const steps = db
      .prepare("SELECT * FROM work_steps WHERE design_version_id = ? ORDER BY code")
      .all(fromDesignVersionId) as Record<string, any>[];

    const changeId = newId();
    const result: DesignChangeResult = {
      changeId,
      fromDesignVersionId,
      toDesignVersionId,
      affectedCrewIds: [],
      dispositions: { REVOKE_PENDING: [], IN_PROGRESS_REVIEW: [], EXECUTED_TO_RISK: [] },
    };
    const crews = new Set<string>();
    const impactStmt = db.prepare(
      `INSERT INTO design_change_impacts
         (id, change_id, from_design_version_id, to_design_version_id, step_id, crew_id, disposition)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const step of steps) {
      crews.add(step.crew_id);
      let disposition: "REVOKE_PENDING" | "IN_PROGRESS_REVIEW" | "EXECUTED_TO_RISK";

      if (step.status === "IN_PROGRESS") {
        disposition = "IN_PROGRESS_REVIEW";
        db.prepare("UPDATE work_steps SET review_pending = 1, design_version_id = ? WHERE id = ?").run(
          toDesignVersionId,
          step.id,
        );
        recordEvent(db, "IN_PROGRESS_REVIEW", step.id, {
          reason: "DESIGN_CHANGE",
          from: fromDesignVersionId,
          to: toDesignVersionId,
        }, atIso);
      } else if (step.status === "EXECUTED" || step.status === "AT_RISK") {
        disposition = "EXECUTED_TO_RISK";
        db.prepare("UPDATE work_steps SET status = 'AT_RISK', design_version_id = ? WHERE id = ?").run(
          toDesignVersionId,
          step.id,
        );
        const decision = lastCompletedDecision(db, step.id);
        if (decision)
          openRisk(
            db,
            step.id,
            decision.id,
            "DESIGN_CHANGE",
            `设计换版：${fromDesignVersionId} → ${toDesignVersionId}`,
            atIso,
          );
        recordEvent(db, "EXECUTED_TO_RISK", step.id, {
          reason: "DESIGN_CHANGE",
          from: fromDesignVersionId,
          to: toDesignVersionId,
        }, atIso);
      } else {
        // PENDING_RELEASE / RELEASED：尚未开工，放行撤销，待按新版重新出证
        disposition = "REVOKE_PENDING";
        const release = activeRelease(db, step.id);
        if (release) {
          cancelDecision(
            db,
            release.id,
            atIso,
            "DESIGN_CHANGE",
            `设计换版：${fromDesignVersionId} → ${toDesignVersionId}`,
          );
          recordEvent(db, "RELEASE_REVOKED", step.id, {
            reason: "DESIGN_CHANGE",
            from: fromDesignVersionId,
            to: toDesignVersionId,
          }, atIso);
        }
        db.prepare(
          "UPDATE work_steps SET status = 'PENDING_RELEASE', design_version_id = ? WHERE id = ?",
        ).run(toDesignVersionId, step.id);
      }

      impactStmt.run(
        newId(),
        changeId,
        fromDesignVersionId,
        toDesignVersionId,
        step.id,
        step.crew_id,
        disposition,
      );
      result.dispositions[disposition].push({ stepId: step.id, crewId: step.crew_id });
    }

    result.affectedCrewIds = [...crews];
    return result;
  });
}

/** 一次变更的处置去向（看板收尾视图） */
export function getDesignChangeView(db: Db, changeId: string): Record<string, unknown> {
  const impacts = db
    .prepare(
      `SELECT dci.*, ws.code AS step_code, c.name AS crew_name, c.id AS crew_id
       FROM design_change_impacts dci
       JOIN work_steps ws ON ws.id = dci.step_id
       JOIN crews c ON c.id = dci.crew_id
       WHERE dci.change_id = ?
       ORDER BY dci.disposition, ws.code`,
    )
    .all(changeId) as Record<string, any>[];
  if (impacts.length === 0) throw notFound("CHANGE_NOT_FOUND", `变更 ${changeId} 不存在或无受影响工序`);

  const group = (disposition: string) =>
    impacts
      .filter((i) => i.disposition === disposition)
      .map((i) => ({ stepId: i.step_id, stepCode: i.step_code, crewId: i.crew_id, crewName: i.crew_name }));

  return {
    changeId,
    fromDesignVersionId: impacts[0].from_design_version_id,
    toDesignVersionId: impacts[0].to_design_version_id,
    pendingRelease: group("REVOKE_PENDING"),
    inProgress: group("IN_PROGRESS_REVIEW"),
    executed: group("EXECUTED_TO_RISK"),
  };
}

/** 监理关闭风险评估：原决定保留可查，工序恢复已执行台账状态 */
export function resolveRiskAssessment(
  db: Db,
  riskId: string,
  userId: string,
  atIso: string,
): void {
  transaction(db, () => {
    const risk = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(riskId) as
      | Record<string, any>
      | undefined;
    if (!risk) throw notFound("RISK_NOT_FOUND", `风险评估 ${riskId} 不存在`);
    if (risk.state !== "OPEN") throw badRequest("RISK_CLOSED", "风险评估已关闭");
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
      | Record<string, any>
      | undefined;
    if (!user) throw notFound("USER_NOT_FOUND", `用户 ${userId} 不存在`);
    if (user.role !== "SUPERVISOR")
      throw forbidden("SUPERVISOR_ONLY", "风险评估结论须由监理确认");

    db.prepare(
      "UPDATE risk_assessments SET state = 'RESOLVED', resolved_at = ? WHERE id = ?",
    ).run(atIso, riskId);
    db.prepare("UPDATE work_steps SET status = 'EXECUTED' WHERE id = ? AND status = 'AT_RISK'").run(
      risk.step_id,
    );
    recordEvent(db, "RISK_RESOLVED", risk.step_id, { riskId, userId }, atIso);
  });
}

/** 补录/校准撤销/换版的共同状态传播 */
function propagateTrigger(
  db: Db,
  stepId: string,
  triggerType: "OBSERVATION_BACKFILL" | "CALIBRATION_REVOKE" | "DESIGN_CHANGE",
  detail: string,
  atIso: string,
): void {
  const step = getStep(db, stepId);
  if (step.status === "RELEASED" || step.status === "PENDING_RELEASE") {
    const release = activeRelease(db, stepId);
    if (release) {
      cancelDecision(db, release.id, atIso, triggerType, detail);
      db.prepare("UPDATE work_steps SET status = 'PENDING_RELEASE' WHERE id = ?").run(stepId);
      recordEvent(db, "RELEASE_REVOKED", stepId, { reason: triggerType, detail }, atIso);
    }
  } else if (step.status === "IN_PROGRESS") {
    db.prepare("UPDATE work_steps SET review_pending = 1 WHERE id = ?").run(stepId);
    recordEvent(db, "IN_PROGRESS_REVIEW", stepId, { reason: triggerType, detail }, atIso);
  } else if (step.status === "EXECUTED" || step.status === "AT_RISK") {
    const decision = lastCompletedDecision(db, stepId);
    if (step.status === "EXECUTED")
      db.prepare("UPDATE work_steps SET status = 'AT_RISK' WHERE id = ?").run(stepId);
    if (decision) openRisk(db, stepId, decision.id, triggerType, detail, atIso);
    recordEvent(db, "EXECUTED_TO_RISK", stepId, { reason: triggerType, detail }, atIso);
  }
}
