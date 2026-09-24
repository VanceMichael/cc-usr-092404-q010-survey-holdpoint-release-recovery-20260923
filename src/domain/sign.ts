import type { Db } from "./model.js";
import { conflict, forbidden, newId, notFound, recordEvent, transaction } from "./model.js";
import {
  activeLeaseConflict,
  activeRelease,
  getStep,
  latestPackage,
  overlappingZones,
} from "./repo.js";
import { computeBlockage } from "./evaluate.js";

export interface SignResult {
  decisionId: string;
  packageId: string;
  surveySigned: boolean;
  supervisorSigned: boolean;
  released: boolean;
}

/**
 * 签署放行：测量复核人先签、监理后签；任何角色都不能批准自己提交的材料。
 * 并发签署面对版本变化必须重新确认。
 */
export function signRelease(
  db: Db,
  stepId: string,
  userId: string,
  atIso: string,
): SignResult {
  return transaction(db, () => {
    const step = getStep(db, stepId);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
      | Record<string, any>
      | undefined;
    if (!user) throw notFound("USER_NOT_FOUND", `签署人 ${userId} 不存在`);

    const pkg = latestPackage(db, stepId);
    if (!pkg) throw conflict("NO_EVIDENCE", "尚未提交证据包，无法签署");

    // 两个角色都不能批准自己提交的材料
    if (pkg.submitted_by_user_id === userId)
      throw forbidden("SELF_SUBMISSION", "不能批准自己提交的证据材料");

    if (step.status === "IN_PROGRESS" || step.status === "EXECUTED" || step.status === "AT_RISK")
      throw conflict("STEP_ALREADY_STARTED", `工序当前状态 ${step.status}，不再接受放行签署`);

    let decision = db
      .prepare("SELECT * FROM release_decisions WHERE step_id = ? AND package_id = ?")
      .get(stepId, pkg.id) as Record<string, any> | undefined;

    if (user.role === "SURVEY_REVIEWER") {
      if (decision?.survey_reviewer_id)
        throw conflict("ALREADY_SIGNED", "测量复核人已签署该证据包");
      assertSignable(db, stepId, atIso);
      if (!decision) {
        const id = newId();
        db.prepare(
          `INSERT INTO release_decisions
             (id, step_id, package_id, survey_reviewer_id, survey_signed_at,
              survey_seen_design_version_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, stepId, pkg.id, userId, atIso, step.design_version_id);
        decision = db.prepare("SELECT * FROM release_decisions WHERE id = ?").get(id) as
          | Record<string, any>
          | undefined;
      }
      recordEvent(db, "SURVEY_SIGNED", stepId, { packageId: pkg.id, userId }, atIso);
      return decisionView(decision!, false);
    }

    if (user.role !== "SUPERVISOR")
      throw forbidden("ROLE_FORBIDDEN", "仅测量复核人与监理可以签署");

    if (!decision?.survey_reviewer_id)
      throw conflict("SURVEY_SIGNATURE_FIRST", "测量复核人必须先签，监理才能后签");
    if (decision.supervisor_id) throw conflict("ALREADY_SIGNED", "监理已签署该证据包");

    // 并发签署面对版本变化必须重新确认
    if (decision.survey_seen_design_version_id !== step.design_version_id)
      throw conflict(
        "SIGN_RECONFIRM_REQUIRED",
        "复核签署后设计版本已变化，须由测量复核人按新版本重新确认后监理再签",
      );
    if (pkg.design_version_id !== step.design_version_id)
      throw conflict("SIGN_RECONFIRM_REQUIRED", "证据包版本与当前设计不符，须按新版本重新出证并签署");

    // 签署前实时重算阻断：缺项/超差/上游/相邻冲突任一未豁免即拒签
    assertSignable(db, stepId, atIso);

    // 条件更新：两个监理并发签署时只有一个能写入
    const result = db
      .prepare(
        `UPDATE release_decisions
           SET supervisor_id = ?, supervisor_signed_at = ?, supervisor_seen_design_version_id = ?
         WHERE id = ? AND supervisor_id IS NULL`,
      )
      .run(userId, atIso, step.design_version_id, decision.id);
    if (result.changes === 0) throw conflict("ALREADY_SIGNED", "监理签署已由他人完成");

    db.prepare("UPDATE work_steps SET status = 'RELEASED' WHERE id = ? AND status = 'PENDING_RELEASE'")
      .run(stepId);
    recordEvent(db, "RELEASE_GRANTED", stepId, {
      packageId: pkg.id,
      decisionId: decision.id,
      surveyUserId: decision.survey_reviewer_id,
      supervisorUserId: userId,
    }, atIso);

    const refreshed = db.prepare("SELECT * FROM release_decisions WHERE id = ?").get(decision.id) as
      | Record<string, any>
      | undefined;
    return decisionView(refreshed!, true);
  });
}

/** 签署前置：实时重算阻断，缺项/超差/上游/相邻任一未豁免即拒签 */
function assertSignable(db: Db, stepId: string, atIso: string): void {
  const blockage = computeBlockage(db, stepId, Date.parse(atIso), new Set());
  if (!blockage.releasable)
    throw conflict(
      "BLOCKERS_PRESENT",
      `存在 ${blockage.blockers.length} 项未关闭阻断，不能签署放行`,
    );
}

function decisionView(decision: Record<string, any>, released: boolean): SignResult {  return {
    decisionId: decision.id,
    packageId: decision.package_id,
    surveySigned: Boolean(decision.survey_reviewer_id),
    supervisorSigned: Boolean(decision.supervisor_id),
    released,
  };
}

export interface LeaseView {
  leaseId: string;
  zoneId: string;
  stepId: string;
  grantedAt: string;
}

/** 申请施工租约：必须已有放行；重叠工作区同一时刻只能一个获准 */
export function grantLease(db: Db, stepId: string, atIso: string): LeaseView {
  return transaction(db, () => {
    const step = getStep(db, stepId);
    if (step.status !== "RELEASED")
      throw conflict("NOT_RELEASED", `工序状态 ${step.status}，须监理签署放行后才能申请施工租约`);
    if (!activeRelease(db, stepId))
      throw conflict("NOT_RELEASED", "没有有效的放行决定");

    // 同工序已有在持租约：幂等返回
    const existing = db
      .prepare("SELECT * FROM construction_leases WHERE step_id = ? AND released_at IS NULL")
      .get(stepId) as Record<string, any> | undefined;
    if (existing)
      return { leaseId: existing.id, zoneId: existing.zone_id, stepId, grantedAt: existing.granted_at };

    const zones = overlappingZones(db, step.zone_id);
    const contender = activeLeaseConflict(db, zones, stepId);
    if (contender) {
      const holder = db.prepare("SELECT code FROM work_steps WHERE id = ?").get(contender.step_id) as
        | { code: string }
        | undefined;
      throw conflict(
        "LEASE_CONTENTION",
        `重叠工作区已有工序 ${holder?.code ?? contender.step_id} 持有施工租约，同一时刻只能一个获准`,
      );
    }

    const leaseId = newId();
    db.prepare(
      "INSERT INTO construction_leases (id, zone_id, step_id, granted_at) VALUES (?, ?, ?, ?)",
    ).run(leaseId, step.zone_id, stepId, atIso);
    db.prepare("UPDATE work_steps SET status = 'IN_PROGRESS' WHERE id = ?").run(stepId);
    recordEvent(db, "LEASE_GRANTED", stepId, { leaseId, zoneId: step.zone_id }, atIso);
    return { leaseId, zoneId: step.zone_id, stepId, grantedAt: atIso };
  });
}

/** 施工完成：释放租约，工序转入已执行。挂起现场复核未解除时不得报完成 */
export function completeExecution(db: Db, stepId: string, atIso: string): void {
  transaction(db, () => {
    const step = getStep(db, stepId);
    if (step.status !== "IN_PROGRESS")
      throw conflict("NOT_IN_PROGRESS", `工序状态 ${step.status}，不能登记施工完成`);
    if (step.review_pending)
      throw conflict("REVIEW_PENDING", "换版/补录引发的现场复核尚未解除，不能登记完成");
    db.prepare(
      "UPDATE construction_leases SET released_at = ? WHERE step_id = ? AND released_at IS NULL",
    ).run(atIso, stepId);
    db.prepare("UPDATE work_steps SET status = 'EXECUTED' WHERE id = ?").run(stepId);
    recordEvent(db, "EXECUTION_COMPLETED", stepId, {}, atIso);
  });
}

/** 监理确认现场复核结论，解除施工中挂起（不改变证据与决定历史） */
export function resolveSiteReview(db: Db, stepId: string, userId: string): void {
  transaction(db, () => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
      | Record<string, any>
      | undefined;
    if (!user) throw notFound("USER_NOT_FOUND", `用户 ${userId} 不存在`);
    if (user.role !== "SUPERVISOR")
      throw forbidden("SUPERVISOR_ONLY", "现场复核结论须由监理确认");
    const step = getStep(db, stepId);
    if (!step.review_pending) throw conflict("NO_REVIEW_PENDING", "该工序没有待解除的现场复核挂起");
    db.prepare("UPDATE work_steps SET review_pending = 0 WHERE id = ?").run(stepId);
    recordEvent(db, "SITE_REVIEW_RESOLVED", stepId, { userId }, new Date().toISOString());
  });
}
