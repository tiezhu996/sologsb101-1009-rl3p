/**
 * 并发待合并队列状态（Zustand）
 * - 冲突败方完整载荷、写入失败找回条目统一落 IndexedDB mergeQueue（重开后仍在）
 * - localStorage 中残留的提交草稿在首屏回流为 recovery 提示
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, type MergeQueueRow } from '@/utils/db'
import {
  listSubmitDrafts,
  removeSubmitDraft,
  type LocalSubmitDraft
} from '@/utils/localDraft'
import type { MergeEntityType } from '@/types/merge'

interface MergeState {
  queue: MergeQueueRow[]
  localDrafts: LocalSubmitDraft[]
  ready: boolean
  refreshLocalDrafts: () => void
  markResolved: (id: string, status: '已处理' | '已放弃') => Promise<void>
  removeLocalDraft: (id: string) => void
  pendingOf: (entityType: MergeEntityType, entityId?: string) => MergeQueueRow[]
  pendingCount: (entityType?: MergeEntityType) => number
  localDraftsOf: (entityType: MergeEntityType, entityId?: string) => LocalSubmitDraft[]
}

export const useMergeStore = create<MergeState>((set, get) => ({
  queue: [],
  localDrafts: [],
  ready: false,

  refreshLocalDrafts() {
    set({ localDrafts: listSubmitDrafts() })
  },

  async markResolved(id, status) {
    await db.mergeQueue.update(id, { status, updatedAt: Date.now() })
  },

  removeLocalDraft(id) {
    removeSubmitDraft(id)
    set({ localDrafts: listSubmitDrafts() })
  },

  pendingOf(entityType, entityId) {
    return get()
      .queue.filter((item) => item.status === '待处理' && item.entityType === entityType)
      .filter((item) => (entityId === undefined ? true : item.entityId === entityId))
      .sort((a, b) => b.createdAt - a.createdAt)
  },

  pendingCount(entityType) {
    return get().queue.filter((item) => item.status === '待处理' && (!entityType || item.entityType === entityType)).length
  },

  localDraftsOf(entityType, entityId) {
    return get()
      .localDrafts.filter((item) => item.entityType === entityType)
      .filter((item) => (entityId === undefined ? true : item.entityId === entityId))
  }
}))

liveQuery(async () =>
  (await db.mergeQueue.toArray()).sort((a, b) => b.createdAt - a.createdAt)
).subscribe({
  next: (rows) => useMergeStore.setState({ queue: rows, ready: true }),
  error: () => useMergeStore.setState({ ready: true })
})

// 首屏与跨标签页同步：把 localStorage 残留提交草稿回流为找回提示
function syncLocalDrafts(): void {
  useMergeStore.getState().refreshLocalDrafts()
}
syncLocalDrafts()
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === 'gbgaspress:recovery-drafts') syncLocalDrafts()
  })
  window.addEventListener('focus', syncLocalDrafts)
}
