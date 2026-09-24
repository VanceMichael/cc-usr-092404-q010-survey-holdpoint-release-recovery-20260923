import assert from "node:assert/strict";
import test from "node:test";
import { submitPackage } from "../src/domain/evidence.js";
import { completeExecution, grantLease, signRelease } from "../src/domain/sign.js";
import {
  applyDesignChange,
  getDesignChangeView,
  resolveRiskAssessment,
  revokeCalibration,
} from "../src/domain/triggers.js";
import * as Plan from "../src/domain/plan.js";
import { buildBoard } from "../src/domain/board.js";
import { DomainError } from "../src/domain/model.js";
import {
  BASE_MS,
  goodObservations,
  openTestDb,
  seedWorld,
  type World,
} from "./helpers/world.js";

function fullRelease(db: ReturnType<typeof openTestDb>, w: World, stepId: string, crewId: string) {
  submitPackage(
    db,
    {
      stepId,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: crewId,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  signRelease(db, stepId, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, stepId, w.supervisor, new Date(BASE_MS + 1000).toISOString());
}

test("校准撤销：未开工放行撤销，旧校准不能用于新证据", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  fullRelease(db, w, w.stepA1, w.crewA);

  revokeCalibration(db, w.calibrationId, "周期复核超差", new Date(BASE_MS + 2000).toISOString());

  const step = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(step.status, "PENDING_RELEASE");
  const decision = db
    .prepare("SELECT state, cancel_reason FROM release_decisions WHERE step_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(w.stepA1) as { state: string; cancel_reason: string | null };
  assert.equal(decision.state, "CANCELLED");
  assert.ok(decision.cancel_reason?.includes("CALIBRATION_REVOKE"));

  assert.throws(
    () =>
      submitPackage(
        db,
        {
          stepId: w.stepA1,
          baselineId: w.baselineId,
          calibrationId: w.calibrationId,
          submittedByCrewId: w.crewA,
          observedAt: new Date(BASE_MS - 10_000).toISOString(),
          observations: goodObservations(),
        },
        new Date(BASE_MS + 3000).toISOString(),
      ),
    (e: unknown) => e instanceof DomainError && e.code === "CALIBRATION_REVOKED",
  );
});

test("校准撤销：已执行工序转风险评估，监理关闭风险后恢复已执行台账", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  fullRelease(db, w, w.stepA1, w.crewA);
  grantLease(db, w.stepA1, new Date(BASE_MS + 2000).toISOString());
  completeExecution(db, w.stepA1, new Date(BASE_MS + 3000).toISOString());

  revokeCalibration(db, w.calibrationId, "周期复核超差", new Date(BASE_MS + 4000).toISOString());

  const step = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(step.status, "AT_RISK");
  const risk = db.prepare("SELECT * FROM risk_assessments WHERE step_id = ? AND state = 'OPEN'").get(w.stepA1) as {
    id: string;
    trigger_type: string;
  };
  assert.equal(risk.trigger_type, "CALIBRATION_REVOKE");

  resolveRiskAssessment(db, risk.id, w.supervisor, new Date(BASE_MS + 5000).toISOString());
  const after = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(after.status, "EXECUTED");
});

test("校准撤销：施工中工序挂起现场复核，不撤销原放行", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  fullRelease(db, w, w.stepA1, w.crewA);
  grantLease(db, w.stepA1, new Date(BASE_MS + 2000).toISOString());

  revokeCalibration(db, w.calibrationId, "仪器故障", new Date(BASE_MS + 3000).toISOString());
  const row = db.prepare("SELECT status, review_pending FROM work_steps WHERE id = ?").get(w.stepA1) as {
    status: string;
    review_pending: number;
  };
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(row.review_pending, 1);
  const releases = db.prepare("SELECT COUNT(*) AS n FROM release_decisions WHERE step_id = ? AND state = 'RELEASED'").get(w.stepA1) as { n: number };
  assert.equal(releases.n, 1);
});

