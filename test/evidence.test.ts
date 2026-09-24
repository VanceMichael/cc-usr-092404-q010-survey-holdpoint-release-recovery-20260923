import assert from "node:assert/strict";
import test from "node:test";
import { submitPackage, getPackageHistory } from "../src/domain/evidence.js";
import { checkStep, computeBlockage } from "../src/domain/evaluate.js";
import { grantWaiver, revokeWaiver } from "../src/domain/waiver.js";
import { completeExecution, grantLease, signRelease } from "../src/domain/sign.js";
import { DomainError } from "../src/domain/model.js";
import {
  BASE_MS,
  goodObservations,
  openTestDb,
  outOfToleranceObservations,
  seedWorld,
  type World,
} from "./helpers/world.js";

function submitAt(
  db: ReturnType<typeof openTestDb>,
  w: World,
  stepId: string,
  observations: ReturnType<typeof goodObservations>,
  opts: { offsetMs?: number; backfilled?: boolean; backfillReason?: string; crewId?: string } = {},
) {
  const offset = opts.offsetMs ?? 60_000;
  return submitPackage(
    db,
    {
      stepId,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: opts.crewId ?? w.crewA,
      observedAt: new Date(BASE_MS - offset).toISOString(),
      backfilled: opts.backfilled,
      backfillReason: opts.backfillReason,
      observations,
    },
    new Date(BASE_MS).toISOString(),
  );
}

test("整改以新证据包关闭偏差：v1 超差缺陷被 v2 关闭，v2 可放行", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const v1 = submitAt(db, w, w.stepA1, outOfToleranceObservations());
  const checked1 = checkStep(db, w.stepA1, BASE_MS);
  assert.equal(checked1.releasable, false);
  const findingId = checked1.blockers.find((b) => b.code === "OUT_OF_TOLERANCE")!.findingId!;

  const v2 = submitAt(db, w, w.stepA1, goodObservations(), { offsetMs: 30_000 });
  assert.notEqual(v1.packageId, v2.packageId);
  assert.equal(v2.packageVersion, 2);

  const checked2 = checkStep(db, w.stepA1, BASE_MS);
  assert.equal(checked2.releasable, true, JSON.stringify(checked2.blockers));

  const oldFinding = db.prepare("SELECT * FROM findings WHERE id = ?").get(findingId) as {
    state: string;
    closed_by_package_id: string | null;
  };
  assert.equal(oldFinding.state, "CLOSED");
  assert.equal(oldFinding.closed_by_package_id, v2.packageId);
});

test("任何操作不覆盖旧包：包谱系版本递增，原始观测摘要保留", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const v1 = submitAt(db, w, w.stepA1, outOfToleranceObservations());
  const v2 = submitAt(db, w, w.stepA1, goodObservations(), { offsetMs: 30_000 });
  const history = getPackageHistory(db, w.stepA1);
  assert.deepEqual(history.map((p) => p.package_version), [1, 2]);
  const first = history.find((p) => p.id === v1.packageId)!;
  assert.ok(first.observation_summary.includes("sha256:"));
  assert.notEqual(first.observation_summary, history.find((p) => p.id === v2.packageId)!.observation_summary);
});

test("人工豁免：监理带期限和依据批准，看板转 waived；到期自动恢复阻断", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitAt(db, w, w.stepA1, outOfToleranceObservations());
  const checked = checkStep(db, w.stepA1, BASE_MS);
  const findingId = checked.blockers.find((b) => b.code === "OUT_OF_TOLERANCE")!.findingId!;

  grantWaiver(
    db,
    {
      findingId,
      grantedByUserId: w.supervisor,
      basis: "专家论证该点偏差为既有木构件徐变，不影响顶升安全",
      expiresAt: new Date(BASE_MS + 86_400_000).toISOString(),
    },
    BASE_MS,
  );

  const waived = computeBlockage(db, w.stepA1, BASE_MS, new Set());
  assert.equal(waived.releasable, true);
  assert.equal(waived.waived.length, 2); // P1 位移 + 沉降两项

  // 到期后未续期，阻断恢复
  const expired = computeBlockage(db, w.stepA1, BASE_MS + 90_000_000, new Set());
  assert.equal(expired.releasable, false);
  assert.ok(expired.blockers.some((b) => b.code === "OUT_OF_TOLERANCE"));
});

test("豁免必须有依据和未来期限；测量复核人无权豁免", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitAt(db, w, w.stepA1, outOfToleranceObservations());
  const findingId = checkStep(db, w.stepA1, BASE_MS).blockers[0].findingId!;

  assert.throws(
    () =>
      grantWaiver(
        db,
        {
          findingId,
          grantedByUserId: w.supervisor,
          basis: "",
          expiresAt: new Date(BASE_MS + 1000).toISOString(),
        },
        BASE_MS,
      ),
    (e: unknown) => e instanceof DomainError && e.code === "WAIVER_BASIS_REQUIRED",
  );
  assert.throws(
    () =>
      grantWaiver(
        db,
        {
          findingId,
          grantedByUserId: w.supervisor,
          basis: "依据",
          expiresAt: new Date(BASE_MS - 1000).toISOString(),
        },
        BASE_MS,
      ),
    (e: unknown) => e instanceof DomainError && e.code === "WAIVER_EXPIRY_PAST",
  );
  assert.throws(
    () =>
      grantWaiver(
        db,
        {
          findingId,
          grantedByUserId: w.surveyor,
          basis: "测量复核人无权豁免",
          expiresAt: new Date(BASE_MS + 1000).toISOString(),
        },
        BASE_MS,
      ),
    (e: unknown) => e instanceof DomainError && e.statusCode === 403,
  );
});

