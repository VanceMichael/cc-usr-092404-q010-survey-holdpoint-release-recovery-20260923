import assert from "node:assert/strict";
import test from "node:test";
import { submitPackage } from "../src/domain/evidence.js";
import { advanceReviewBatch, createReviewBatch, getBatchView } from "../src/domain/batch.js";
import { DomainError } from "../src/domain/model.js";
import {
  BASE_MS,
  goodObservations,
  openTestDb,
  seedWorld,
} from "./helpers/world.js";

test("批量校核：分批推进，游标即中断点", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  const batchId = createReviewBatch(db); // 默认含 A1/A2/B1 三项
  const initial = getBatchView(db, batchId);
  assert.equal(initial.totalItems, 3);
  assert.deepEqual(initial.items.map((i) => i.state), ["PENDING", "PENDING", "PENDING"]);

  const first = advanceReviewBatch(db, batchId, BASE_MS, 1);
  assert.equal(first.state, "RUNNING");
  assert.equal(first.cursorIndex, 1);
  assert.equal(first.items.filter((i) => i.state === "DONE").length, 1);

  // 模拟进程中断后重跑：从游标后的 PENDING 项继续，已完成项不重算
  const second = advanceReviewBatch(db, batchId, BASE_MS, 1);
  assert.equal(second.cursorIndex, 2);
  assert.equal(second.items.filter((i) => i.state === "DONE").length, 2);

  const done = advanceReviewBatch(db, batchId, BASE_MS);
  assert.equal(done.state, "COMPLETED");
  assert.equal(done.items.every((i) => i.state === "DONE"), true);
});

test("批量校核：单项失败标记 FAILED 并记录游标；修复后从中断处恢复至完成", () => {
  const db = openTestDb();
  const w = seedWorld(db);
  // 给 A1 提交合格包，让校核结果有意义
  submitPackage(
    db,
    {
      stepId: w.stepA1,
      baselineId: w.baselineId,
      calibrationId: w.calibrationId,
      submittedByCrewId: w.crewA,
      observedAt: new Date(BASE_MS - 60_000).toISOString(),
      observations: goodObservations(),
    },
    new Date(BASE_MS).toISOString(),
  );

  const batchId = createReviewBatch(db);
  advanceReviewBatch(db, batchId, BASE_MS, 1); // 第一项完成

  // 第二项的前置关系数据损坏导致该项校核抛错
  db.prepare("UPDATE work_steps SET prerequisite_step_ids = ? WHERE id = ?").run(
    "{损坏",
    w.stepA2,
  );

  assert.throws(() => advanceReviewBatch(db, batchId, BASE_MS, 5));
  const interrupted = getBatchView(db, batchId);
  assert.equal(interrupted.state, "FAILED");
  assert.equal(interrupted.items[0].state, "DONE");
  assert.equal(interrupted.items[1].state, "FAILED");
  assert.equal(interrupted.items[2].state, "PENDING");

  // 修复数据，再次推进：从失败项继续，最终完成
  db.prepare("UPDATE work_steps SET prerequisite_step_ids = ? WHERE id = ?").run(
    JSON.stringify([w.stepA1]),
    w.stepA2,
  );
  const recovered = advanceReviewBatch(db, batchId, BASE_MS, 5);
  assert.equal(recovered.state, "COMPLETED");
  assert.deepEqual(recovered.items.map((i) => i.state), ["DONE", "DONE", "DONE"]);
  // 第一项的校核结果快照仍在
  assert.equal((recovered.items[0].result as { releasable: boolean }).releasable, true);
});

test("批量校核：空批次被拒绝", () => {
  const db = openTestDb();
  seedWorld(db);
  // 全部工序转终态后默认批次为空：直接置为已执行
  db.prepare("UPDATE work_steps SET status = 'EXECUTED'").run();
  assert.throws(
    () => createReviewBatch(db),
    (e: unknown) => e instanceof DomainError && e.code === "EMPTY_BATCH",
  );
});
