import type { Db, Row } from "./model.js";
import { newId, parseControlPoints, parseJsonArray, transaction } from "./model.js";
import {
  activeLeaseConflict,
  getStep,
  latestPackage,
  openFindings,
  openWaiver,
  overlappingZones,
  zoneLabel,
} from "./repo.js";
import type { StepRow } from "./repo.js";

/** 需要随每次校核与实际状态对账的缺陷码 */
const RECONCILED_CODES = new Set([
  "MISSING_FIELD",
  "OUT_OF_TOLERANCE",
  "STALE_OBSERVATION",
  "CALIBRATION_REVOKED",
  "DESIGN_CHANGED",
  "UPSTREAM_BLOCKED",
  "ADJACENT_CONFLICT",
]);

export interface BlockageItem {
  code: string;
  subject: string;
  detail: string;
  findingId?: string;
  waived?: { waiverId: string; basis: string; expiresAt: string };
}

export interface UpstreamBlock {
  stepId: string;
  stepCode: string;
  reasons: string[];
}

export interface BlockageResult {
  stepId: string;
  stepCode: string;
  status: string;
  packageId: string | null;
  /** 可放行：有证据包且无未豁免阻断 */
  releasable: boolean;
  blockers: BlockageItem[];
  waived: BlockageItem[];
  upstream: UpstreamBlock[];
}

interface RawIssue {
  code: string;
  subject: string;
  detail: string;
}

function stepCode(db: Db, stepId: string): string {
  const row = db.prepare("SELECT code FROM work_steps WHERE id = ?").get(stepId) as
    | { code: string }
    | undefined;
  return row?.code ?? stepId;
}

/** 对单个证据包执行校核，并把缺项/超差/状态类缺陷与库中开放缺陷对账 */
export function checkStep(db: Db, stepId: string, atMs: number): BlockageResult {
  return transaction(db, () => {
    const step = getStep(db, stepId);
    const pkg = latestPackage(db, stepId);
    if (pkg) {
      const issues = computePackageIssues(db, step, pkg, atMs, new Set());
      reconcileFindings(db, stepId, pkg.id, issues, atMs);
    }
    return computeBlockage(db, stepId, atMs, new Set());
  });
}

/**
 * 纯读：沿工序依赖递归汇总阻断。看板与签署前置校验共用。
 * cycleGuard 防止前置关系成环时无限递归。
 */
export function computeBlockage(
  db: Db,
  stepId: string,
  atMs: number,
  cycleGuard: Set<string>,
): BlockageResult {
  const step = getStep(db, stepId);
  const pkg = latestPackage(db, stepId);
  const blockers: BlockageItem[] = [];
  const waived: BlockageItem[] = [];
  const upstream: UpstreamBlock[] = [];

  if (!pkg) {
    blockers.push({
      code: "PACKAGE_MISSING",
      subject: "",
      detail: "承包方尚未提交证据包，无原始观测摘要、基线与校准版本可核",
    });
  } else {
    const issues = computePackageIssues(db, step, pkg, atMs, cycleGuard);
    for (const issue of issues) {
      const finding = findPersistedFinding(db, stepId, pkg.id, issue.code, issue.subject);
      const item: BlockageItem = {
        code: issue.code,
        subject: issue.subject,
        detail: issue.detail,
        findingId: finding?.id,
      };
      if (finding) {
        const waiver = openWaiver(db, finding.id, atMs);
        if (waiver) {
          item.waived = {
            waiverId: waiver.id,
            basis: waiver.basis,
            expiresAt: waiver.expires_at,
          };
          waived.push(item);
          continue;
        }
      }
      blockers.push(item);
    }
  }

  // 沿工序依赖传播：上游未放行或被阻断，本工序记 UPSTREAM_BLOCKED
  for (const prereqId of parseJsonArray(step.prerequisite_step_ids)) {
    if (cycleGuard.has(prereqId)) continue;
    const prereq = db.prepare("SELECT * FROM work_steps WHERE id = ?").get(prereqId) as
      | StepRow
      | undefined;
    if (!prereq) continue;
    const reasons = upstreamBlockReasons(db, prereq, atMs, new Set(cycleGuard).add(stepId));
    if (reasons.length > 0)
      upstream.push({ stepId: prereqId, stepCode: prereq.code, reasons });
  }
  for (const block of upstream) {
    blockers.push({
      code: "UPSTREAM_BLOCKED",
      subject: block.stepCode,
      detail: `前置工序 ${block.stepCode} 未完成放行：${block.reasons.join("、")}`,
    });
  }

  const releasable =
    Boolean(pkg) &&
    blockers.length === 0 &&
    step.status === "PENDING_RELEASE" &&
    !step.review_pending;

  return {
    stepId,
    stepCode: step.code,
    status: step.status,
    packageId: pkg?.id ?? null,
    releasable,
    blockers,
    waived,
    upstream,
  };
}

