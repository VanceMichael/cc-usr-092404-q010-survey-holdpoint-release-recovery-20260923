import assert from "node:assert/strict";
import test from "node:test";
import { submitPackage } from "../src/domain/evidence.js";
import { computeBlockage } from "../src/domain/evaluate.js";
import { grantLease, signRelease } from "../src/domain/sign.js";
import {
  BASE_MS,
  blockerCodes,
  goodObservations,
  incompleteObservations,
  openTestDb,
  outOfToleranceObservations,
  seedWorld,
  type World,
} from "./helpers/world.js";

test("无证据包：看板判定不可放行并归因为证据缺失", () => {
  const db = openTestDb();
  seedWorld(db);
  const result = computeBlockage(db, "s-a1", BASE_MS, new Set());
  assert.equal(result.releasable, false);
  assert.deepEqual(blockerCodes(result), ["PACKAGE_MISSING"]);
});

test("缺项：序号/坐标不完整不能参与仲裁，归因为 MISSING_FIELD 而非超差", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: incompleteObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  const result = computeBlockage(db, w.stepA1, BASE_MS, new Set());
  const codes = blockerCodes(result);
  assert.ok(codes.includes("MISSING_FIELD"));
  // P2 整行缺失与 P1 坐标不完整都是缺项
  assert.equal(result.blockers.filter((b) => b.code === "MISSING_FIELD").length, 2);
});

test("测量超差：阻断码 OUT_OF_TOLERANCE，主体定位到控制点", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: outOfToleranceObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  const result = computeBlockage(db, w.stepA1, BASE_MS, new Set());
  const tolerance = result.blockers.filter((b) => b.code === "OUT_OF_TOLERANCE");
  assert.ok(tolerance.some((b) => b.subject === "P1"));
  assert.equal(result.releasable, false);
});

test("上游阻断沿工序依赖传播：A1 未放行时 A2 记 UPSTREAM_BLOCKED", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  // 先给 A2 提交合格证据——A2 自身无问题，但 A1 没有包
  submitPackage(
    db,
    {
      stepId: w.stepA2,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  const result = computeBlockage(db, w.stepA2, BASE_MS, new Set());
  assert.ok(blockerCodes(result).includes("UPSTREAM_BLOCKED"));
  assert.equal(result.upstream[0].stepId, w.stepA1);
  assert.ok(result.upstream[0].reasons.some((r) => r.includes("证据包")));
});

test("上游自身超差：下游看板阻断详情明确归因到上游的测量超差", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: outOfToleranceObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  submitPackage(
    db,
    {
      stepId: w.stepA2,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  const result = computeBlockage(db, w.stepA2, BASE_MS, new Set());
  const upstream = result.blockers.find((b) => b.code === "UPSTREAM_BLOCKED")!;
  assert.ok(upstream.detail.includes("测量超差"), upstream.detail);
});

test("相邻区域冲突：重叠区有在持租约时，待放行工序出现 ADJACENT_CONFLICT", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  // 手动构造：A1 放行并持租约施工
  releaseAndLease(db, w, w.stepA1);
  // B1 提交合格包，因 A/B 重叠被相邻冲突阻断
  submitPackage(
    db,
    {
      stepId: w.stepB1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewB,
      observedAt: new Date(BASE_MS - 30_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  const result = computeBlockage(db, w.stepB1, BASE_MS, new Set());
  const adjacent = result.blockers.find((b) => b.code === "ADJACENT_CONFLICT");
  assert.ok(adjacent, "应当检测到相邻区域冲突");
  assert.ok(adjacent!.detail.includes(w.stepA1) || adjacent!.subject.includes("A1"));
});

test("观测时效：超过工序登记的观测时效记 STALE_OBSERVATION", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 7200_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS - 7200_000 + 1000).toISOString(),
  );
  const result = computeBlockage(db, w.stepA1, BASE_MS, new Set());
  assert.ok(blockerCodes(result).includes("STALE_OBSERVATION"));
});

test("合格证据包且上游放行后：可放行", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  releaseAndLease(db, w, w.stepA1);
  db.prepare("UPDATE construction_leases SET released_at = ? WHERE step_id = ?").run(
    new Date(BASE_MS + 1000).toISOString(),
    w.stepA1,
  );
  db.prepare("UPDATE work_steps SET status = 'EXECUTED' WHERE id = ?").run(w.stepA1);
  submitPackage(
    db,
    {
      stepId: w.stepA2,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  const result = computeBlockage(db, w.stepA2, BASE_MS, new Set());
  assert.equal(result.releasable, true, JSON.stringify(result.blockers));
});

/** 夹具：合格包 → 复核人签 → 监理签 → 拿租约（A 区场景） */
function releaseAndLease(db: ReturnType<typeof openTestDb>, w: World, stepId: string): void {
  submitPackage(
    db,
    {
      stepId,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
  signRelease(db, stepId, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, stepId, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  grantLease(db, stepId, new Date(BASE_MS + 2000).toISOString());
}
