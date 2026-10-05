/**
 * 本地草稿 / 待恢复写入（localStorage 兜底）
 * - 巡检读数草稿：录入即落盘，重开浏览器可继续处理；跨标签页通过 storage 事件同步
 * - 写入失败 outbox：IndexedDB 写入异常时保存完整载荷，稍后可重试找回
 */
import type { FailedWrite } from '@/types/merge'
import type { MergePayload, MergeEntityType } from '@/types/merge'
import type { ReadingDraftEntry } from '@/types/reading'
import { readingDraftKey } from '@/types/reading'

const LS_READING_DRAFTS = 'gbgaspress:reading-drafts'
const LS_OUTBOX = 'gbgaspress:failed-writes'

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 当前标签页标识，用于并发留痕 */
export function currentTabId(): string {
  const key = 'gbgaspress:tab-id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem(key, id)
  }
  return id
}

/* ============================ 读数草稿 ============================ */

export type ReadingDraftMap2 = Record<string, ReadingDraftEntry>

export function loadReadingDrafts(): ReadingDraftMap2 {
  return safeParse<ReadingDraftMap2>(localStorage.getItem(LS_READING_DRAFTS), {})
}

export function saveReadingDrafts(map: ReadingDraftMap2): void {
  localStorage.setItem(LS_READING_DRAFTS, JSON.stringify(map))
}

/** 写单条草稿（持久化） */
export function upsertReadingDraft(entry: ReadingDraftEntry): void {
  const map = loadReadingDrafts()
  map[readingDraftKey(entry.patrolId, entry.pointId)] = entry
  saveReadingDrafts(map)
}

export function removeReadingDraft(patrolId: string, pointId: string): void {
  const map = loadReadingDrafts()
  delete map[readingDraftKey(patrolId, pointId)]
  saveReadingDrafts(map)
}

/** 删除某次巡检的全部草稿 */
export function clearReadingDraftsOfPatrol(patrolId: string): void {
  const map = loadReadingDrafts()
  let changed = false
  Object.keys(map).forEach((key) => {
    if (key.startsWith(`${patrolId}:`)) {
      delete map[key]
      changed = true
    }
  })
  if (changed) saveReadingDrafts(map)
}

/**
 * 点位标准升级后：把依据旧版本的未提交草稿标记为「待复核」，
 * 保留原值与旧判定（差异），不覆盖录入值。
 * @param allowedPatrolIds 仅这些巡检（未完成）的草稿参与；已完成巡检的草稿永不标待复核
 */
export function markDraftsForReview(
  pointId: string,
  latestVersion: number,
  allowedPatrolIds?: Set<string>
): Array<{ patrolId: string; pointId: string }> {
  const map = loadReadingDrafts()
  const touched: Array<{ patrolId: string; pointId: string }> = []
  Object.values(map).forEach((entry) => {
    if (entry.pointId !== pointId) return
    if (allowedPatrolIds && !allowedPatrolIds.has(entry.patrolId)) return
    if (entry.basisVersion >= latestVersion) return
    map[readingDraftKey(entry.patrolId, entry.pointId)] = {
      ...entry,
      needsReview: true,
      latestVersion
    }
    touched.push({ patrolId: entry.patrolId, pointId: entry.pointId })
  })
  if (touched.length > 0) saveReadingDrafts(map)
  return touched
}

/* ============================ 写入失败 outbox ============================ */

export function loadFailedWrites(): FailedWrite[] {
  return safeParse<FailedWrite[]>(localStorage.getItem(LS_OUTBOX), [])
}

function persistFailedWrites(list: FailedWrite[]): void {
  localStorage.setItem(LS_OUTBOX, JSON.stringify(list))
}

export function addFailedWrite(input: {
  type: MergeEntityType
  targetId: string
  error: string
  payload: MergePayload
}): FailedWrite {
  const list = loadFailedWrites()
  const row: FailedWrite = {
    id: `fw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    targetId: input.targetId,
    origin: currentTabId(),
    error: input.error,
    payload: input.payload,
    createdAt: Date.now(),
    retriedAt: null
  }
  list.unshift(row)
  persistFailedWrites(list)
  return row
}

export function touchFailedWrite(id: string, error?: string): void {
  const list = loadFailedWrites().map((item) =>
    item.id === id ? { ...item, retriedAt: Date.now(), ...(error ? { error } : {}) } : item
  )
  persistFailedWrites(list)
}

export function removeFailedWrite(id: string): void {
  persistFailedWrites(loadFailedWrites().filter((item) => item.id !== id))
}