/** 上游工序阻断原因（供依赖传播） */
function upstreamBlockReasons(
  db: Db,
  prereq: StepRow,
  atMs: number,
  guard: Set<string>,
): string[] {
  if (prereq.status === "IN_PROGRESS" || prereq.status === "EXECUTED") return [];
  if (prereq.status === "AT_RISK") return ["已执行工序处于风险评估中"];
  if (prereq.status === "RELEASED") return [];
  const result = computeBlockage(db, prereq.id, atMs, guard);
  return result.blockers.map((b) => describeCode(b));
}

function describeCode(b: BlockageItem): string {
  switch (b.code) {
    case "MISSING_FIELD":
      return `控制点 ${b.subject} 观测缺项`;
    case "OUT_OF_TOLERANCE":
      return `控制点 ${b.subject} 测量超差（${b.detail}）`;
    case "STALE_OBSERVATION":
      return "观测超过时效";
    case "CALIBRATION_REVOKED":
      return "仪器校准已撤销";
    case "DESIGN_CHANGED":
      return "设计已换版，证据包失效";
    case "ADJACENT_CONFLICT":
      return b.detail;
    case "PACKAGE_MISSING":
      return "尚未提交证据包";
    case "UPSTREAM_BLOCKED":
      return b.detail;
    default:
      return b.code;
  }
}