test("设计换版：一次变更分别列出待放行、施工中、已执行工序处置，并波及相应班组", () => {
  const db = openTestDb();
  const w = seedWorld(db);

  // C 区 C1：证据已交但未签署，处于待放行
  const stepC1 = Plan.registerStep(db, {
    zoneId: w.zoneC,
    crewId: w.crewC,
    code: "C1-支顶",
    title: "C段支顶停检点",
    designVersionId: w.designId,
    controlPoints: [{ code: "P1", x: 0, y: 0, z: 0 }],
    displacementToleranceMm: 5,
    settlementToleranceMm: 3,
    observationValiditySeconds: 3600,
  });
  submitPackage(
    db,
    {
      stepId: stepC1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewC,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: [
        { pointCode: "P1", sequenceNo: 1, x: 0, y: 0, z: 0, displacementMm: 0, settlementMm: 0 },
      ],
    },
    new Date(BASE_MS).toISOString(),
  );

  // B1 先执行完成（释放租约），再执行 A1，最后 A2 放行持约施工（重叠区串行）
  fullRelease(db, w, w.stepB1, w.crewB);
  grantLease(db, w.stepB1, new Date(BASE_MS + 2000).toISOString());
  completeExecution(db, w.stepB1, new Date(BASE_MS + 3000).toISOString());

  fullRelease(db, w, w.stepA1, w.crewA);
  grantLease(db, w.stepA1, new Date(BASE_MS + 4000).toISOString());
  completeExecution(db, w.stepA1, new Date(BASE_MS + 5000).toISOString());
  fullRelease(db, w, w.stepA2, w.crewA);
  grantLease(db, w.stepA2, new Date(BASE_MS + 6000).toISOString());

  const d2 = Plan.createDesignVersion(db, { label: "设计-换版-2026-09-24", supersedesId: w.designId });
  const change = applyDesignChange(db, w.designId, d2, new Date(BASE_MS + 7000).toISOString());

  assert.deepEqual(change.dispositions.REVOKE_PENDING.map((x) => x.stepId), [stepC1]);
  assert.deepEqual(change.dispositions.IN_PROGRESS_REVIEW.map((x) => x.stepId), [w.stepA2]);
  assert.deepEqual(
    change.dispositions.EXECUTED_TO_RISK.map((x) => x.stepId).sort(),
    [w.stepA1, w.stepB1].sort(),
  );
  // 波及甲/乙/丙三班
  assert.deepEqual(change.affectedCrewIds.sort(), [w.crewA, w.crewB, w.crewC].sort());

  const view = getDesignChangeView(db, change.changeId);
  assert.equal((view.pendingRelease as unknown[]).length, 1);
  assert.equal((view.inProgress as unknown[]).length, 1);
  assert.equal((view.executed as unknown[]).length, 2);
  assert.equal((view.pendingRelease as { crewName: string }[])[0].crewName, "丙班监测组");

  const board = buildBoard(db, BASE_MS + 8000);
  const c1 = board.find((r) => r.stepId === stepC1)!;
  assert.ok(c1.blockers.some((b) => b.code === "DESIGN_CHANGED"));
  const a2row = board.find((r) => r.stepId === w.stepA2)!;
  assert.equal(a2row.reviewPending, true);
  const b1row = board.find((r) => r.stepId === w.stepB1)!;
  assert.equal(b1row.openRisk, true);
});

test("设计换版后：已放行未开工工序撤销放行，按新版重新出证、重走双签", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  fullRelease(db, w, w.stepA1, w.crewA); // RELEASED 未开工
  const d2 = Plan.createDesignVersion(db, { label: "设计-换版-二版", supersedesId: w.designId });
  const baseline2 = Plan.createBaseline(db, { designVersionId: d2, label: "BL-廊桥", revision: 2 });
  applyDesignChange(db, w.designId, d2, new Date(BASE_MS + 2000).toISOString());

  const step = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(step.status, "PENDING_RELEASE");
  const cancelled = db.prepare("SELECT cancel_reason FROM release_decisions WHERE step_id = ? AND state = 'CANCELLED'").get(w.stepA1) as { cancel_reason: string };
  assert.ok(cancelled.cancel_reason.includes("DESIGN_CHANGE"));

  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: baseline2,
      calibrationId: w.calibrationId,
      designVersionId: d2,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 5_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS + 3000).toISOString(),
  );
  assert.throws(
    () => signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 3500).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "SURVEY_SIGNATURE_FIRST",
  );
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS + 4000).toISOString());
  const final = signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 5000).toISOString());
  assert.equal(final.released, true);
});

test("校准撤销重复提交被拒绝，且必须填写原因", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  revokeCalibration(db, w.calibrationId, "首次撤销", new Date(BASE_MS).toISOString());
  assert.throws(
    () => revokeCalibration(db, w.calibrationId, "再次撤销", new Date(BASE_MS + 1000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "CALIBRATION_ALREADY_REVOKED",
  );
  assert.throws(
    () => revokeCalibration(db, w.calibrationId, "  ", new Date(BASE_MS + 2000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "REVOKE_REASON_REQUIRED",
  );
});
