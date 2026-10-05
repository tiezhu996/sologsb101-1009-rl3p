/**
 * 巡检任务与读数状态（Zustand）
 * 维护巡检任务列表、读数草稿（localStorage 持久化）与异常判定结果。
 * - 标准升级后未提交草稿标「待复核」，保留原值与新旧差异
 * - 提交读数 / 完成巡检走行版本号乐观锁，冲突载荷完整进入待合并队列
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  commitWithRevision,
  createId,
  db,
  deletePatrolCascade,
  putReading,
  type PatrolRow
} from '@/utils/db'
import { RevisionConflictError } from '@/utils/conflict'
import {
  clearReadingDraftsOfPatrol,
  loadReadingDrafts,
  removeReadingDraft,
  upsertReadingDraft
} from '@/utils/localDraft'
import { captureSubmitFailure } from '@/stores/mergeStore'
import type { Patrol, PatrolDraft, PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading, ReadingDraftEntry } from '@/types/reading'
import { readingDraftKey } from '@/types/reading'
import type { ReadingCommitItem } from '@/types/merge'
import type { AbnormalLevel, ReadingJudgement } from '@/utils/range'
import { abnormalLevelOf, abnormalWeight, judgeReading } from '@/utils/range'
import { useStationStore } from '@/stores/stationStore'

export interface AbnormalRow {
  reading: Reading
  patrol: Patrol | null
  point: Point | null
  level: AbnormalLevel
  weight: number
}

/** 读数提交结果：成功 / 版本冲突（已留待合并） / 写入失败（已存本地） */
export type SaveOutcome =
  | { status: 'saved'; count: number }
  | { status: 'conflict'; count: number }
  | { status: 'failed'; count: number }

interface PatrolState_ {
  patrols: Patrol[]
  readings: Reading[]
  /** 读数草稿（localStorage 持久化，重开可继续）：`${patrolId}:${pointId}` → 条目 */
  draftEntries: Record<string, ReadingDraftEntry>
  /** 兼容旧选择器的数值视图：key → value */
  readingDraft: Record<string, number>
  /** 当前正在录入的巡检 id */
  activePatrolId: string | null
  filter: { stationId: string; states: PatrolState[] }
  ready: boolean
  hydrateDrafts: () => void
  setActivePatrol: (id: string | null) => void
  patchFilter: (patch: { stationId?: string; states?: PatrolState[] }) => void
  resetFilter: () => void
  createPatrol: (draft: PatrolDraft) => Promise<Patrol>
  updatePatrol: (id: string, patch: Partial<PatrolDraft>) => Promise<void>
  removePatrol: (id: string) => Promise<void>
  generatePlans: (stationIds: string[], planDate: string, patrolman: string) => Promise<number>
  markMissed: (id: string, note: string) => Promise<void>
  completePatrol: (id: string, patrolDate: string, patrolman: string, envNote: string) => Promise<void>
  /** 完成巡检同时提交读数（带乐观锁） */
  completePatrolWithReadings: (
    id: string,
    patrolDate: string,
    patrolman: string,
    envNote: string,
    points: Point[]
  ) => Promise<SaveOutcome>
  setReadingDraft: (patrolId: string, point: Point, value: number, note?: string) => void
  clearReadingDraft: (patrolId?: string) => void
  /** 复核通过：以最新标准重新判定（保留原值），取消待复核 */
  acknowledgeDraft: (patrolId: string, point: Point) => void
  /** 复核调整：写入新值并按最新标准判定 */
  reviseDraft: (patrolId: string, point: Point, value: number) => void
  seedDraftFromReadings: (patrolId: string, points: Point[]) => void
  draftEntry: (patrolId: string, pointId: string) => ReadingDraftEntry | undefined
  reviewCountOf: (patrolId: string) => number
  saveReadingDrafts: (patrolId: string, points: Point[], expectedRevision?: number) => Promise<SaveOutcome>
  saveSingleReading: (patrolId: string, point: Point, value: number, note: string) => Promise<void>
  removeReading: (id: string) => Promise<void>
  judge: (point: Point, value: number) => ReadingJudgement
  readingsOfPatrol: (patrolId: string) => Reading[]
  abnormalRows: () => AbnormalRow[]
  filteredPatrols: () => Patrol[]
  pointValuesOf: (patrolId: string) => Map<string, Reading>
}

