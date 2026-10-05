/**
 * 点位标准值版本服务
 * - 每次标准更新：追加一条不可变版本行，点位行的 currentVersion 指针前移，revision 递增
 * - 新标准只管「尚未提交（巡检未完成）」的巡检：其已保存读数保留原值与差异、标待复核
 * - 已完成巡检的读数与泄漏处置单维持原快照，永不被新标准改判
 */
import {
  createId,
  db,
  nextRevision,
  type PointRow,
  type StandardVersionRow
} from '@/utils/db'
import type { Point } from '@/types/point'
import type { StandardSnapshot } from '@/types/standard'

export interface StandardChange {
  pointId: string
  standardMin: number
  standardMax: number
  isCritical: boolean
}

export interface PublishStandardResult {
  point: PointRow
  version: StandardVersionRow
  /** 被标为待复核的（未完成巡检中的）读数条数 */
  pendingReadings: number
}

/** 读取点位的全部标准版本，按版本号倒序 */
export async function listStandardVersions(pointId: string): Promise<StandardVersionRow[]> {
  const rows = await db.standardVersions.where('pointId').equals(pointId).toArray()
  return rows.sort((a, b) => b.versionNo - a.versionNo)
}

/** 取点位当前标准快照 */
export function currentStandardOf(point: Point): StandardSnapshot {
  return {
    standardMin: point.standardMin,
    standardMax: point.standardMax,
    standardUnit: point.unit,
    isCritical: point.isCritical
  }
}

/** 归一化一次标准变更（上下限排序） */
export function normalizeChange(
  _point: Point,
  change: Pick<StandardChange, 'standardMin' | 'standardMax' | 'isCritical'>
): { standardMin: number; standardMax: number; isCritical: boolean } {
  const min = Math.min(change.standardMin, change.standardMax)
  const max = Math.max(change.standardMin, change.standardMax)
  return {
    standardMin: min,
    standardMax: max > min ? max : min + 0.001,
    isCritical: change.isCritical
  }
}

/** 标准是否实际发生变化 */
export function isStandardChanged(
  point: Point,
  change: Pick<StandardChange, 'standardMin' | 'standardMax' | 'isCritical'>
): boolean {
  return (
    point.standardMin !== change.standardMin ||
    point.standardMax !== change.standardMax ||
    point.isCritical !== change.isCritical
  )
}

/**
 * 发布单个点位的新标准（事务内完成）：
 * 1. 追加不可变版本行（versionNo 递增）
 * 2. 更新点位当前标准与版本指针
 * 3. 未完成巡检的已保存读数 → 待复核（不改 isAbnormal / deviationPct / 快照，原值与差异保留）
 * 4. 已完成巡检读数与全部泄漏处置单：不动
 *
 * 无实际变化时返回 null。
 */
export async function publishStandardVersion(change: StandardChange, reason: string): Promise<PublishStandardResult | null> {
  return db.transaction('rw', [db.points, db.standardVersions, db.readings, db.patrols], async () => {
    const point = await db.points.get(change.pointId)
    if (!point) return null
    const normalized = normalizeChange(point, change)
    if (
      point.standardMin === normalized.standardMin &&
      point.standardMax === normalized.standardMax &&
      point.isCritical === normalized.isCritical
    ) {
      return null
    }

    const now = Date.now()
    const versionNo = point.currentVersionNo + 1
    const version: StandardVersionRow = {
      id: createId('sv'),
      pointId: point.id,
      versionNo,
      standardMin: normalized.standardMin,
      standardMax: normalized.standardMax,
      standardUnit: point.unit,
      isCritical: normalized.isCritical,
      reason: reason.trim() || '标准值更新',
      createdAt: now
    }
    await db.standardVersions.put(version)

    const updatedPoint: PointRow = {
      ...point,
      standardMin: normalized.standardMin,
      standardMax: normalized.standardMax,
      isCritical: normalized.isCritical,
      currentVersionId: version.id,
      currentVersionNo: versionNo,
      updatedAt: now,
      revision: nextRevision(point.revision)
    }
    await db.points.put(updatedPoint)

    // 未完成巡检（待巡检 / 漏检）中的该点位读数 → 待复核，原值与差异保留
    const pendingPatrolIds = new Set(
      (await db.patrols.where('state').noneOf(['已完成']).toArray()).map((patrol) => patrol.id)
    )
    let pendingReadings = 0
    if (pendingPatrolIds.size > 0) {
      await db.readings
        .where('pointId')
        .equals(point.id)
        .each((reading) => {
          if (!pendingPatrolIds.has(reading.patrolId)) return
          // 已待复核（跨越多个版本）的读数维持其最早保留的原值与差异
          if (reading.reviewState === '待复核') {
            pendingReadings += 1
            return
          }
          void db.readings.update(reading.id, { reviewState: '待复核', updatedAt: now })
          pendingReadings += 1
        })
    }

    return { point: updatedPoint, version, pendingReadings }
  })
}

/** 批量发布标准更新（每个点位独立事务，部分失败不影响其余点位） */
export async function publishStandardVersions(
  changes: StandardChange[],
  reason: string
): Promise<PublishStandardResult[]> {
  const published: PublishStandardResult[] = []
  for (const change of changes) {
    const result = await publishStandardVersion(change, reason)
    if (result) published.push(result)
  }
  return published
}
