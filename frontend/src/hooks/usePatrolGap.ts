/**
 * 对比计划日期与实际日期，派生漏检清单与超期天数
 * 被巡检计划页、巡检录入页消费。
 */
import { useMemo } from 'react'
import type { Patrol, PatrolGap } from '@/types/patrol'
import { daysBetween } from '@/utils/range'

export interface UsePatrolGapResult {
  /** 全部漏检条目（含未超期的待巡检任务） */
  gaps: PatrolGap[]
  /** 已超期未检的条目 */
  overdue: PatrolGap[]
  /** 按超期天数降序的提醒清单 */
  reminders: PatrolGap[]
  /** 超期站点数 */
  overdueCount: number
  /** 指定站点的超期天数 */
  overdueDaysOf: (stationId: string) => number
  /** 生成一条漏检条目（供列表行复用） */
  gapOf: (patrol: Patrol) => PatrolGap
}

function buildGap(patrol: Patrol, today: string): PatrolGap {
  if (patrol.state === '已完成') {
    const delay = patrol.patrolDate ? daysBetween(patrol.planDate, patrol.patrolDate) : 0
    return {
      patrol,
      overdueDays: 0,
      overdue: false,
      text: delay > 0 ? `已完成（延期 ${delay} 天）` : '已完成'
    }
  }
  const overdueDays = Math.max(0, daysBetween(patrol.planDate, today))
  if (patrol.state === '漏检') {
    return { patrol, overdueDays, overdue: true, text: `已标记漏检，超期 ${overdueDays} 天` }
  }
  return {
    patrol,
    overdueDays,
    overdue: overdueDays > 0,
    text: overdueDays > 0 ? `已超期 ${overdueDays} 天未巡检` : '待巡检（未超期）'
  }
}

/**
 * @param patrols 巡检任务列表（通常来自 patrolStore）
 * @param today 参照日期，默认今天
 */
export function usePatrolGap(patrols: Patrol[], today?: string): UsePatrolGapResult {
  const reference = today ?? new Date().toISOString().slice(0, 10)

  return useMemo(() => {
    const gaps = patrols.map((patrol) => buildGap(patrol, reference))
    const overdue = gaps.filter((gap) => gap.overdue)
    const reminders = [...overdue].sort((a, b) => b.overdueDays - a.overdueDays)
    return {
      gaps,
      overdue,
      reminders,
      overdueCount: overdue.length,
      overdueDaysOf: (stationId: string) => {
        const list = overdue.filter((gap) => gap.patrol.stationId === stationId)
        return list.reduce((max, gap) => Math.max(max, gap.overdueDays), 0)
      },
      gapOf: (patrol: Patrol) => buildGap(patrol, reference)
    }
  }, [patrols, reference])
}