function draftValues(entries: Record<string, ReadingDraftEntry>): Record<string, number> {
  const values: Record<string, number> = {}
  Object.entries(entries).forEach(([key, entry]) => {
    values[key] = entry.value
  })
  return values
}

function buildEntry(patrolId: string, point: Point, value: number, note?: string): ReadingDraftEntry {
  const old = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
  return {
    patrolId,
    pointId: point.id,
    value,
    note,
    basisVersion: point.standardVersion ?? 1,
    oldDeviationPct: old.deviationPct,
    oldIsAbnormal: old.isAbnormal,
    needsReview: false,
    latestVersion: point.standardVersion ?? 1,
    updatedAt: Date.now()
  }
}

/** 由草稿条目与点位集合组装提交读数载荷（待复核草稿不允许提交） */
function buildCommitItems(
  patrolId: string,
  points: Point[],
  entries: Record<string, ReadingDraftEntry>
): ReadingCommitItem[] {
  const items: ReadingCommitItem[] = []
  points.forEach((point) => {
    const entry = entries[readingDraftKey(patrolId, point.id)]
    if (!entry || entry.needsReview) return
    if (!Number.isFinite(entry.value)) return
    items.push({
      pointId: point.id,
      value: entry.value,
      note: entry.note ?? '',
      // 已复核或复核后未再升级：按点位现行版本提交
      standardVersion: point.standardVersion ?? entry.basisVersion
    })
  })
  return items
}

