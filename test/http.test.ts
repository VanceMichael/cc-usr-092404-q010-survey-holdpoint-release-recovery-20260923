import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import * as Plan from "../src/domain/plan.js";
import { BASE_MS, iso, openTestDb, seedWorld, type World } from "./helpers/world.js";

function appFor(db: ReturnType<typeof openTestDb>): FastifyInstance {
  return buildApp({ db, clock: () => new Date(BASE_MS) });
}

async function fullReleaseViaHttp(app: FastifyInstance, w: World, stepId: string, crewId: string) {
  const submit = await app.inject({
    method: "POST",
    url: `/steps/${stepId}/packages`,
    payload: {
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: crewId,
      observedAt: iso(-60),
      observations: [
        { pointCode: "P1", sequenceNo: 1, x: 0, y: 0, z: 0, displacementMm: 0, settlementMm: 0 },
        { pointCode: "P2", sequenceNo: 2, x: 1, y: 0, z: 0, displacementMm: 0.2, settlementMm: 0 },
      ],
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);
  let res = await app.inject({ method: "POST", url: `/steps/${stepId}/sign`, payload: { userId: w.surveyor } });
  assert.equal(res.statusCode, 200, res.body);
  res = await app.inject({ method: "POST", url: `/steps/${stepId}/sign`, payload: { userId: w.supervisor } });
  assert.equal(res.statusCode, 200, res.body);
}

test("HTTP 端到端：看板归因 → 整改 → 双签 → 租约争用 → 换版处置", async () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const app = appFor(db);

  // 1) 提交超差包
  let res = await app.inject({
    method: "POST",
    url: `/steps/${w.stepA1}/packages`,
    payload: {
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: iso(-60),
      observations: [
        { pointCode: "P1", sequenceNo: 1, x: 0.009, y: 0, z: 0.004, displacementMm: 9, settlementMm: 4 },
        { pointCode: "P2", sequenceNo: 2, x: 1, y: 0, z: 0, displacementMm: 0.2, settlementMm: 0 },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  await app.inject({ method: "POST", url: `/steps/${w.stepA1}/check` });

  // 2) 看板判定 A1 阻断，归因到测量超差
  let board = await app.inject({ method: "GET", url: "/board" });
  assert.equal(board.statusCode, 200);
  let a1 = board.json().rows.find((r: any) => r.stepId === w.stepA1);
  assert.equal(a1.releasable, false);
  assert.ok(a1.blockers.some((b: any) => b.code === "OUT_OF_TOLERANCE" && b.subject === "P1"));

  // 3) 监理先于复核人签署被拒 409（协议顺序先于阻断校验）
  res = await app.inject({ method: "POST", url: `/steps/${w.stepA1}/sign`, payload: { userId: w.supervisor } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "SURVEY_SIGNATURE_FIRST");

  // 4) 整改新包 v2
  res = await app.inject({
    method: "POST",
    url: `/steps/${w.stepA1}/packages`,
    payload: {
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: iso(-30),
      observations: [
        { pointCode: "P1", sequenceNo: 1, x: 0, y: 0, z: 0, displacementMm: 0, settlementMm: 0 },
        { pointCode: "P2", sequenceNo: 2, x: 1, y: 0, z: 0, displacementMm: 0.2, settlementMm: 0 },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().packageVersion, 2);

  // 5) 双签放行
  res = await app.inject({ method: "POST", url: `/steps/${w.stepA1}/sign`, payload: { userId: w.surveyor } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: "POST", url: `/steps/${w.stepA1}/sign`, payload: { userId: w.supervisor } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().released, true);

  // 6) 拿租约施工
  res = await app.inject({ method: "POST", url: `/steps/${w.stepA1}/lease` });
  assert.equal(res.statusCode, 200);

  // 7) 停检点详情包含完整包谱系与决定历史
  const detail = await app.inject({ method: "GET", url: `/steps/${w.stepA1}` });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().packages.length, 2);

  await app.close();
});

test("HTTP：租约争用返回 409 LEASE_CONTENTION", async () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const app = appFor(db);

  await fullReleaseViaHttp(app, w, w.stepA1, w.crewA);
  await fullReleaseViaHttp(app, w, w.stepB1, w.crewB);

  let res = await app.inject({ method: "POST", url: `/steps/${w.stepA1}/lease` });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: "POST", url: `/steps/${w.stepB1}/lease` });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "LEASE_CONTENTION");

  await app.close();
});

test("HTTP：设计换版影响清单按三类处置分组并标注波及班组", async () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const app = appFor(db);
  await fullReleaseViaHttp(app, w, w.stepA1, w.crewA);
  (await app.inject({ method: "POST", url: `/steps/${w.stepA1}/lease` }));
  (await app.inject({ method: "POST", url: `/steps/${w.stepA1}/complete` }));

  const d2 = Plan.createDesignVersion(db, { label: "设计-二版", supersedesId: w.designId });
  const change = await app.inject({
    method: "POST",
    url: "/design-changes",
    payload: { fromDesignVersionId: w.designId, toDesignVersionId: d2 },
  });
  assert.equal(change.statusCode, 200, change.body);
  const changeId = change.json().changeId;
  // A1 已执行入风险；从未交证的 B1 同样登记在旧版下，被重指新版待放行，乙班一并被波及
  assert.deepEqual(change.json().affectedCrewIds.sort(), [w.crewA, w.crewB].sort());

  const view = await app.inject({ method: "GET", url: `/design-changes/${changeId}` });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().executed.length, 1);
  assert.equal(view.json().executed[0].stepId, w.stepA1);
  assert.equal(view.json().pendingRelease.length, 2);

  await app.close();
});

test("HTTP：错误映射 400/403/404", async () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const app = appFor(db);

  // 404：不存在的停检点
  let res = await app.inject({ method: "GET", url: "/steps/nope" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "STEP_NOT_FOUND");

  // 400：容差非法
  res = await app.inject({
    method: "POST",
    url: "/steps",
    payload: {
      zoneId: w.zoneA,
      crewId: w.crewA,
      code: "BAD",
      title: "x",
      designVersionId: w.designId,
      controlPoints: [],
      displacementToleranceMm: -1,
      settlementToleranceMm: 3,
      observationValiditySeconds: 3600,
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "INVALID_TOLERANCE");

  // 403：提交人自批
  await app.inject({
    method: "POST",
    url: `/steps/${w.stepA1}/packages`,
    payload: {
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      submittedByUserId: w.submitter,
      observedAt: iso(-60),
      observations: [
        { pointCode: "P1", sequenceNo: 1, x: 0, y: 0, z: 0, displacementMm: 0, settlementMm: 0 },
        { pointCode: "P2", sequenceNo: 2, x: 1, y: 0, z: 0, displacementMm: 0, settlementMm: 0 },
      ],
    },
  });
  res = await app.inject({ method: "POST", url: `/steps/${w.stepA1}/sign`, payload: { userId: w.submitter } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "SELF_SUBMISSION");

  await app.close();
});

test("HTTP：健康检查仍可用", async () => {
  const db = openTestDb();
  const app = buildApp({ db });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
  await app.close();
});

// 固定 BASE_MS 引用，避免时间工具被误删
void BASE_MS;
