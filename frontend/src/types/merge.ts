/**
 * 待合并队列：两个标签页并发提交同一巡检 / 处置单时，
 * 先写入者生效，后写入者的完整载荷进入本队列，重开后仍可继续处理。
 */
import type { LeakDraft, LeakState } from '@/types/leak'

/** 批量保存读数时的单条读数载荷（含判定快照，保证语义完整） */
export interface ReadingCommitItem {
  pointId: string
  value: number
  note: string
  /** 提交时所依据的标准版本号 */
  standardVersion: number
}

export type MergeEntityType = 'patrol-readings' | 'patrol-complete' | 'leak'

export interface PatrolReadingsMergePayload {
  kind: 'patrol-readings'
  patrolId: string
  readings: ReadingCommitItem[]
}

export interface PatrolCompleteMergePayload {
  kind: 'patrol-complete'
  patrolId: string
  patrolDate: string
  patrolman: string
  envNote: string
  /** 完成同时批量保存的读数（可空） */
  readings: ReadingCommitItem[]
}

export interface LeakMergePayload {
  kind: 'leak'
  leakId: string
  patch: Partial<LeakDraft>
  /** 状态推进动作（与 patch.state 配套） */
  advanceTo: LeakState | null
}

export type MergePayload = PatrolReadingsMergePayload | PatrolCompleteMergePayload | LeakMergePayload

/** pendingMerges 表行 */
export interface PendingMerge {
  id: string
  type: MergeEntityType
  /** 目标实体 id（巡检 / 处置单） */
  targetId: string
  /** 失败方提交时所基于的行版本号 */
  baseRevision: number
  /** 先写入方提交后的最新版本号（记录冲突现场） */
  conflictRevision: number
  /** 失败方标签页标识 */
  origin: string
  reason: string
  payload: MergePayload
  createdAt: number
  /** 最近一次处理时间 */
  updatedAt: number
  /** 处置状态：待处理 / 已合并 / 已放弃 */
  status: '待合并' | '已合并' | '已放弃'
}

/**
 * 写入失败待恢复（outbox）：IndexedDB 写入抛错时先在 localStorage 兜底，
 * 网络/浏览器故障恢复后可原样重试，避免录入丢失。
 */
export interface FailedWrite {
  id: string
  type: MergeEntityType
  targetId: string
  origin: string
  error: string
  payload: MergePayload
  createdAt: number
  retriedAt: number | null
}

export function mergeEntityLabel(type: MergeEntityType): string {
  switch (type) {
    case 'patrol-readings':
      return '巡检读数'
    case 'patrol-complete':
      return '巡检完成'
    case 'leak':
      return '泄漏处置单'
  }
}