test("豁免撤销后缺陷重新成为阻断", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitAt(db, w, w.stepA1, outOfToleranceObservations());
  const findingId = checkStep(db, w.stepA1, BASE_MS).blockers[0].findingId!;
  const waiver = grantWaiver(
    db,
    {
      findingId,
      grantedByUserId: w.supervisor,
      basis: "临时依据",
      expiresAt: new Date(BASE_MS + 3600_000).toISOString(),
    },
    BASE_MS,
  );
  assert.equal(computeBlockage(db, w.stepA1, BASE_MS, new Set()).releasable, true);
  revokeWaiver(db, waiver.waiverId, new Date(BASE_MS + 1000).toISOString());
  assert.equal(computeBlockage(db, w.stepA1, BASE_MS + 2000, new Set()).releasable, false);
});

test("已关闭缺陷不能再豁免（整改关闭而非豁免）", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const v1 = submitAt(db, w, w.stepA1, outOfToleranceObservations());
  checkStep(db, w.stepA1, BASE_MS);
  submitAt(db, w, w.stepA1, goodObservations(), { offsetMs: 30_000 });
  checkStep(db, w.stepA1, BASE_MS);
  const closed = db
    .prepare("SELECT id FROM findings WHERE package_id = ? AND state = 'CLOSED'")
    .get(v1.packageId) as { id: string };
  assert.throws(
    () =>
      grantWaiver(
        db,
        {
          findingId: closed.id,
          grantedByUserId: w.supervisor,
          basis: "x",
          expiresAt: new Date(BASE_MS + 1000).toISOString(),
        },
        BASE_MS,
      ),
    (e: unknown) => e instanceof DomainError && e.code === "FINDING_CLOSED",
  );
});

test("观测补录：尚未开工的放行撤销，保存原决定", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitAt(db, w, w.stepA1, goodObservations());
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  const before = db.prepare("SELECT id FROM release_decisions WHERE step_id = ? AND state = 'RELEASED'").get(w.stepA1) as { id: string };

  submitAt(db, w, w.stepA1, goodObservations(), {
    offsetMs: 10_000,
    backfilled: true,
    backfillReason: "P1 原始记录笔误，按观测手簿补录",
  });

  const step = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(step.status, "PENDING_RELEASE");
  const decision = db.prepare("SELECT * FROM release_decisions WHERE id = ?").get(before.id) as {
    state: string;
    cancel_reason: string | null;
  };
  assert.equal(decision.state, "CANCELLED");
  assert.ok(decision.cancel_reason?.includes("OBSERVATION_BACKFILL"));
});

test("观测补录：施工中挂起现场复核且不得完成", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitAt(db, w, w.stepA1, goodObservations());
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  grantLease(db, w.stepA1, new Date(BASE_MS + 2000).toISOString());

  submitAt(db, w, w.stepA1, goodObservations(), {
    offsetMs: 5_000,
    backfilled: true,
    backfillReason: "补录沉降读数",
  });

  const step = db.prepare("SELECT status, review_pending FROM work_steps WHERE id = ?").get(w.stepA1) as {
    status: string;
    review_pending: number;
  };
  assert.equal(step.status, "IN_PROGRESS");
  assert.equal(step.review_pending, 1);
  assert.throws(
    () => completeExecution(db, w.stepA1, new Date(BASE_MS + 5000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "REVIEW_PENDING",
  );
});

test("观测补录：已执行工序转风险评估，原放行决定保留", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitAt(db, w, w.stepA1, goodObservations());
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  grantLease(db, w.stepA1, new Date(BASE_MS + 2000).toISOString());
  completeExecution(db, w.stepA1, new Date(BASE_MS + 3000).toISOString());

  submitAt(db, w, w.stepA1, goodObservations(), {
    offsetMs: 2_000,
    backfilled: true,
    backfillReason: "完工复核发现观测手簿缺页补录",
  });

  const step = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(step.status, "AT_RISK");
  const risks = db
    .prepare("SELECT * FROM risk_assessments WHERE step_id = ? AND state = 'OPEN'")
    .all(w.stepA1) as { trigger_type: string; original_decision_id: string }[];
  assert.equal(risks.length, 1);
  assert.equal(risks[0].trigger_type, "OBSERVATION_BACKFILL");
  const original = db.prepare("SELECT state FROM release_decisions WHERE id = ?").get(risks[0].original_decision_id) as { state: string };
  assert.equal(original.state, "RELEASED");
});
