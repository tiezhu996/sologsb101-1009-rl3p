import type { StandardSnapshot } from '@/types/point'

/** 读数：某次巡检中某个点位的实测读数 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0；按 standardSnapshot 冻结的当时标准计算 */
  deviationPct: number
  note: string
  /**
   * 判定依据快照：读数保存（提交）时的点位标准。
   * 已完成巡检的历史读数永远按此快照判定，后续标准升级不回改。
   */
  standardSnapshot: StandardSnapshot | null
  createdAt: number
  updatedAt: number
}

export interface ReadingDraft {
  patrolId: string
  pointId: string
  value: number
  note: string
}

export const EMPTY_READING_DRAFT: ReadingDraft = {
  patrolId: '',
  pointId: '',
  value: 0,
  note: ''
}

/**
 * 巡检读数的本地草稿条目（localStorage 持久化，重开可继续录入）。
 * 标准升级时：needsReview 置 true，保留 value 原值、旧判定与差异，待人工复核。
 */
export interface ReadingDraftEntry {
  patrolId: string
  pointId: string
  value: number
  note?: string
  /** 录入草稿时所依据的标准版本号 */
  basisVersion: number
  /** 草稿产生时（旧标准）的偏差率，用于展示新旧差异；null 表示尚未计算 */
  oldDeviationPct: number | null
  /** 草稿产生时（旧标准）是否异常 */
  oldIsAbnormal: boolean | null
  /** 标准升级后是否待复核 */
  needsReview: boolean
  /** 待复核时的最新标准版本号（与 basisVersion 不一致即触发过升级） */
  latestVersion: number
  updatedAt: number
  /** 最近一次成功提交时的读数（用于“保留原值”比对） */
  committedValue?: number
}

/** 读数草稿表：`${patrolId}:${pointId}` → 输入值（兼容旧引用） */
export type ReadingDraftMap = Record<string, number>

export function readingDraftKey(patrolId: string, pointId: string): string {
  return `${patrolId}:${pointId}`
}
