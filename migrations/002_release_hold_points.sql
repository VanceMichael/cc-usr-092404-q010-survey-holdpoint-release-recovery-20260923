-- 施工停检点测量放行：方案、证据包、校核、签署、豁免、租约、撤销与风险评估

-- 人员（测量复核人、监理）与班组
CREATE TABLE crews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- SURVEY_REVIEWER=测量复核人, SUPERVISOR=监理
  role TEXT NOT NULL CHECK (role IN ('SURVEY_REVIEWER', 'SUPERVISOR')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 设计版本（换版产生新版本，不覆盖旧版本）
CREATE TABLE design_versions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  supersedes_id TEXT REFERENCES design_versions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 测量基线（构件对应关系随基线版本发布）
CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  design_version_id TEXT NOT NULL REFERENCES design_versions(id),
  label TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  superseded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (label, revision)
);

-- 仪器校准版本；撤销后旧记录保留，只标记 revoked
CREATE TABLE calibrations (
  id TEXT PRIMARY KEY,
  instrument_code TEXT NOT NULL,
  version_label TEXT NOT NULL,
  calibrated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (instrument_code, version_label)
);

-- 工作区（顶升分段）；overlaps 描述几何重叠，用于租约争用与相邻冲突
CREATE TABLE work_zones (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE work_zone_overlaps (
  zone_a_id TEXT NOT NULL REFERENCES work_zones(id),
  zone_b_id TEXT NOT NULL REFERENCES work_zones(id),
  CHECK (zone_a_id < zone_b_id),
  PRIMARY KEY (zone_a_id, zone_b_id)
);

-- 工序/停检点：登记前置工序、控制点集合、位移/沉降容差、观测时效
CREATE TABLE work_steps (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES work_zones(id),
  crew_id TEXT NOT NULL REFERENCES crews(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  design_version_id TEXT NOT NULL REFERENCES design_versions(id),
  -- 前置工序（同区内 JSON 数组，按顺序完成）
  prerequisite_step_ids TEXT NOT NULL DEFAULT '[]',
  -- 控制点集合 JSON: [{code, x, y, z}]
  control_points TEXT NOT NULL DEFAULT '[]',
  displacement_tolerance_mm REAL NOT NULL,
  settlement_tolerance_mm REAL NOT NULL,
  -- 观测时效：证据包观测时间距放行不得超过该秒数
  observation_validity_seconds INTEGER NOT NULL,
  -- 设计换版后施工中工序挂起的现场复核标记
  review_pending INTEGER NOT NULL DEFAULT 0,
  -- PENDING_RELEASE(待放行) RELEASED(已放行未开工) IN_PROGRESS(施工中)
  -- EXECUTED(已执行) AT_RISK(已执行转风险)；放行撤销回 PENDING_RELEASE，
  -- 撤销事实记录在 release_decisions.state = CANCELLED
  status TEXT NOT NULL DEFAULT 'PENDING_RELEASE'
    CHECK (status IN ('PENDING_RELEASE', 'RELEASED', 'IN_PROGRESS', 'EXECUTED', 'AT_RISK')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (zone_id, code)
);

CREATE INDEX idx_work_steps_status ON work_steps(status);

-- 证据包：承包方提交，永不覆盖；新包版本号递增
CREATE TABLE evidence_packages (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  package_version INTEGER NOT NULL,
  baseline_id TEXT NOT NULL REFERENCES baselines(id),
  calibration_id TEXT NOT NULL REFERENCES calibrations(id),
  design_version_id TEXT NOT NULL REFERENCES design_versions(id),
  submitted_by_crew_id TEXT NOT NULL REFERENCES crews(id),
  -- 若由持证人员个人账户代提交，记录该用户，签署时禁止其自批
  submitted_by_user_id TEXT REFERENCES users(id),
  submitted_at TEXT NOT NULL,
  -- 观测时间（批次实测时刻）；补录包标记 backfilled
  observed_at TEXT NOT NULL,
  backfilled INTEGER NOT NULL DEFAULT 0,
  backfill_reason TEXT,
  -- 原始观测摘要（提交时固定，不随基线/校准换版变化）
  observation_summary TEXT NOT NULL,
  superseded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (step_id, package_version)
);

-- 包内控制点观测摘要：摘要、序号、坐标完整才能参与仲裁
CREATE TABLE evidence_observations (
  package_id TEXT NOT NULL REFERENCES evidence_packages(id),
  point_code TEXT NOT NULL,
  sequence_no INTEGER,
  x REAL, y REAL, z REAL,
  displacement_mm REAL,
  settlement_mm REAL,
  PRIMARY KEY (package_id, point_code)
);

-- 批量校核批次（可从中断处恢复）
CREATE TABLE review_batches (
  id TEXT PRIMARY KEY,
  -- PENDING/RUNNING/COMPLETED/FAILED
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  cursor_index INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE review_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id),
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  item_index INTEGER NOT NULL,
  -- PENDING/DONE/FAILED
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DONE', 'FAILED')),
  checked_at TEXT,
  -- 校核时的阻断快照 JSON
  result_summary TEXT,
  UNIQUE (batch_id, item_index)
);

-- 校核结论：缺项 MISSING_FIELD、超差 OUT_OF_TOLERANCE、上游未放行 UPSTREAM_BLOCKED、
-- 相邻区域冲突 ADJACENT_CONFLICT、校准失效 CALIBRATION_REVOKED、观测过期 STALE_OBSERVATION、
-- 设计换版 DESIGN_CHANGED、自批 SELF_SUBMISSION（签署阶段）
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES evidence_packages(id),
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  code TEXT NOT NULL,
  -- 问题主体（如控制点编号）；整包级问题为空串
  subject TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL,
  -- OPEN / CLOSED（被后续新证据包或豁免关闭）
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLOSED')),
  closed_by_package_id TEXT REFERENCES evidence_packages(id),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_findings_step_state ON findings(step_id, state);

-- 人工豁免：带期限与依据
CREATE TABLE waivers (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  granted_by_user_id TEXT NOT NULL REFERENCES users(id),
  basis TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 放行决定：测量复核人先签、监理后签；任一字段缺失即未放行
CREATE TABLE release_decisions (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  package_id TEXT NOT NULL REFERENCES evidence_packages(id),
  survey_reviewer_id TEXT REFERENCES users(id),
  supervisor_id TEXT REFERENCES users(id),
  survey_signed_at TEXT,
  supervisor_signed_at TEXT,
  -- 签署时看到的包/设计版本，用于并发签署时的版本变化检测
  survey_seen_design_version_id TEXT,
  supervisor_seen_design_version_id TEXT,
  -- RELEASED/CANCELLED
  state TEXT NOT NULL DEFAULT 'RELEASED' CHECK (state IN ('RELEASED', 'CANCELLED')),
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (step_id, package_id)
);

-- 施工租约：重叠工作区同一时刻只能一个获准
CREATE TABLE construction_leases (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES work_zones(id),
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  granted_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_leases_active ON construction_leases(zone_id, released_at);

-- 已执行工序遭遇补录/校准撤销/设计换版：保存原决定并转入风险评估
CREATE TABLE risk_assessments (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  original_decision_id TEXT NOT NULL REFERENCES release_decisions(id),
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('OBSERVATION_BACKFILL', 'CALIBRATION_REVOKE', 'DESIGN_CHANGE')),
  detail TEXT NOT NULL,
  -- OPEN / RESOLVED
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

-- 一次设计换版的影响清单：按待放行/施工中/已执行分别给出处置
CREATE TABLE design_change_impacts (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  from_design_version_id TEXT NOT NULL REFERENCES design_versions(id),
  to_design_version_id TEXT NOT NULL REFERENCES design_versions(id),
  step_id TEXT NOT NULL REFERENCES work_steps(id),
  crew_id TEXT NOT NULL REFERENCES crews(id),
  disposition TEXT NOT NULL
    CHECK (disposition IN ('REVOKE_PENDING', 'IN_PROGRESS_REVIEW', 'EXECUTED_TO_RISK'))
);

CREATE INDEX idx_change_impacts_change ON design_change_impacts(change_id);

-- 领域事件（补录、校准撤销、换版、撤销、风险流转等），支撑看板重建
CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  step_id TEXT REFERENCES work_steps(id),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