/** 计算证据包自身的问题（缺项/超差/时效/校准/换版/相邻冲突），不写库 */
function computePackageIssues(
  db: Db,
  step: StepRow,
  pkg: Row,
  atMs: number,
  _guard: Set<string>,
): RawIssue[] {
  const issues: RawIssue[] = [];
  const planned = parseControlPoints(step.control_points);
  const observations = db
    .prepare("SELECT * FROM evidence_observations WHERE package_id = ?")
    .all(pkg.id) as Row[];
  const obsByCode = new Map(observations.map((o) => [o.point_code, o]));

  for (const point of planned) {
    const obs = obsByCode.get(point.code);
    if (!obs) {
      issues.push({
        code: "MISSING_FIELD",
        subject: point.code,
        detail: "证据包缺少该控制点的观测记录",
      });
      continue;
    }
    // 摘要、序号和坐标信息完整后才能参与仲裁
    if (obs.sequence_no == null || obs.x == null || obs.y == null || obs.z == null) {
      issues.push({
        code: "MISSING_FIELD",
        subject: point.code,
        detail: "观测序号或坐标不完整，不能参与仲裁",
      });
      continue;
    }
    if (obs.displacement_mm != null && obs.displacement_mm > step.displacement_tolerance_mm) {
      issues.push({
        code: "OUT_OF_TOLERANCE",
        subject: point.code,
        detail: `位移 ${obs.displacement_mm.toFixed(2)}mm 超过容差 ${step.displacement_tolerance_mm}mm`,
      });
    }
    if (obs.settlement_mm != null && Math.abs(obs.settlement_mm) > step.settlement_tolerance_mm) {
      issues.push({
        code: "OUT_OF_TOLERANCE",
        subject: point.code,
        detail: `沉降 ${Math.abs(obs.settlement_mm).toFixed(2)}mm 超过容差 ${step.settlement_tolerance_mm}mm`,
      });
    }
  }

  const ageSeconds = (atMs - Date.parse(pkg.observed_at)) / 1000;
  if (ageSeconds > step.observation_validity_seconds) {
    issues.push({
      code: "STALE_OBSERVATION",
      subject: "",
      detail: `观测已超过 ${step.observation_validity_seconds}s 时效（实际 ${Math.floor(ageSeconds)}s）`,
    });
  }

  const calibration = db.prepare("SELECT * FROM calibrations WHERE id = ?").get(pkg.calibration_id) as
    | Row
    | undefined;
  if (calibration?.revoked_at) {
    issues.push({
      code: "CALIBRATION_REVOKED",
      subject: calibration.instrument_code,
      detail: `仪器 ${calibration.instrument_code} 校准版本 ${calibration.version_label} 已于 ${calibration.revoked_at} 撤销`,
    });
  }

  if (pkg.design_version_id !== step.design_version_id) {
    issues.push({
      code: "DESIGN_CHANGED",
      subject: "",
      detail: "证据包依据旧设计版本，设计已换版，须按新版本重新出证",
    });
  }

  // 相邻区域冲突：重叠工作区有其他在持租约
  const conflictLease = activeLeaseConflict(db, overlappingZones(db, step.zone_id), step.id);
  if (conflictLease) {
    const holder = db.prepare("SELECT code FROM work_steps WHERE id = ?").get(conflictLease.step_id) as
      | { code: string }
      | undefined;
    issues.push({
      code: "ADJACENT_CONFLICT",
      subject: holder?.code ?? conflictLease.step_id,
      detail: `相邻/重叠工作区 ${zoneLabel(db, conflictLease.zone_id)} 正由工序 ${holder?.code ?? conflictLease.step_id} 占用施工`,
    });
  }

  return issues;
}

function findPersistedFinding(
  db: Db,
  stepId: string,
  packageId: string,
  code: string,
  subject: string,
): Row | undefined {
  return db
    .prepare(
      `SELECT * FROM findings
       WHERE step_id = ? AND package_id = ? AND code = ? AND subject = ? AND state = 'OPEN'`,
    )
    .get(stepId, packageId, code, subject) as Row | undefined;
}

/**
 * 缺陷对账：
 * - 旧证据包的开放缺陷随新包校核关闭（整改以新证据包关闭偏差）；
 * - 当前包仍存在的问题落地为开放缺陷；
 * - 当前包已消失的问题（如租约释放、换版恢复）同步关闭。
 */
function reconcileFindings(
  db: Db,
  stepId: string,
  currentPackageId: string,
  issues: RawIssue[],
  atMs: number,
): void {
  const atIso = new Date(atMs).toISOString();
  const open = openFindings(db, stepId).filter((f) => RECONCILED_CODES.has(f.code));

  // 旧包缺陷：被新包整改关闭
  for (const finding of open.filter((f) => f.package_id !== currentPackageId)) {
    db.prepare(
      `UPDATE findings SET state = 'CLOSED', closed_by_package_id = ?, closed_at = ? WHERE id = ?`,
    ).run(currentPackageId, atIso, finding.id);
  }

  const currentOpen = open.filter((f) => f.package_id === currentPackageId);
  for (const issue of issues) {
    const exists = currentOpen.find((f) => f.code === issue.code && f.subject === issue.subject);
    if (!exists) {
      db.prepare(
        `INSERT INTO findings (id, package_id, step_id, code, subject, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId(), currentPackageId, stepId, issue.code, issue.subject, issue.detail);
    }
  }
  for (const finding of currentOpen) {
    const stillPresent = issues.some((i) => i.code === finding.code && i.subject === finding.subject);
    if (!stillPresent) {
      db.prepare(
        `UPDATE findings SET state = 'CLOSED', closed_by_package_id = ?, closed_at = ? WHERE id = ?`,
      ).run(currentPackageId, atIso, finding.id);
    }
  }
}
