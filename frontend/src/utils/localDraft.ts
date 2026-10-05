/**
 * 本地草稿（localStorage）
 * - 写入失败时从本地草稿找回：提交前先把完整载荷落到本地，提交成功后清除
 * - 巡检逐点录入草稿持久化：刷新 / 重开浏览器后仍可继续录入
 * - 读数草稿同时留存「录入时依据的标准版本」，标准更新后用于标待复核
 */
import { LS_KEYS } from '@/utils/db'
import type { MergeEntityType, MergePayload } from '@/types/merge'
import type { ReadingDraftMetaMap, ReadingDraftMap } from '@/types/reading'

/* ------------------------- 提交失败找回草稿 ------------------------- */

export interface LocalSubmitDraft {
  id: string
  entityType: MergeEntityType
  entityId: string
  title: string
  baseRevision: number
  payload: MergePayload
  createdAt: number
}

function readSubmitDrafts(): LocalSubmitDraft[] {
  try {
    const raw = localStorage.getItem(LS_KEYS.recoveryDrafts)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LocalSubmitDraft[]) : []
  } catch {
    return []
  }
}

function writeSubmitDrafts(drafts: LocalSubmitDraft[]): void {
  localStorage.setItem(LS_KEYS.recoveryDrafts, JSON.stringify(drafts))
}

/** 提交前留存本地草稿（同业务键覆盖，始终保留最近一次） */
export function saveSubmitDraft(draft: LocalSubmitDraft): void {
  const drafts = readSubmitDrafts().filter((item) => !(item.entityType === draft.entityType && item.entityId === draft.entityId))
  drafts.unshift(draft)
  writeSubmitDrafts(drafts)
}

export function listSubmitDrafts(): LocalSubmitDraft[] {
  return readSubmitDrafts()
}

export function removeSubmitDraft(id: string): void {
  writeSubmitDrafts(readSubmitDrafts().filter((item) => item.id !== id))
}

export function removeSubmitDraftByEntity(entityType: MergeEntityType, entityId: string): void {
  writeSubmitDrafts(
    readSubmitDrafts().filter((item) => !(item.entityType === entityType && item.entityId === entityId))
  )
}

/* ------------------------- 巡检逐点录入草稿 ------------------------- */

export interface PersistedReadingDrafts {
  /** `${patrolId}:${pointId}` → 输入值 */
  values: ReadingDraftMap
  /** `${patrolId}:${pointId}` → 录入时的标准版本元信息 */
  meta: ReadingDraftMetaMap
}

function emptyDrafts(): PersistedReadingDrafts {
  return { values: {}, meta: {} }
}

export function readPersistedReadingDrafts(): PersistedReadingDrafts {
  try {
    const raw = localStorage.getItem(LS_KEYS.readingDrafts)
    if (!raw) return emptyDrafts()
    const parsed = JSON.parse(raw) as Partial<PersistedReadingDrafts>
    return {
      values: parsed.values && typeof parsed.values === 'object' ? parsed.values : {},
      meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
    }
  } catch {
    return emptyDrafts()
  }
}

export function writePersistedReadingDrafts(drafts: PersistedReadingDrafts): void {
  localStorage.setItem(LS_KEYS.readingDrafts, JSON.stringify(drafts))
}

/** 清除某次巡检的全部本地录入草稿 */
export function clearPersistedPatrolDrafts(patrolId: string): void {
  const drafts = readPersistedReadingDrafts()
  const prefix = `${patrolId}:`
  Object.keys(drafts.values).forEach((key) => {
    if (key.startsWith(prefix)) delete drafts.values[key]
  })
  Object.keys(drafts.meta).forEach((key) => {
    if (key.startsWith(prefix)) delete drafts.meta[key]
  })
  writePersistedReadingDrafts(drafts)
}
