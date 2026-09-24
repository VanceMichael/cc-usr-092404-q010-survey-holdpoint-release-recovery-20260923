import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/model.js";
import { submitPackage } from "../src/domain/evidence.js";
import { computeBlockage } from "../src/domain/evaluate.js";
import * as Plan from "../src/domain/plan.js";
import { grantLease, signRelease } from "../src/domain/sign.js";
import {
  BASE_MS,
  blockerCodes,
  goodObservations,
  openTestDb,
  outOfToleranceObservations,
  seedWorld,
  type World,
} from "./helpers/world.js";

function submitGood(db: ReturnType<typeof openTestDb>, w: World, stepId: string, crewId: string, opts: { submitter?: string | null } = {}) {
  submitPackage(
    db,
    {
      stepId,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: crewId,
      submittedByUserId: opts.submitter === undefined ? null : opts.submitter,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );
}

test("签署顺序：测量复核人先签、监理后签，完成后工序可拿租约施工", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitGood(db, w, w.stepA1, w.crewA);

  const survey = signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());
  assert.equal(survey.surveySigned, true);
  assert.equal(survey.supervisorSigned, false);
  assert.equal(survey.released, false);

  const final = signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  assert.equal(final.released, true);

  const lease = grantLease(db, w.stepA1, new Date(BASE_MS + 2000).toISOString());
  assert.equal(lease.zoneId, w.zoneA);
  const status = db.prepare("SELECT status FROM work_steps WHERE id = ?").get(w.stepA1) as { status: string };
  assert.equal(status.status, "IN_PROGRESS");
});

test("监理不能先于测量复核人签署", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitGood(db, w, w.stepA1, w.crewA);
  assert.throws(
    () => signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "SURVEY_SIGNATURE_FIRST",
  );
});

test("存在未关闭阻断时监理签署被拒", () => {
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
  assert.throws(
    () => signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "BLOCKERS_PRESENT",
  );
});

test("两个角色都不能批准自己提交的材料，换人可签", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  // 承包方测量员（持测量账户 u-sub）代提交
  submitGood(db, w, w.stepA1, w.crewA, { submitter: w.submitter });

  assert.throws(
    () => signRelease(db, w.stepA1, w.submitter, new Date(BASE_MS).toISOString()),
    (e: unknown) => e instanceof DomainError && e.statusCode === 403 && e.code === "SELF_SUBMISSION",
  );
  // 另一名测量复核人可以签
  signRelease(db, w.stepA1, w.surveyor2, new Date(BASE_MS).toISOString());
  // 监理不是提交人，可后签放行
  const final = signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  assert.equal(final.released, true);
});

test("并发签署面对版本变化：复核签署后设计换版，监理必须等其按新版本重新确认", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitGood(db, w, w.stepA1, w.crewA);
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());

  // 监理尚未签署时设计换版：工序指向新版本，旧证据包版本不符
  const d2 = "d2-late";
  db.prepare("INSERT INTO design_versions (id, label, supersedes_id) VALUES (?, ?, ?)").run(
    d2,
    "设计-甲-换版",
    w.designId,
  );
  const baseline2 = Plan.createBaseline(db, {
    designVersionId: d2,
    label: "BL-廊桥",
    revision: 2,
  });
  db.prepare("UPDATE work_steps SET design_version_id = ? WHERE id = ?").run(d2, w.stepA1);

  // 监理直接签旧包：复核签署后版本已变，要求重新确认
  assert.throws(
    () => signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "SIGN_RECONFIRM_REQUIRED",
  );

  // 按新版本重新出证后，监理仍不能跳过复核人
  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: baseline2,
      calibrationId: w.calibrationId,
      designVersionId: d2,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 30_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS + 2000).toISOString(),
  );
  assert.throws(
    () => signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 3000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "SURVEY_SIGNATURE_FIRST",
  );

  // 复核人按新版本重新确认后，监理签署放行
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS + 4000).toISOString());
  const final = signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 5000).toISOString());
  assert.equal(final.released, true);
});

test("监理重复签署被拒（并发双签只有一个生效）", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitGood(db, w, w.stepA1, w.crewA);
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());
  assert.throws(
    () => signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 2000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "ALREADY_SIGNED",
  );
});

test("租约争用：重叠工作区双方均已放行时，先后申请租约只能一个获准", () => {
  const db = openTestDb();
  const w = seedWorld(db);

  // 双方在均无在持租约时完成签署（相邻冲突只看在持租约）
  submitGood(db, w, w.stepA1, w.crewA);
  signRelease(db, w.stepA1, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, w.stepA1, w.supervisor, new Date(BASE_MS + 1000).toISOString());

  submitGood(db, w, w.stepB1, w.crewB);
  signRelease(db, w.stepB1, w.surveyor, new Date(BASE_MS).toISOString());
  signRelease(db, w.stepB1, w.supervisor, new Date(BASE_MS + 1000).toISOString());

  grantLease(db, w.stepA1, new Date(BASE_MS + 2000).toISOString());
  assert.throws(
    () => grantLease(db, w.stepB1, new Date(BASE_MS + 3000).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "LEASE_CONTENTION",
  );

  // A/B 重叠区有在持租约后，B1 看板也归因为相邻冲突
  const blockage = computeBlockage(db, w.stepB1, BASE_MS + 4000, new Set());
  assert.ok(blockerCodes(blockage).includes("ADJACENT_CONFLICT"));
});

test("上游未放行时下游不能签署，上游完成后放行链贯通", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  submitGood(db, w, w.stepA2, w.crewA);
  assert.throws(
    () => signRelease(db, w.stepA2, w.surveyor, new Date(BASE_MS).toISOString()),
    (e: unknown) => e instanceof DomainError && e.code === "BLOCKERS_PRESENT",
  );
});
