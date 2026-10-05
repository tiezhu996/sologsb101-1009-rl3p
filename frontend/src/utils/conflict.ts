/**
 * 乐观锁（revision CAS）与并发冲突处理
 * - 两个标签页并发提交同一巡检 / 处置单：先写入者生效（revision 递增）
 * - 后写入者 expectedRevision 不匹配 → 抛 RevisionConflict，完整载荷留作「待合并」
 */
import { createId, db, nextRevision, type MergeQueueRow, type Revisioned } from '@/utils/db'
import type { Table } from 'dexie'
import type { MergeEntityType, MergePayload } from '@/types/merge'

/** 乐观锁冲突：另一个标签页已经先写入 */
export class RevisionConflict extends Error {
  currentRevision: number
  expectedRevision: number
  constructor(expectedRevision: number, currentRevision: number) {
    super(`数据已被其他标签页先提交（当前版本 ${currentRevision}，你基于版本 ${expectedRevision} 编辑）`)
    this.name = 'RevisionConflict'
    this.expectedRevision = expectedRevision
    this.currentRevision = currentRevision
  }
}

/**
 * 乐观锁更新：仅当行当前 revision === expectedRevision 时写入。
 * 行不存在时抛错；版本不匹配时抛 RevisionConflict。
 */
export async function casUpdate<T extends Revisioned, TKey>(
  table: Table<T, TKey>,
  key: TKey,
  expectedRevision: number,
  updater: (current: T) => Partial<T>
): Promise<T> {
  const current = await table.get(key)
  if (!current) throw new Error('记录不存在或已被删除')
  const currentRev = typeof current.revision === 'number' ? current.revision : 0
  if (currentRev !== expectedRevision) {
    throw new RevisionConflict(expectedRevision, currentRev)
  }
  const patch = updater(current)
  const next = { ...patch, revision: nextRevision(currentRev), updatedAt: Date.now() } as Partial<T>
  await table.update(key, next as never)
  const fresh = await table.get(key)
  return fresh as T
}

/** 读取行当前 revision（不存在返回 0） */
export async function currentRevisionOf<T extends Revisioned, TKey>(table: Table<T, TKey>, key: TKey): Promise<number> {
  const row = await table.get(key)
  return typeof row?.revision === 'number' ? row.revision : 0
}

/** 把冲突败方的完整载荷写入待合并队列（IndexedDB 持久化，重开后继续处理） */
export async function enqueueConflict(input: {
  entityType: MergeEntityType
  entityId: string
  title: string
  baseRevision: number
  currentRevision: number
  payload: MergePayload
}): Promise<MergeQueueRow> {
  const now = Date.now()
  const row: MergeQueueRow = {
    id: createId('mq'),
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    source: 'conflict',
    status: '待处理',
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    payload: input.payload,
    createdAt: now,
    updatedAt: now
  }
  await db.mergeQueue.put(row)
  return row
}

/** 把写入失败（非冲突）的载荷从本地找回：登记为 recovery 待合并条目 */
export async function enqueueRecovery(input: {
  entityType: MergeEntityType
  entityId: string
  title: string
  baseRevision: number
  payload: MergePayload
}): Promise<MergeQueueRow> {
  const now = Date.now()
  const row: MergeQueueRow = {
    id: createId('mq'),
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    source: 'recovery',
    status: '待处理',
    baseRevision: input.baseRevision,
    currentRevision: input.baseRevision,
    payload: input.payload,
    createdAt: now,
    updatedAt: now
  }
  await db.mergeQueue.put(row)
  return row
}

export type GuardedSubmitResult =
  | { outcome: 'committed' }
  | { outcome: 'conflict'; currentRevision: number }
  | { outcome: 'error'; error: unknown }

/**
 * 受保护提交：
 * 1. 先写本地草稿（localStorage，由调用方在 submit 内完成持久化，这里仅执行）
 * 2. 执行 commit（内部使用 casUpdate 做乐观锁）
 * 3. 冲突 → 完整载荷入待合并队列；其他错误 → 标记 recovery 留档
 */
export async function guardedSubmit(
  commit: () => Promise<void>,
  onConflict: (currentRevision: number) => Promise<{ entityId: string; title: string; baseRevision: number; payload: MergePayload; entityType: MergeEntityType }>,
  onError: () => Promise<{ entityId: string; title: string; baseRevision: number; payload: MergePayload; entityType: MergeEntityType }>
): Promise<GuardedSubmitResult> {
  try {
    await commit()
    return { outcome: 'committed' }
  } catch (error) {
    if (error instanceof RevisionConflict) {
      const meta = await onConflict(error.currentRevision)
      await enqueueConflict({
        entityType: meta.entityType,
        entityId: meta.entityId,
        title: meta.title,
        baseRevision: meta.baseRevision,
        currentRevision: error.currentRevision,
        payload: meta.payload
      })
      return { outcome: 'conflict', currentRevision: error.currentRevision }
    }
    const meta = await onError()
    await enqueueRecovery({
      entityType: meta.entityType,
      entityId: meta.entityId,
      title: meta.title,
      baseRevision: meta.baseRevision,
      payload: meta.payload
    })
    return { outcome: 'error', error }
  }
}
