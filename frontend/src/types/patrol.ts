/** 巡检：按计划日期生成的巡检任务 */
export type PatrolState = '待巡检' | '已完成' | '漏检'

export interface Patrol {
  id: string
  stationId: string
  /** 计划日期 YYYY-MM-DD */
  planDate: string
  /** 实际日期，未执行时为空串 */
  patrolDate: string
  patrolman: string
  envNote: string
  state: PatrolState
  createdAt: number
  updatedAt: number
}

export const PATROL_STATES: PatrolState[] = ['待巡检', '已完成', '漏检']

/** 巡检状态机：待巡检 → 已完成；漏检 → 已完成（补检） */
export const PATROL_STATE_FLOW: Record<PatrolState, PatrolState | null> = {
  待巡检: '已完成',
  已完成: null,
  漏检: '已完成'
}

export interface PatrolDraft {
  stationId: string
  planDate: string
  patrolDate: string
  patrolman: string
  envNote: string
  state: PatrolState
}

export const EMPTY_PATROL_DRAFT: PatrolDraft = {
  stationId: '',
  planDate: '',
  patrolDate: '',
  patrolman: '',
  envNote: '',
  state: '待巡检'
}

/** 漏检条目：超期天数由计划日期与当前日期推导 */
export interface PatrolGap {
  patrol: Patrol
  /** 超期天数（计划日期距今天数） */
  overdueDays: number
  /** 是否已超期未检 */
  overdue: boolean
  /** 提示文案 */
  text: string
}

export function patrolLabel(patrol: Patrol, stationName: string): string {
  return `${stationName} · 计划 ${patrol.planDate}`
}
