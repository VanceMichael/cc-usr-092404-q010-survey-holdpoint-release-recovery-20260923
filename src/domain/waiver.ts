import type { Db } from "./model.js";
import { badRequest, forbidden, newId, notFound, transaction } from "./model.js";

export interface GrantWaiverInput {
  findingId: string;
  grantedByUserId: string;
  basis: string;
  expiresAt: string;
  grantedAt?: string;
}

export interface WaiverView {
  waiverId: string;
  findingId: string;
  code: string;
  subject: string;
  basis: string;
  expiresAt: string;
  active: boolean;
}

/** 人工豁免开放缺陷：必须填写依据与到期时刻，豁免不删除缺陷记录 */
export function grantWaiver(db: Db, input: GrantWaiverInput, atMs: number): WaiverView {
  return transaction(db, () => {
    if (!input.basis?.trim()) throw badRequest("WAIVER_BASIS_REQUIRED", "人工豁免必须填写依据");
    if (Number.isNaN(Date.parse(input.expiresAt)))
      throw badRequest("INVALID_TIME", "豁免到期时间无法解析");
    if (Date.parse(input.expiresAt) <= atMs)
      throw badRequest("WAIVER_EXPIRY_PAST", "豁免期限必须晚于当前时刻");

    const finding = db.prepare("SELECT * FROM findings WHERE id = ?").get(input.findingId) as
      | Record<string, any>
      | undefined;
    if (!finding) throw notFound("FINDING_NOT_FOUND", `缺陷 ${input.findingId} 不存在`);
    if (finding.state !== "OPEN")
      throw badRequest("FINDING_CLOSED", "缺陷已关闭，不能再豁免；整改须以新证据包关闭偏差");

    const granter = db.prepare("SELECT * FROM users WHERE id = ?").get(input.grantedByUserId) as
      | Record<string, any>
      | undefined;
    if (!granter) throw notFound("USER_NOT_FOUND", `签署人 ${input.grantedByUserId} 不存在`);
    if (granter.role !== "SUPERVISOR")
      throw forbidden("WAIVER_SUPERVISOR_ONLY", "仅监理可以批准人工豁免");

    const waiverId = newId();
    db.prepare(
      `INSERT INTO waivers (id, finding_id, granted_by_user_id, basis, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(waiverId, input.findingId, input.grantedByUserId, input.basis, input.expiresAt);
    return {
      waiverId,
      findingId: finding.id,
      code: finding.code,
      subject: finding.subject,
      basis: input.basis,
      expiresAt: input.expiresAt,
      active: true,
    };
  });
}

/** 提前撤销豁免（保留记录），缺陷重新成为阻断 */
export function revokeWaiver(db: Db, waiverId: string, atIso: string): void {
  transaction(db, () => {
    const result = db
      .prepare("UPDATE waivers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(atIso, waiverId);
    if (result.changes === 0)
      throw notFound("WAIVER_NOT_ACTIVE", `豁免 ${waiverId} 不存在或已撤销/过期`);
  });
}
