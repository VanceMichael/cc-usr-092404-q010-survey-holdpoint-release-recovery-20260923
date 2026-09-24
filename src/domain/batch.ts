import type { Db } from "./model.js";
import { badRequest, newId, transaction } from "./model.js";
import { checkStep } from "./evaluate.js";

export interface BatchItemView {
  itemId: string;
  stepId: string;
  itemIndex: number;
  state: string;
  result: unknown | null;
}

export interface BatchView {
  batchId: string;
  state: string;
  cursorIndex: number;
  totalItems: number;
  items: BatchItemView[];
}

/** 创建批量校核批次（缺省覆盖全部待放行/已放行未开工/施工中的停检点） */
export function createReviewBatch(db: Db, stepIds?: string[]): string {
  return transaction(db, () => {
    const ids =
      stepIds && stepIds.length > 0
        ? stepIds
        : (
            db
              .prepare(
                `SELECT id FROM work_steps
                 WHERE status IN ('PENDING_RELEASE', 'RELEASED', 'IN_PROGRESS')
                 ORDER BY code`,
              )
              .all() as { id: string }[]
          ).map((r) => r.id);
    if (ids.length === 0) throw badRequest("EMPTY_BATCH", "没有可校核的停检点");

    const batchId = newId();
    db.prepare(
      "INSERT INTO review_batches (id, state, cursor_index, total_items) VALUES (?, 'PENDING', 0, ?)",
    ).run(batchId, ids.length);
    const itemStmt = db.prepare(
      "INSERT INTO review_batch_items (id, batch_id, step_id, item_index, state) VALUES (?, ?, ?, ?, 'PENDING')",
    );
    ids.forEach((stepId, index) => itemStmt.run(newId(), batchId, stepId, index));
    return batchId;
  });
}

/**
 * 推进批量校核；从游标后第一个 PENDING 项继续（中断恢复）。
 * 每项独立事务提交：进程中断后已完成项保留，重跑从未完成处续算。
 * limit 限制本次处理项数；返回批次最新视图。
 */
export function advanceReviewBatch(db: Db, batchId: string, atMs: number, limit?: number): BatchView {
  const batch = db.prepare("SELECT * FROM review_batches WHERE id = ?").get(batchId) as
    | Record<string, any>
    | undefined;
  if (!batch) throw badRequest("BATCH_NOT_FOUND", `校核批次 ${batchId} 不存在`);
  if (batch.state === "COMPLETED") return getBatchView(db, batchId);

  const pending = db
    .prepare(
      `SELECT * FROM review_batch_items
       WHERE batch_id = ? AND state IN ('PENDING', 'FAILED')
       ORDER BY item_index
       LIMIT ?`,
    )
    .all(batchId, limit ?? 1000) as any[];

  db.prepare("UPDATE review_batches SET state = 'RUNNING' WHERE id = ?").run(batchId);

  let cursor = batch.cursor_index;
  for (const item of pending) {
    try {
      const result = checkStep(db, item.step_id, atMs);
      transaction(db, () => {
        db.prepare(
          `UPDATE review_batch_items
             SET state = 'DONE', checked_at = ?, result_summary = ?
           WHERE id = ?`,
        ).run(new Date(atMs).toISOString(), JSON.stringify(compactResult(result)), item.id);
        db.prepare("UPDATE review_batches SET cursor_index = ? WHERE id = ?").run(
          Math.max(cursor, item.item_index + 1),
          batchId,
        );
      });
      cursor = Math.max(cursor, item.item_index + 1);
    } catch (error) {
      transaction(db, () => {
        db.prepare(
          `UPDATE review_batch_items SET state = 'FAILED', checked_at = ?, result_summary = ? WHERE id = ?`,
        ).run(
          new Date(atMs).toISOString(),
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          item.id,
        );
        db.prepare("UPDATE review_batches SET state = 'FAILED', cursor_index = ? WHERE id = ?").run(
          item.item_index,
          batchId,
        );
      });
      throw error;
    }
  }

  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM review_batch_items WHERE batch_id = ? AND state IN ('PENDING', 'FAILED')",
    )
    .get(batchId) as { n: number };
  if (remaining.n === 0)
    db.prepare(
      "UPDATE review_batches SET state = 'COMPLETED', completed_at = ? WHERE id = ?",
    ).run(new Date(atMs).toISOString(), batchId);

  return getBatchView(db, batchId);
}

function compactResult(result: ReturnType<typeof checkStep>) {
  return {
    releasable: result.releasable,
    blockers: result.blockers.map((b) => ({ code: b.code, subject: b.subject, detail: b.detail })),
    waived: result.waived.map((b) => b.code),
  };
}

export function getBatchView(db: Db, batchId: string): BatchView {
  const batch = db.prepare("SELECT * FROM review_batches WHERE id = ?").get(batchId) as
    | any
    | undefined;
  if (!batch) throw badRequest("BATCH_NOT_FOUND", `校核批次 ${batchId} 不存在`);
  const items = db
    .prepare("SELECT * FROM review_batch_items WHERE batch_id = ? ORDER BY item_index")
    .all(batchId) as any[];
  return {
    batchId,
    state: batch.state,
    cursorIndex: batch.cursor_index,
    totalItems: batch.total_items,
    items: items.map((i) => ({
      itemId: i.id,
      stepId: i.step_id,
      itemIndex: i.item_index,
      state: i.state,
      result: i.result_summary ? JSON.parse(i.result_summary) : null,
    })),
  };
}
