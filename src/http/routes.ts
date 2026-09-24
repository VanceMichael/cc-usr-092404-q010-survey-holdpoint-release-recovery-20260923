import type { FastifyInstance } from "fastify";
import type { Db } from "../domain/model.js";
import { DomainError } from "../domain/model.js";
import * as Plan from "../domain/plan.js";
import * as Evidence from "../domain/evidence.js";
import * as Evaluate from "../domain/evaluate.js";
import * as Batch from "../domain/batch.js";
import * as Waiver from "../domain/waiver.js";
import * as Sign from "../domain/sign.js";
import * as Triggers from "../domain/triggers.js";
import * as Board from "../domain/board.js";

type Body = Record<string, any>;

export function registerRoutes(app: FastifyInstance, db: Db, clock: () => Date = () => new Date()): void {
  const nowIso = () => clock().toISOString();
  const nowMs = () => clock().getTime();

  // ---------- 基础数据 ----------
  app.post("/admin/crews", async (req) => {
    const b = req.body as Body;
    return { crewId: Plan.createCrew(db, { id: b.id, name: b.name }) };
  });
  app.post("/admin/users", async (req) => {
    const b = req.body as Body;
    return { userId: Plan.createUser(db, { id: b.id, name: b.name, role: b.role }) };
  });
  app.post("/admin/design-versions", async (req) => {
    const b = req.body as Body;
    return {
      designVersionId: Plan.createDesignVersion(db, {
        id: b.id,
        label: b.label,
        supersedesId: b.supersedesId ?? null,
      }),
    };
  });
  app.post("/admin/baselines", async (req) => {
    const b = req.body as Body;
    return {
      baselineId: Plan.createBaseline(db, {
        id: b.id,
        designVersionId: b.designVersionId,
        label: b.label,
        revision: b.revision,
      }),
    };
  });
  app.post("/admin/calibrations", async (req) => {
    const b = req.body as Body;
    return {
      calibrationId: Plan.createCalibration(db, {
        id: b.id,
        instrumentCode: b.instrumentCode,
        versionLabel: b.versionLabel,
        calibratedAt: b.calibratedAt,
      }),
    };
  });
  app.post("/admin/work-zones", async (req) => {
    const b = req.body as Body;
    return { zoneId: Plan.createWorkZone(db, { id: b.id, code: b.code, name: b.name }) };
  });
  app.post("/admin/work-zone-overlaps", async (req) => {
    const b = req.body as Body;
    Plan.markOverlap(db, b.zoneAId, b.zoneBId);
    return { status: "ok" };
  });

  // ---------- 方案：停检点登记 ----------
  app.post("/steps", async (req) => {
    const b = req.body as Body;
    const stepId = Plan.registerStep(db, {
      id: b.id,
      zoneId: b.zoneId,
      crewId: b.crewId,
      code: b.code,
      title: b.title,
      designVersionId: b.designVersionId,
      prerequisiteStepIds: b.prerequisiteStepIds,
      controlPoints: b.controlPoints,
      displacementToleranceMm: b.displacementToleranceMm,
      settlementToleranceMm: b.settlementToleranceMm,
      observationValiditySeconds: b.observationValiditySeconds,
    });
    return { stepId };
  });

  // ---------- 证据包 ----------
  app.post("/steps/:stepId/packages", async (req) => {
    const { stepId } = req.params as { stepId: string };
    const b = req.body as Body;
    return Evidence.submitPackage(
      db,
      {
        stepId,
        baselineId: b.baselineId,
        calibrationId: b.calibrationId,
        designVersionId: b.designVersionId,
        submittedByCrewId: b.submittedByCrewId,
        submittedByUserId: b.submittedByUserId ?? null,
        observedAt: b.observedAt,
        submittedAt: b.submittedAt,
        backfilled: Boolean(b.backfilled),
        backfillReason: b.backfillReason ?? null,
        observations: b.observations ?? [],
        note: b.note,
      },
      b.submittedAt ?? nowIso(),
    );
  });

  app.get("/steps/:stepId/packages", async (req) => {
    const { stepId } = req.params as { stepId: string };
    return { packages: Evidence.getPackageHistory(db, stepId) };
  });

  // ---------- 校核 ----------
  app.post("/steps/:stepId/check", async (req) => {
    const { stepId } = req.params as { stepId: string };
    return Evaluate.checkStep(db, stepId, nowMs());
  });

  app.post("/reviews/batches", async (req) => {
    const b = (req.body ?? {}) as Body;
    return { batchId: Batch.createReviewBatch(db, b.stepIds) };
  });
  app.post("/reviews/batches/:batchId/advance", async (req) => {
    const { batchId } = req.params as { batchId: string };
    const query = req.query as { limit?: string };
    return Batch.advanceReviewBatch(db, batchId, nowMs(), query.limit ? Number(query.limit) : undefined);
  });
  app.get("/reviews/batches/:batchId", async (req) => {
    const { batchId } = req.params as { batchId: string };
    return Batch.getBatchView(db, batchId);
  });

  // ---------- 豁免 ----------
  app.post("/waivers", async (req) => {
    const b = req.body as Body;
    return Waiver.grantWaiver(
      db,
      {
        findingId: b.findingId,
        grantedByUserId: b.grantedByUserId,
        basis: b.basis,
        expiresAt: b.expiresAt,
      },
      nowMs(),
    );
  });
  app.post("/waivers/:waiverId/revoke", async (req) => {
    const { waiverId } = req.params as { waiverId: string };
    Waiver.revokeWaiver(db, waiverId, nowIso());
    return { status: "ok" };
  });

  // ---------- 签署 / 租约 / 施工 ----------
  app.post("/steps/:stepId/sign", async (req) => {
    const { stepId } = req.params as { stepId: string };
    const b = req.body as Body;
    return Sign.signRelease(db, stepId, b.userId, nowIso());
  });

  app.post("/steps/:stepId/lease", async (req) => {
    const { stepId } = req.params as { stepId: string };
    return Sign.grantLease(db, stepId, nowIso());
  });
  app.post("/steps/:stepId/complete", async (req) => {
    const { stepId } = req.params as { stepId: string };
    Sign.completeExecution(db, stepId, nowIso());
    return { status: "ok" };
  });
  app.post("/steps/:stepId/site-review/resolve", async (req) => {
    const { stepId } = req.params as { stepId: string };
    const b = req.body as Body;
    Sign.resolveSiteReview(db, stepId, b.userId);
    return { status: "ok" };
  });

  // ---------- 撤销触发器 ----------
  app.post("/calibrations/:calibrationId/revoke", async (req) => {
    const { calibrationId } = req.params as { calibrationId: string };
    const b = req.body as Body;
    return Triggers.revokeCalibration(db, calibrationId, b.reason, nowIso());
  });
  app.post("/design-changes", async (req) => {
    const b = req.body as Body;
    return Triggers.applyDesignChange(db, b.fromDesignVersionId, b.toDesignVersionId, nowIso());
  });
  app.get("/design-changes/:changeId", async (req) => {
    const { changeId } = req.params as { changeId: string };
    return Triggers.getDesignChangeView(db, changeId);
  });
  app.post("/risk-assessments/:riskId/resolve", async (req) => {
    const { riskId } = req.params as { riskId: string };
    const b = req.body as Body;
    Triggers.resolveRiskAssessment(db, riskId, b.userId, nowIso());
    return { status: "ok" };
  });

  // ---------- 看板 ----------
  app.get("/board", async (req) => {
    const query = req.query as { zoneId?: string };
    return { generatedAt: nowIso(), rows: Board.buildBoard(db, nowMs(), query.zoneId ? { zoneId: query.zoneId } : undefined) };
  });
  app.get("/steps/:stepId", async (req) => {
    const { stepId } = req.params as { stepId: string };
    return Board.stepDetail(db, stepId, nowMs());
  });
}

/** 领域错误映射为 HTTP 状态码 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, _request, reply) => {
    const err = error as { statusCode?: number; code?: unknown; message?: string };
    if (error instanceof DomainError) {
      reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (typeof err.statusCode === "number" && typeof err.code === "string") {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    reply.code(500).send({ error: "INTERNAL", message: err.message });
  });
}