export const usePatrolStore = create<PatrolState_>((set, get) => ({
  patrols: [],
  readings: [],
  draftEntries: {},
  readingDraft: {},
  activePatrolId: null,
  filter: { stationId: '', states: [] },
  ready: false,

  hydrateDrafts() {
    const entries = loadReadingDrafts()
    set({ draftEntries: entries, readingDraft: draftValues(entries) })
  },

  setActivePatrol(id) {
    set({ activePatrolId: id })
  },

  patchFilter(patch) {
    set({
      filter: {
        stationId: patch.stationId ?? get().filter.stationId,
        states: patch.states ?? get().filter.states
      }
    })
  },

  resetFilter() {
    set({ filter: { stationId: '', states: [] } })
  },

  async createPatrol(draft) {
    const now = Date.now()
    const row: PatrolRow = {
      id: createId('pa'),
      stationId: draft.stationId || '',
      planDate: draft.planDate,
      patrolDate: draft.patrolDate,
      patrolman: draft.patrolman.trim(),
      envNote: draft.envNote.trim(),
      state: draft.state,
      createdAt: now,
      updatedAt: now
    }
    await db.patrols.put(row)
    return row
  },

  async updatePatrol(id, patch) {
    const current = await db.patrols.get(id)
    const next: Partial<PatrolRow> = { ...patch, updatedAt: Date.now() }
    if (patch.patrolman !== undefined) next.patrolman = patch.patrolman.trim()
    if (patch.envNote !== undefined) next.envNote = patch.envNote.trim()
    next.revision = (current?.revision ?? 2) + 1
    await db.patrols.update(id, next)
  },

  async removePatrol(id) {
    await deletePatrolCascade(id)
    get().clearReadingDraft(id)
    if (get().activePatrolId === id) set({ activePatrolId: null })
  },

  async generatePlans(stationIds, planDate, patrolman) {
    const now = Date.now()
    const existing = get().patrols.filter((patrol) => patrol.planDate === planDate).map((patrol) => patrol.stationId)
    const rows: PatrolRow[] = stationIds
      .filter((stationId) => !existing.includes(stationId))
      .map((stationId) => ({
        id: createId('pa'),
        stationId,
        planDate,
        patrolDate: '',
        patrolman: patrolman.trim(),
        envNote: '',
        state: '待巡检' as PatrolState,
        createdAt: now,
        updatedAt: now
      }))
    if (rows.length > 0) await db.patrols.bulkPut(rows)
    return rows.length
  },

  async markMissed(id, note) {
    const current = await db.patrols.get(id)
    await db.patrols.update(id, {
      state: '漏检',
      envNote: note.trim() || '超期未执行',
      updatedAt: Date.now(),
      revision: (current?.revision ?? 2) + 1
    })
  },

  async completePatrol(id, patrolDate, patrolman, envNote) {
    const current = await db.patrols.get(id)
    await db.patrols.update(id, {
      state: '已完成',
      patrolDate,
      patrolman: patrolman.trim() || '未署名',
      envNote: envNote.trim(),
      updatedAt: Date.now(),
      revision: (current?.revision ?? 2) + 1
    })
  },

  async completePatrolWithReadings(id, patrolDate, patrolman, envNote, points) {
    const patrol = get().patrols.find((item) => item.id === id)
    const baseRevision = patrol ? (patrol as PatrolRow).revision ?? 2 : 2
    const entries = get().draftEntries
    const items = buildCommitItems(id, points, entries)
    try {
      // 乐观锁 + 单事务：两个标签页同时完成时先写入者生效；
      // 先按载荷所依据的标准版本冻结读数，再把巡检置为已完成（历史随即固化）。
      await db.transaction('rw', db.patrols, db.readings, db.points, db.pointStandards, async () => {
        const current = await db.patrols.get(id)
        if (!current) throw new Error('巡检任务不存在或已被删除')
        const currentRevision = typeof current.revision === 'number' ? current.revision : 2
        if (baseRevision !== currentRevision) {
          throw new RevisionConflictError(baseRevision, currentRevision)
        }
        const existingRows = await db.readings.where('patrolId').equals(id).toArray()
        const now = Date.now()
        for (const item of items) {
          const existing = existingRows.find((row) => row.pointId === item.pointId)
          await putReading({
            id: existing ? existing.id : createId('rd'),
            patrolId: id,
            pointId: item.pointId,
            value: item.value,
            note: item.note,
            standardVersion: item.standardVersion,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now
          })
        }
        await db.patrols.put({
          ...current,
          state: '已完成',
          patrolDate,
          patrolman: patrolman.trim() || '未署名',
          envNote: envNote.trim(),
          updatedAt: now,
          revision: currentRevision + 1
        })
      })
      items.forEach((item) => removeReadingDraft(id, item.pointId))
      const nextEntries = loadReadingDrafts()
      set({ draftEntries: nextEntries, readingDraft: draftValues(nextEntries) })
      return { status: 'saved', count: items.length }
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        await captureSubmitFailure({
          error,
          type: 'patrol-complete',
          targetId: id,
          baseRevision,
          payload: { kind: 'patrol-complete', patrolId: id, patrolDate, patrolman, envNote, readings: items }
        })
        return { status: 'conflict', count: items.length }
      }
      await captureSubmitFailure({
        error,
        type: 'patrol-complete',
        targetId: id,
        payload: { kind: 'patrol-complete', patrolId: id, patrolDate, patrolman, envNote, readings: items }
      })
      return { status: 'failed', count: items.length }
    }
  },

  setReadingDraft(patrolId, point, value, note) {
    const existing = get().draftEntries[readingDraftKey(patrolId, point.id)]
    // 标准升级过的草稿在用户重新录入时按最新标准重建；同版本连续录入仅更新值（保留备注与原差异）
    const entry: ReadingDraftEntry =
      existing && !existing.needsReview && existing.basisVersion === (point.standardVersion ?? 1)
        ? {
            ...existing,
            value,
            ...(note !== undefined ? { note } : {}),
            updatedAt: Date.now()
          }
        : buildEntry(patrolId, point, value, note)
    upsertReadingDraft(entry)
    const entries = loadReadingDrafts()
    set({ draftEntries: entries, readingDraft: draftValues(entries) })
  },

  clearReadingDraft(patrolId) {
    if (patrolId === undefined) {
      Object.keys(loadReadingDrafts()).forEach((key) => {
        const [pid, pointId] = key.split(':')
        removeReadingDraft(pid, pointId)
      })
    } else {
      clearReadingDraftsOfPatrol(patrolId)
    }
    const entries = loadReadingDrafts()
    set({ draftEntries: entries, readingDraft: draftValues(entries) })
  },

  acknowledgeDraft(patrolId, point) {
    const key = readingDraftKey(patrolId, point.id)
    const existing = get().draftEntries[key]
    if (!existing) return
    // 复核通过：保留原值；以最新标准作为新判定基准；旧判定（差异）保留在 old* 字段
    const next: ReadingDraftEntry = {
      ...existing,
      basisVersion: point.standardVersion ?? 1,
      latestVersion: point.standardVersion ?? 1,
      needsReview: false,
      updatedAt: Date.now()
    }
    upsertReadingDraft(next)
    const entries = loadReadingDrafts()
    set({ draftEntries: entries, readingDraft: draftValues(entries) })
  },

  reviseDraft(patrolId, point, value) {
    const entry = buildEntry(patrolId, point, value)
    upsertReadingDraft(entry)
    const entries = loadReadingDrafts()
    set({ draftEntries: entries, readingDraft: draftValues(entries) })
  },

  seedDraftFromReadings(patrolId, points) {
    const patrol = get().patrols.find((item) => item.id === patrolId)
    // 已完成巡检的读数已冻结，不再灌入草稿（避免误改历史判定）
    if (!patrol || patrol.state === '已完成') return
    const entries = { ...get().draftEntries }
    let changed = false
    const existing = get().readings.filter((reading) => reading.patrolId === patrolId)
    points.forEach((point) => {
      const key = readingDraftKey(patrolId, point.id)
      if (entries[key] !== undefined) return
      const found = existing.find((reading) => reading.pointId === point.id)
      if (found) {
        entries[key] = {
          patrolId,
          pointId: point.id,
          value: found.value,
          note: found.note,
          basisVersion: point.standardVersion ?? 1,
          oldDeviationPct: found.deviationPct,
          oldIsAbnormal: found.isAbnormal,
          needsReview: false,
          latestVersion: point.standardVersion ?? 1,
          updatedAt: Date.now(),
          committedValue: found.value
        }
        changed = true
      }
    })
    if (changed) set({ draftEntries: entries, readingDraft: draftValues(entries) })
  },

  draftEntry(patrolId, pointId) {
    return get().draftEntries[readingDraftKey(patrolId, pointId)]
  },

  reviewCountOf(patrolId) {
    return Object.values(get().draftEntries).filter(
      (entry) => entry.patrolId === patrolId && entry.needsReview
    ).length
  },

  async saveReadingDrafts(patrolId, points, expectedRevision) {
    const patrol = get().patrols.find((item) => item.id === patrolId)
    const baseRevision =
      expectedRevision ?? (patrol ? (patrol as PatrolRow).revision ?? 2 : 2)
    const entries = get().draftEntries
    const items = buildCommitItems(patrolId, points, entries)
    if (items.length === 0) return { status: 'saved', count: 0 }
    try {
      await commitWithRevision(db.patrols, patrolId, {}, baseRevision)
      const existingRows = await db.readings.where('patrolId').equals(patrolId).toArray()
      const now = Date.now()
      for (const item of items) {
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
      // 提交后清除本次提交点位的草稿
      items.forEach((item) => removeReadingDraft(patrolId, item.pointId))
      const nextEntries = loadReadingDrafts()
      set({ draftEntries: nextEntries, readingDraft: draftValues(nextEntries) })
      return { status: 'saved', count: items.length }
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        await captureSubmitFailure({
          error,
          type: 'patrol-readings',
          targetId: patrolId,
          baseRevision,
          payload: { kind: 'patrol-readings', patrolId, readings: items }
        })
        return { status: 'conflict', count: items.length }
      }
      await captureSubmitFailure({
        error,
        type: 'patrol-readings',
        targetId: patrolId,
        payload: { kind: 'patrol-readings', patrolId, readings: items }
      })
      return { status: 'failed', count: items.length }
    }
  },

  async saveSingleReading(patrolId, point, value, note) {
    const now = Date.now()
    const found = get().readings.find((reading) => reading.patrolId === patrolId && reading.pointId === point.id)
    await putReading({
      id: found ? found.id : createId('rd'),
      patrolId,
      pointId: point.id,
      value,
      note,
      standardVersion: point.standardVersion,
      createdAt: found ? found.createdAt : now,
      updatedAt: now
    })
  },

  async removeReading(id) {
    await db.readings.delete(id)
  },

  judge(point, value) {
    return judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
  },

  readingsOfPatrol(patrolId) {
    return get().readings.filter((reading) => reading.patrolId === patrolId)
  },

  abnormalRows() {
    const points = useStationStore.getState().points
    return get()
      .readings.filter((reading) => reading.isAbnormal)
      .map((reading) => {
        const point = points.find((item) => item.id === reading.pointId) ?? null
        const patrol = get().patrols.find((item) => item.id === reading.patrolId) ?? null
        // 历史读数按冻结快照判级，后来的标准不改变其异常级别
        const isCritical = reading.standardSnapshot?.isCritical ?? point?.isCritical ?? false
        const level: AbnormalLevel = abnormalLevelOf(reading.deviationPct, isCritical)
        return {
          reading,
          patrol,
          point,
          level,
          weight: abnormalWeight(level, isCritical)
        }
      })
      .sort((a, b) => b.weight - a.weight || b.reading.deviationPct - a.reading.deviationPct)
  },

  filteredPatrols() {
    const { patrols, filter } = get()
    return patrols
      .filter((patrol) => {
        if (filter.stationId && patrol.stationId !== filter.stationId) return false
        if (filter.states.length > 0 && !filter.states.includes(patrol.state)) return false
        return true
      })
      .sort((a, b) => b.planDate.localeCompare(a.planDate))
  },

  pointValuesOf(patrolId) {
    const map = new Map<string, Reading>()
    get()
      .readings.filter((reading) => reading.patrolId === patrolId)
      .forEach((reading) => map.set(reading.pointId, reading))
    return map
  }
}))

