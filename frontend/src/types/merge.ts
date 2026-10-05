/**
 * 并发冲突与本地找回：
 * - 两个标签页并发提交同一巡检 / 处置单时，先写入的生效（乐观锁 revision CAS）；
 * - 后写入的完整载荷留作「待合并」，重开后仍可继续处理；
 * - 写入失败（非冲突，如 IndexedDB 不可用）时，从本地草稿（localStorage）找回。
 */
import type { LeakDraft } from '@/types/leak'
import type { PatrolDraft } from '@/types/patrol'

export type MergeEntityType = 'patrol' | 'leak'
export type MergeSource = 'conflict' | 'recovery'
export type MergeStatus = '待处理' | '已处理' | '已放弃'

/** 巡检完成提交时的完整载荷（读数整批 + 巡检回写） */
export interface PatrolCompletePayload {
  patrol: PatrolDraft
  /** 逐点读数：pointId → 数值 */
  readings: Array<{ pointId: string; value: number }>
}

/** 泄漏处置提交的完整载荷（状态推进 / 复检 / 编辑统一收敛为整单更新） */
export interface LeakSubmitPayload {
  /** 新建时为空；冲突合并时必有值 */
  leakId: string
  deviceId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: LeakDraft['state']
  retestValuePpm: number
  handler: string
}

export type MergePayload = PatrolCompletePayload | LeakSubmitPayload

/** 待合并队列行（mergeQueue 表，IndexedDB 持久化，重开后仍在） */
export interface MergeQueueItem {
  id: string
  entityType: MergeEntityType
  /** 冲突指向的业务主键：巡检 id 或处置单 id；新建冲突为空串 */
  entityId: string
  title: string
  source: MergeSource
  status: MergeStatus
  /** 提交方当时持有的 revision，用于展示「你基于第几版编辑」 */
  baseRevision: number
  /** 后写入一方的完整载荷 */
  payload: MergePayload
  /** 先写入一方提交后的最新 revision */
  currentRevision: number
  createdAt: number
  updatedAt: number
}

/** 本地写入失败时留存的草稿（localStorage，按提交动作粒度） */
export interface RecoveryDraft {
  id: string
  entityType: MergeEntityType
  entityId: string
  title: string
  baseRevision: number
  payload: MergePayload
  createdAt: number
}

export function isPatrolPayload(payload: MergePayload): payload is PatrolCompletePayload {
  return Array.isArray((payload as PatrolCompletePayload).readings)
}
