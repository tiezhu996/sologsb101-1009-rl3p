/** 泄漏处置：由异常读数派发的处置单，复检合格后闭环 */
export type LeakState = '待处置' | '已处置' | '已复检'

export interface Leak {
  id: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /** 泄漏浓度（ppm） */
  concentrationPpm: number
  /** 发现时间 YYYY-MM-DD */
  foundTime: string
  measure: string
  state: LeakState
  /** 复检浓度（ppm） */
  retestValuePpm: number
  handler: string
  createdAt: number
  updatedAt: number
}

export const LEAK_STATES: LeakState[] = ['待处置', '已处置', '已复检']

/** 泄漏处置状态机：待处置 → 已处置 → 已复检 */
export const LEAK_STATE_FLOW: Record<LeakState, LeakState | null> = {
  待处置: '已处置',
  已处置: '已复检',
  已复检: null
}

/** 复检合格阈值（ppm） */
export const LEAK_RETEST_PASS_PPM = 50

export interface LeakDraft {
  deviceId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: LeakState
  retestValuePpm: number
  handler: string
}

export const EMPTY_LEAK_DRAFT: LeakDraft = {
  deviceId: '',
  concentrationPpm: 0,
  foundTime: '',
  measure: '',
  state: '待处置',
  retestValuePpm: 0,
  handler: ''
}

export function createEmptyLeakDraft(): LeakDraft {
  return { ...EMPTY_LEAK_DRAFT }
}

export function retestPassed(value: number): boolean {
  return value > 0 && value <= LEAK_RETEST_PASS_PPM
}
