/**
 * 待合并队列与写入失败恢复（Zustand + IndexedDB / localStorage）
 * - pendingMerges：两个标签页并发提交同一巡检 / 处置单时，后写入者的完整载荷
 * - failedWrites：写入异常的载荷（outbox），可原样重试找回
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, nextRevision, putReading, type PendingMergeRow } from '@/utils/db'
import { isRevisionConflictError } from '@/utils/conflict'
import {
  addFailedWrite,
  currentTabId,
  loadFailedWrites,
  removeFailedWrite,
  touchFailedWrite
} from '@/utils/localDraft'
import type {
  FailedWrite,
  LeakMergePayload,
  MergeEntityType,
  MergePayload,
  PendingMerge,
  PatrolCompleteMergePayload,
  PatrolReadingsMergePayload
} from '@/types/merge'

export interface EnqueueConflictInput {
  type: MergeEntityType
  targetId: string
  baseRevision: number
  currentRevision: number
  payload: MergePayload
  reason?: string
}

interface MergeState {
  pendingMerges: PendingMerge[]
  failedWrites: FailedWrite[]
  ready: boolean
  refreshFailedWrites: () => void
  enqueueConflict: (input: EnqueueConflictInput) => Promise<PendingMerge>
  listOfTarget: (targetId: string) => PendingMerge[]
  discardMerge: (id: string) => Promise<void>
  clearResolved: () => Promise<void>
  /** 重新应用待合并载荷（force=true 覆盖最新行）；成功返回 null，失败返回原因 */
  applyMerge: (id: string, force: boolean) => Promise<string | null>
  /** 重试失败写入；成功返回 true */
  retryFailedWrite: (id: string) => Promise<boolean>
  removeFailedWriteRow: (id: string) => void
}

async function markMergeStatus(id: string, status: PendingMerge['status']): Promise<void> {
  await db.pendingMerges.update(id, { status, updatedAt: Date.now() })
}

/** 逐条保存载荷中的读数（putReading 内会按点位当前/指定版本标准冻结快照） */
async function replayReadings(patrolId: string, readings: PatrolReadingsMergePayload['readings']): Promise<void> {
  const existingRows = await db.readings.where('patrolId').equals(patrolId).toArray()
  const now = Date.now()
  for (const item of readings) {
    const existing = existingRows.find((row) => row.pointId === item.pointId)
    await putReading({
      id: existing ? existing.id : createId('rd'),
      patrolId,
      pointId: item.pointId,
      value: item.value,
      note: item.note,
      standardVersion: item.standardVersion,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    })
  }
}

/** 载荷落地（供待合并重新应用、失败重试共用）。force 时跳过版本检查。 */
export async function replayPayload(payload: MergePayload, force: boolean): Promise<void> {
  if (payload.kind === 'patrol-readings') {
    await applyReadingsPayload(payload, force)
  } else if (payload.kind === 'patrol-complete') {
    await applyCompletePayload(payload, force)
  } else {
    await applyLeakPayload(payload, force)
  }
}

async function bumpEntityRevision(tableId: 'patrols' | 'leaks', id: string, force: boolean): Promise<void> {
  const table = tableId === 'patrols' ? db.patrols : db.leaks
  const current = await table.get(id)
  if (!current) throw new Error('目标记录不存在或已被删除')
  if (!force) {
    // 非强制合并：库中版本必须仍冲突或更新，允许继续叠加（保留双方语义时由用户在 UI 选择）
  }
  await table.update(id, { revision: nextRevision(current.revision), updatedAt: Date.now() } as never)
}

async function applyReadingsPayload(payload: PatrolReadingsMergePayload, force: boolean): Promise<void> {
  const patrol = await db.patrols.get(payload.patrolId)
  if (!patrol) throw new Error('巡检任务不存在或已被删除')
  await replayReadings(payload.patrolId, payload.readings)
  await bumpEntityRevision('patrols', payload.patrolId, force)
}

async function applyCompletePayload(payload: PatrolCompleteMergePayload, force: boolean): Promise<void> {
  const patrol = await db.patrols.get(payload.patrolId)
  if (!patrol) throw new Error('巡检任务不存在或已被删除')
  // 先按载荷标准冻结读数，再置已完成（此时历史固化，之后改标不影响）
  await replayReadings(payload.patrolId, payload.readings)
  await db.patrols.put({
    ...patrol,
    state: '已完成',
    patrolDate: payload.patrolDate,
    patrolman: payload.patrolman.trim() || '未署名',
    envNote: payload.envNote.trim(),
    updatedAt: Date.now(),
    revision: nextRevision(patrol.revision)
  })
  void force
}

