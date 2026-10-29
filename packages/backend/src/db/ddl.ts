/**
 * 建表 DDL。
 *
 * 与 `schema.ts` 里的 Drizzle 定义是两份表述，因此有一条单测
 * （`tests/unit/db-schema.test.ts`）用 PRAGMA 反查实际列，逐一比对两边是否一致。
 * 这样既不用引入 drizzle-kit 的生成步骤，也不会让两份定义悄悄漂移。
 */
export const DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workspace (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    sources                 TEXT NOT NULL,
    skills                  TEXT NOT NULL,
    default_permission_mode TEXT NOT NULL,
    rule_version            TEXT NOT NULL,
    currency                TEXT NOT NULL,
    timezone                TEXT NOT NULL,
    created_at              TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS session (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL,
    created_by     TEXT,
    state          TEXT NOT NULL,
    step           INTEGER NOT NULL DEFAULT 0,
    state_version  INTEGER NOT NULL DEFAULT 0,
    skill_version  TEXT NOT NULL,
    input_version  TEXT NOT NULL,
    trace_id       TEXT NOT NULL,
    skill_name     TEXT NOT NULL,
    request        TEXT NOT NULL,
    input          TEXT NOT NULL,
    error_code     TEXT,
    error_message  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS source (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug         TEXT NOT NULL,
    type         TEXT NOT NULL,
    config_ref   TEXT NOT NULL,
    guide_ref    TEXT NOT NULL,
    auth_type    TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    version      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS skill (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL,
    required_sources TEXT NOT NULL,
    version          TEXT NOT NULL,
    stop_rules       TEXT NOT NULL,
    body             TEXT NOT NULL,
    created_at       TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tool_call (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    step         INTEGER NOT NULL DEFAULT 0,
    tool_name    TEXT NOT NULL,
    source_slug  TEXT NOT NULL,
    params_hash  TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    status       TEXT NOT NULL,
    args         TEXT NOT NULL,
    result_ref   TEXT,
    deny_code    TEXT,
    deny_reason  TEXT,
    created_at   TEXT NOT NULL,
    finished_at  TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS approval (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    tool_call_id    TEXT NOT NULL,
    approver        TEXT,
    tool_name       TEXT NOT NULL,
    tool_version    TEXT NOT NULL,
    params_hash     TEXT NOT NULL,
    kind            TEXT NOT NULL,
    draft_version   TEXT,
    recipients_hash TEXT,
    status          TEXT NOT NULL,
    reason          TEXT,
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    decided_at      TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS checkpoint (
    session_id    TEXT NOT NULL,
    step          INTEGER NOT NULL,
    state_version INTEGER NOT NULL,
    input_version TEXT NOT NULL,
    output_ref    TEXT,
    approval_ref  TEXT,
    state         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (session_id, step)
  )`,

  `CREATE TABLE IF NOT EXISTS event (
    event_id   TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    trace_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload    TEXT NOT NULL,
    timestamp  TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS report (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    draft_version   TEXT NOT NULL,
    status          TEXT NOT NULL,
    rule_version    TEXT NOT NULL,
    metrics         TEXT NOT NULL,
    conflicts       TEXT NOT NULL,
    result_refs     TEXT NOT NULL,
    data_versions   TEXT NOT NULL,
    recipients_hash TEXT,
    receipt_id      TEXT,
    artifact_path   TEXT,
    meta            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,

  // 身份：账号与登录会话分开。
  //
  // 登录令牌只存 sha256，和 Source 凭据同一条规矩——库被读走也拿不到能用的令牌。
  `CREATE TABLE IF NOT EXISTS user (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    approver_roles TEXT NOT NULL DEFAULT '[]',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS auth_session (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT
  )`,

  // 登录审计。只追加，不修改——审计日志一旦可以被改写就不再是审计。
  `CREATE TABLE IF NOT EXISTS auth_audit (
    id         TEXT PRIMARY KEY,
    event      TEXT NOT NULL,
    user_id    TEXT,
    username   TEXT NOT NULL,
    at         TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    reason     TEXT
  )`,

  // 用户与 Workspace 的授权关系。
  //
  // 这是可见性的**唯一依据**：能不能看到某个任务，取决于它属于哪个 Workspace，
  // 而不是它由谁发起——审批人必须能打开别人发起的任务。
  `CREATE TABLE IF NOT EXISTS workspace_member (
    user_id      TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (user_id, workspace_id)
  )`,

  // 查询索引：事件按 session 顺序读、工具调用按 session 找、checkpoint 按 session 取最新。
  `CREATE INDEX IF NOT EXISTS idx_event_session_seq ON event (session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_call_session ON tool_call (session_id, step)`,
  `CREATE INDEX IF NOT EXISTS idx_approval_session ON approval (session_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoint_session_step ON checkpoint (session_id, step)`,
  `CREATE INDEX IF NOT EXISTS idx_source_workspace ON source (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_report_session ON report (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_session_user ON auth_session (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_member_user ON workspace_member (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_audit_at ON auth_audit (at)`,
]
