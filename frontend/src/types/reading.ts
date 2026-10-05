/** 读数：某次巡检中某个点位的实测读数 */
import type { StandardRefFields } from '@/types/standard'

/** 待复核状态：标准更新后、巡检尚未完成时，历史草稿读数进入待复核 */
export type ReadingReviewState = '无' | '待复核'

export interface Reading extends StandardRefFields {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 —— 始终按 standardVersionId 对应的当时标准计算 */
  deviationPct: number
  note: string
  /**
   * 待复核：新标准只管未提交的巡检；标准更新时，未完成巡检中的已保存读数
   * 保留原值与差异，标记待复核，由人工决定「按新标准重判」或「维持原判定」。
   */
  reviewState: ReadingReviewState
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

/** 读数草稿表：`${patrolId}:${pointId}` → 输入值 */
export type ReadingDraftMap = Record<string, number>

/** 读数草稿元信息：记录录入时所依据的标准版本 */
export interface ReadingDraftMeta extends StandardRefFields {
  /** 录入时巡检是否尚未提交（草稿）；标准更新后据此标待复核 */
  reviewState: ReadingReviewState
}

/** `patrolId:pointId` → 草稿元信息 */
export type ReadingDraftMetaMap = Record<string, ReadingDraftMeta>