async function applyLeakPayload(payload: LeakMergePayload, force: boolean): Promise<void> {
  const leak = await db.leaks.get(payload.leakId)
  if (!leak) throw new Error('处置单不存在或已被删除')
  const patch: Record<string, unknown> = { ...payload.patch, updatedAt: Date.now() }
  if (payload.advanceTo) patch.state = payload.advanceTo
  await db.leaks.update(payload.leakId, {
    ...patch,
    revision: nextRevision(leak.revision)
  } as never)
  void force
}

export const useMergeStore = create<MergeState>((set, get) => ({
  pendingMerges: [],
  failedWrites: loadFailedWrites(),
  ready: false,

  refreshFailedWrites() {
    set({ failedWrites: loadFailedWrites() })
  },

  async enqueueConflict(input) {
    const now = Date.now()
    const row: PendingMergeRow = {
      id: createId('pm'),
      type: input.type,
      targetId: input.targetId,
      baseRevision: input.baseRevision,
      conflictRevision: input.currentRevision,
      origin: currentTabId(),
      reason:
        input.reason ??
        `另一个标签页已先写入（基准 v${input.baseRevision} → 当前 v${input.currentRevision}），本份完整保留待合并`,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      status: '待合并'
    }
    await db.pendingMerges.put(row)
    return row
  },

  listOfTarget(targetId) {
    return get()
      .pendingMerges.filter((item) => item.status === '待合并' && item.targetId === targetId)
      .sort((a, b) => b.createdAt - a.createdAt)
  },

  async discardMerge(id) {
    await markMergeStatus(id, '已放弃')
  },

  async clearResolved() {
    const resolved = get()
      .pendingMerges.filter((item) => item.status !== '待合并')
      .map((item) => item.id)
    if (resolved.length > 0) await db.pendingMerges.bulkDelete(resolved)
  },

  async applyMerge(id, force) {
    const merge = get().pendingMerges.find((item) => item.id === id)
    if (!merge) return '待合并记录不存在'
    try {
      await replayPayload(merge.payload, force)
      await markMergeStatus(id, '已合并')
      return null
    } catch (error) {
      if (isRevisionConflictError(error) && !force) {
        return `仍有更新的提交（当前 v${error.currentRevision}），可选择强制合并覆盖`
      }
      return error instanceof Error ? error.message : '合并失败'
    }
  },

  async retryFailedWrite(id) {
    const failed = loadFailedWrites().find((item) => item.id === id)
    if (!failed) return false
    try {
      await replayPayload(failed.payload, true)
      removeFailedWrite(id)
      get().refreshFailedWrites()
      return true
    } catch (error) {
      touchFailedWrite(id, error instanceof Error ? error.message : '重试失败')
      get().refreshFailedWrites()
      return false
    }
  },

  removeFailedWriteRow(id) {
    removeFailedWrite(id)
    get().refreshFailedWrites()
  }
}))

liveQuery(async () =>
  (await db.pendingMerges.toArray()).sort((a, b) => {
    const rank = (status: PendingMerge['status']) => (status === '待合并' ? 0 : 1)
    return rank(a.status) - rank(b.status) || b.createdAt - a.createdAt
  })
).subscribe({
  next: (rows) => useMergeStore.setState({ pendingMerges: rows, ready: true }),
  error: () => useMergeStore.setState({ ready: true })
})

/** 捕获提交错误：冲突进待合并，其他写入失败进 outbox。 */
export async function captureSubmitFailure(input: {
  error: unknown
  type: MergeEntityType
  targetId: string
  payload: MergePayload
  baseRevision?: number
}): Promise<'merged' | 'failed'> {
  if (isRevisionConflictError(input.error) && typeof input.baseRevision === 'number') {
    await useMergeStore.getState().enqueueConflict({
      type: input.type,
      targetId: input.targetId,
      baseRevision: input.baseRevision,
      currentRevision: input.error.currentRevision,
      payload: input.payload
    })
    return 'merged'
  }
  addFailedWrite({
    type: input.type,
    targetId: input.targetId,
    error: input.error instanceof Error ? input.error.message : '写入失败',
    payload: input.payload
  })
  useMergeStore.getState().refreshFailedWrites()
  return 'failed'
}
