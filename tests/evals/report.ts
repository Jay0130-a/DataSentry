import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataPaths, newId, type DataPaths } from '@datasentry/core'
import { loadAllSources } from '@datasentry/backend/sources/loader.ts'
import { listSkills } from '@datasentry/backend/harness/skill-loader.ts'
import { listWorkspaces } from '@datasentry/backend/workspace/loader.ts'

export interface CaseReport {
  id: string
  title: string
  /** 这个样本对应 PRD FR-05.1 的哪一类路径。 */
  path: string
  /** 验证的是 PRD 的哪几条。 */
  covers: string[]
  status: 'PASS' | 'FAIL'
  durationMs: number
  firstAnomaly: string | null
  failures: string[]
  actualState: string
  eventCount: number
}

/**
 * 回归报告的环境指纹。
 *
 * 「版本化」的意义在于：结果变了的时候，能立刻看出是**哪一样**变了——
 * Skill 改了？指标规则改了？某个 Source 的 guide 改了（工具版本随之变化）？
 * 没有这层指纹，回归报告只能告诉你「红了」，不能告诉你「为什么红」。
 */
export interface EnvironmentFingerprint {
  node: string
  platform: string
  /** Skill 名 → 内容摘要。 */
  skills: Record<string, string>
  /** Source slug → config + guide 摘要。 */
  sources: Record<string, string>
  /** Workspace → 指标规则版本。 */
  ruleVersions: Record<string, string>
}

export interface RegressionReport {
  runId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  environment: EnvironmentFingerprint
  summary: { total: number; passed: number; failed: number }
  cases: CaseReport[]
  /** 与上一次运行的对比。首次运行时为 null。 */
  baseline: {
    runId: string
    startedAt: string
    newlyFailing: string[]
    newlyPassing: string[]
    /** 上次有、这次没有的样本（被删掉或被 --case 过滤掉了）。 */
    missing: string[]
  } | null
}

export function reportDir(paths: DataPaths = dataPaths()): string {
  return join(paths.root, 'reports', 'regression')
}

export function latestReportPath(paths: DataPaths = dataPaths()): string {
  return join(reportDir(paths), 'latest.json')
}

/** 采集当前 Skill / Source / 规则版本。 */
export function fingerprint(paths: DataPaths = dataPaths()): EnvironmentFingerprint {
  const skills: Record<string, string> = {}
  for (const skill of listSkills(paths)) skills[skill.name] = skill.version

  const sources: Record<string, string> = {}
  for (const source of loadAllSources(paths)) sources[source.config.slug] = source.version

  const ruleVersions: Record<string, string> = {}
  for (const workspace of listWorkspaces(paths)) ruleVersions[workspace.id] = workspace.ruleVersion

  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    skills,
    sources,
    ruleVersions,
  }
}

export function readLatestReport(paths: DataPaths = dataPaths()): RegressionReport | null {
  const file = latestReportPath(paths)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RegressionReport
  } catch {
    return null
  }
}

/** 对比上一次运行，指出哪些样本由绿转红、由红转绿。 */
export function diffWithBaseline(
  current: readonly CaseReport[],
  baseline: RegressionReport | null,
): RegressionReport['baseline'] {
  if (!baseline) return null

  const previous = new Map(baseline.cases.map((c) => [c.id, c.status]))
  const currentIds = new Set(current.map((c) => c.id))

  const newlyFailing: string[] = []
  const newlyPassing: string[] = []

  for (const item of current) {
    const before = previous.get(item.id)
    if (before === undefined) continue
    if (before === 'PASS' && item.status === 'FAIL') newlyFailing.push(item.id)
    if (before === 'FAIL' && item.status === 'PASS') newlyPassing.push(item.id)
  }

  return {
    runId: baseline.runId,
    startedAt: baseline.startedAt,
    newlyFailing,
    newlyPassing,
    missing: baseline.cases.filter((c) => !currentIds.has(c.id)).map((c) => c.id),
  }
}

export function writeRegressionReport(
  report: RegressionReport,
  paths: DataPaths = dataPaths(),
  updateLatest = true,
): { runPath: string; latestPath: string } {
  const dir = reportDir(paths)
  mkdirSync(dir, { recursive: true })

  const runPath = join(dir, `${report.startedAt.replaceAll(':', '-')}-${report.runId}.json`)
  const latest = latestReportPath(paths)

  const payload = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(runPath, payload, 'utf8')
  // 过滤运行（--case）只覆盖单条样本，不能拿它当全量基线；
  // 否则下一次全量回归会把其它样本都报成 missing。
  if (updateLatest) writeFileSync(latest, payload, 'utf8')

  return { runPath, latestPath: latest }
}

export function newRunId(): string {
  return newId('run').replace(/^run_/, '').slice(0, 12)
}