liveQuery(async () =>
  (await db.patrols.toArray()).sort((a, b) => b.planDate.localeCompare(a.planDate))
).subscribe({
  next: (rows) => usePatrolStore.setState({ patrols: rows, ready: true }),
  error: () => usePatrolStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.readings.toArray()).sort((a, b) => b.deviationPct - a.deviationPct)
).subscribe({
  next: (rows) => usePatrolStore.setState({ readings: rows })
})

// 首屏水合本地草稿
usePatrolStore.getState().hydrateDrafts()

// 跨标签页：草稿 / 标准升级广播
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === 'gbgaspress:reading-drafts') {
      usePatrolStore.getState().hydrateDrafts()
    }
    if (event.key === 'gbgaspress:standard-bump') {
      // 其它标签页提交了标准新版本：本页未完成巡检的旧草稿补标待复核
      const entries = loadReadingDrafts()
      const points = useStationStore.getState().points
      const openPatrolIds = new Set(
        usePatrolStore.getState().patrols.filter((patrol) => patrol.state !== '已完成').map((patrol) => patrol.id)
      )
      let changed = false
      Object.values(entries).forEach((entry) => {
        if (!openPatrolIds.has(entry.patrolId)) return
        const point = points.find((item) => item.id === entry.pointId)
        if (point && entry.basisVersion < (point.standardVersion ?? 1) && !entry.needsReview) {
          upsertReadingDraft({ ...entry, needsReview: true, latestVersion: point.standardVersion })
          changed = true
        }
      })
      if (changed) usePatrolStore.getState().hydrateDrafts()
    }
  })
}

export { abnormalLevelOf }
