/**
 * 巡检任务与读数状态（Zustand）
 * 维护巡检任务列表、读数草稿与异常判定结果。
 *
 * 标准版本口径：
 * - 已保存读数携带「当时标准」快照，异常判定永远按快照计算，历史不被新标准改判
 * - 标准更新时，未完成巡检中的已保存读数标「待复核」，保留原值与差异
 * - 录入中的草稿（readingDraft）记录录入时标准版本，标准更新后同样标待复核
 *
 * 并发口径：
 * - 完成巡检走 revision 乐观锁，两个标签页并发时先写入者生效，败方完整载荷留作待合并
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createId,
  db,
  deletePatrolCascade,
  nextRevision,
  putReading,
  standardOfPoint,
  type PatrolRow,
  type ReadingRow
} from '@/utils/db'
import { RevisionConflict } from '@/utils/conflict'
import {
  clearPersistedPatrolDrafts,
  readPersistedReadingDrafts,
  writePersistedReadingDrafts
} from '@/utils/localDraft'
import type { Patrol, PatrolDraft, PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading, ReadingDraftMeta, ReadingDraftMetaMap, ReadingDraftMap } from '@/types/reading'
import type { AbnormalLevel, ReadingJudgement } from '@/utils/range'
import { abnormalLevelOf, abnormalWeight, judgeByStandard, judgeReading } from '@/utils/range'
import { useStationStore } from '@/stores/stationStore'

export interface AbnormalRow {
  reading: Reading
  patrol: Patrol | null
  point: Point | null
  level: AbnormalLevel
  weight: number
}

/** 完成巡检的乐观锁结果 */
export type CompletePatrolResult =
  | { outcome: 'committed' }
  | { outcome: 'conflict'; expectedRevision: number; currentRevision: number }

interface PatrolState_ {
  patrols: PatrolRow[]
  readings: ReadingRow[]
  /** 读数草稿：`${patrolId}:${pointId}` → 输入值 */
  readingDraft: ReadingDraftMap
  /** 草稿元信息：录入时依据的标准版本（标准更新后据此标待复核） */
  readingDraftMeta: ReadingDraftMetaMap
  /** 当前正在录入的巡检 id */
  activePatrolId: string | null
  filter: { stationId: string; states: PatrolState[] }
  ready: boolean
  setActivePatrol: (id: string | null) => void
  patchFilter: (patch: { stationId?: string; states?: PatrolState[] }) => void
  resetFilter: () => void
  createPatrol: (draft: PatrolDraft) => Promise<Patrol>
  updatePatrol: (id: string, patch: Partial<PatrolDraft>) => Promise<void>
  removePatrol: (id: string) => Promise<void>
  generatePlans: (stationIds: string[], planDate: string, patrolman: string) => Promise<number>
  markMissed: (id: string, note: string) => Promise<void>
  /** 完成巡检（乐观锁）；整批读数与巡检回写在一个事务内提交 */
  completePatrol: (
    id: string,
    params: { patrolDate: string; patrolman: string; envNote: string },
    expectedRevision: number,
    points: Point[]
  ) => Promise<CompletePatrolResult>
  setReadingDraft: (patrolId: string, point: Point, value: number) => void
  clearReadingDraft: (patrolId?: string) => void
  seedDraftFromReadings: (patrolId: string, points: Point[]) => void
  /** 从待合并载荷恢复草稿（重开后继续处理） */
  hydrateDraftFromPayload: (patrolId: string, readings: Array<{ pointId: string; value: number }>, points: Point[]) => void
  saveReadingDrafts: (patrolId: string, points: Point[]) => Promise<number>
  /**
   * 保存单条读数。
   * preserveStandard=true（仅改备注）时沿用读数原有当时标准快照，避免新标准改判历史；
   * 默认按点位当前标准判定（用于修正读数 / 异常确认）。
   */
  saveSingleReading: (
    patrolId: string,
    point: Point,
    value: number,
    note: string,
    options?: { preserveStandard?: boolean }
  ) => Promise<void>
  /** 待复核读数 → 按当前新标准重判并落新快照 */
  reviewReadingWithCurrent: (readingId: string, point: Point) => Promise<void>
  /** 待复核读数 → 维持原判定（按读数自带的旧快照重新冻结，清除待复核） */
  keepReadingJudgement: (readingId: string) => Promise<void>
  /** 待复核草稿 → 按新标准重判（更新草稿元信息到当前版本） */
  reviewDraftWithCurrent: (patrolId: string, point: Point) => void
  /** 待复核草稿 → 维持原判定（落库时强制使用旧快照） */
  keepDraftJudgement: (patrolId: string, point: Point) => void
  isDraftPending: (patrolId: string, pointId: string) => boolean
  removeReading: (id: string) => Promise<void>
  judge: (point: Point, value: number) => ReadingJudgement
  judgeReadingRow: (reading: Reading) => ReadingJudgement
  readingsOfPatrol: (patrolId: string) => ReadingRow[]
  pendingReviewCountOf: (patrolId: string, points: Point[]) => number
  abnormalRows: () => AbnormalRow[]
  filteredPatrols: () => PatrolRow[]
  pointValuesOf: (patrolId: string) => Map<string, Reading>
}

const persisted = readPersistedReadingDrafts()

function persistDrafts(values: ReadingDraftMap, meta: ReadingDraftMetaMap): void {
  writePersistedReadingDrafts({ values, meta })
}

export const usePatrolStore = create<PatrolState_>((set, get) => ({
  patrols: [],
  readings: [],
  readingDraft: persisted.values,
  readingDraftMeta: persisted.meta,
  activePatrolId: null,
  filter: { stationId: '', states: [] },
  ready: false,

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
    const next: Partial<PatrolRow> = { ...patch, updatedAt: Date.now() }
    if (patch.patrolman !== undefined) next.patrolman = patch.patrolman.trim()
    if (patch.envNote !== undefined) next.envNote = patch.envNote.trim()
    await db.patrols.update(id, next)
  },

  async removePatrol(id) {
    await deletePatrolCascade(id)
    get().clearReadingDraft(id)
    clearPersistedPatrolDrafts(id)
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
    await db.patrols.update(id, { state: '漏检', envNote: note.trim() || '超期未执行', updatedAt: Date.now() })
  },

  async completePatrol(id, params, expectedRevision, points) {
    try {
      await db.transaction('rw', [db.patrols, db.readings], async () => {
        const patrol = await db.patrols.get(id)
        if (!patrol) throw new Error('巡检任务不存在')
        const currentRev = typeof patrol.revision === 'number' ? patrol.revision : 0
        if (currentRev !== expectedRevision) {
          throw new RevisionConflict(expectedRevision, currentRev)
        }
        const now = Date.now()
        const draft = get().readingDraft
        const existing = await db.readings.where('patrolId').equals(id).toArray()
        const existingByPoint = new Map(existing.map((reading) => [reading.pointId, reading]))
        const nextReadings: ReadingRow[] = []
        points.forEach((point) => {
          const value = draft[`${id}:${point.id}`]
          if (value === undefined || !Number.isFinite(value)) return
          const found = existingByPoint.get(point.id)
          const meta = get().readingDraftMeta[`${id}:${point.id}`]
          // 草稿仍按旧标准录入时（用户选「维持原判定」或尚未复核），沿用旧快照冻结
          const useOld = meta && meta.standardVersionId !== point.currentVersionId
          const standard = standardOfPoint(point)
          const effective = useOld && meta
            ? {
                standardMin: meta.standardMin,
                standardMax: meta.standardMax,
                standardUnit: meta.standardUnit,
                isCritical: meta.isCritical,
                versionId: meta.standardVersionId,
                versionNo: meta.standardVersionNo
              }
            : {
                standardMin: standard.standardMin,
                standardMax: standard.standardMax,
                standardUnit: standard.standardUnit,
                isCritical: standard.isCritical,
                versionId: point.currentVersionId,
                versionNo: point.currentVersionNo
              }
          const judgement = judgeByStandard(value, effective)
          nextReadings.push({
            id: found ? found.id : createId('rd'),
            patrolId: id,
            pointId: point.id,
            value,
            isAbnormal: judgement.isAbnormal,
            deviationPct: judgement.deviationPct,
            note: found ? found.note : '',
            standardMin: effective.standardMin,
            standardMax: effective.standardMax,
            standardUnit: effective.standardUnit,
            isCritical: effective.isCritical,
            standardVersionId: effective.versionId,
            standardVersionNo: effective.versionNo,
            reviewState: '无',
            createdAt: found ? found.createdAt : now,
            updatedAt: now,
            revision: found ? nextRevision(found.revision) : 2
          })
        })
        if (nextReadings.length > 0) await db.readings.bulkPut(nextReadings)
        // 完成即提交：巡检内其余读数（含尚未处理完的待复核读数）按各自留存快照冻结，解除待复核
        await db.readings.where('patrolId').equals(id).modify((reading) => {
          if (reading.reviewState !== '无') reading.reviewState = '无'
        })
        await db.patrols.put({
          ...patrol,
          state: '已完成',
          patrolDate: params.patrolDate,
          patrolman: params.patrolman.trim() || '未署名',
          envNote: params.envNote.trim(),
          updatedAt: now,
          revision: nextRevision(currentRev)
        })
      })
      // 提交成功：清掉本次巡检的内存与本地草稿
      get().clearReadingDraft(id)
      clearPersistedPatrolDrafts(id)
      return { outcome: 'committed' }
    } catch (error) {
      if (error instanceof RevisionConflict) {
        return { outcome: 'conflict', expectedRevision, currentRevision: error.currentRevision }
      }
      throw error
    }
  },

  setReadingDraft(patrolId, point, value) {
    const key = `${patrolId}:${point.id}`
    const standard = standardOfPoint(point)
    const meta: ReadingDraftMeta = {
      ...standard,
      standardVersionId: point.currentVersionId,
      standardVersionNo: point.currentVersionNo,
      reviewState: '无'
    }
    set((state) => {
      const values = { ...state.readingDraft, [key]: value }
      const metaMap = { ...state.readingDraftMeta, [key]: meta }
      persistDrafts(values, metaMap)
      return { readingDraft: values, readingDraftMeta: metaMap }
    })
  },

  clearReadingDraft(patrolId) {
    if (patrolId === undefined) {
      set({ readingDraft: {}, readingDraftMeta: {} })
      persistDrafts({}, {})
      return
    }
    const values: ReadingDraftMap = {}
    const meta: ReadingDraftMetaMap = {}
    const prefix = `${patrolId}:`
    Object.entries(get().readingDraft).forEach(([key, value]) => {
      if (!key.startsWith(prefix)) values[key] = value
    })
    Object.entries(get().readingDraftMeta).forEach(([key, value]) => {
      if (!key.startsWith(prefix)) meta[key] = value
    })
    set({ readingDraft: values, readingDraftMeta: meta })
    persistDrafts(values, meta)
  },

  seedDraftFromReadings(patrolId, points) {
    const next = { ...get().readingDraft }
    const nextMeta = { ...get().readingDraftMeta }
    const existing = get().readings.filter((reading) => reading.patrolId === patrolId)
    points.forEach((point) => {
      const key = `${patrolId}:${point.id}`
      const found = existing.find((reading) => reading.pointId === point.id)
      if (next[key] === undefined && found) {
        next[key] = found.value
      }
      if (!nextMeta[key] && found) {
        // 草稿元信息沿用读数保存时的标准版本；与点位现行版本不一致时即待复核
        nextMeta[key] = {
          standardMin: found.standardMin,
          standardMax: found.standardMax,
          standardUnit: found.standardUnit,
          isCritical: found.isCritical,
          standardVersionId: found.standardVersionId,
          standardVersionNo: found.standardVersionNo,
          reviewState: found.reviewState
        }
      }
    })
    set({ readingDraft: next, readingDraftMeta: nextMeta })
    persistDrafts(next, nextMeta)
  },

  hydrateDraftFromPayload(patrolId, readings, points) {
    const values = { ...get().readingDraft }
    const meta = { ...get().readingDraftMeta }
    const pointById = new Map(points.map((point) => [point.id, point]))
    readings.forEach((item) => {
      const point = pointById.get(item.pointId)
      const key = `${patrolId}:${item.pointId}`
      values[key] = item.value
      if (point) {
        // 合并时以当前标准重开，若与载荷时的标准不同则天然进入待复核
        meta[key] = {
          ...standardOfPoint(point),
          standardVersionId: point.currentVersionId,
          standardVersionNo: point.currentVersionNo,
          reviewState: '无'
        }
      }
    })
    set({ readingDraft: values, readingDraftMeta: meta })
    persistDrafts(values, meta)
  },

  async saveReadingDrafts(patrolId, points) {
    const draftValues = get().readingDraft
    const draftMeta = get().readingDraftMeta
    const existing = get().readings.filter((reading) => reading.patrolId === patrolId)
    const now = Date.now()
    const payload: ReadingRow[] = []
    points.forEach((point) => {
      const key = `${patrolId}:${point.id}`
      const value = draftValues[key]
      if (value === undefined || !Number.isFinite(value)) return
      const found = existing.find((reading) => reading.pointId === point.id)
      const meta = draftMeta[key]
      const pending = meta ? meta.standardVersionId !== point.currentVersionId : false
      // 待复核草稿：保留原判定快照，落库仍为待复核，等待人工处理
      const force =
        pending && meta
          ? {
              standardMin: meta.standardMin,
              standardMax: meta.standardMax,
              standardUnit: meta.standardUnit,
              isCritical: meta.isCritical,
              standardVersionId: meta.standardVersionId,
              standardVersionNo: meta.standardVersionNo
            }
          : undefined
      const standard = standardOfPoint(point)
      const judgement = force
        ? judgeByStandard(value, force)
        : judgeByStandard(value, standard)
      payload.push({
        id: found ? found.id : createId('rd'),
        patrolId,
        pointId: point.id,
        value,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        note: found ? found.note : '',
        standardMin: force ? force.standardMin : standard.standardMin,
        standardMax: force ? force.standardMax : standard.standardMax,
        standardUnit: force ? force.standardUnit : standard.standardUnit,
        isCritical: force ? force.isCritical : standard.isCritical,
        standardVersionId: force ? force.standardVersionId : point.currentVersionId,
        standardVersionNo: force ? force.standardVersionNo : point.currentVersionNo,
        reviewState: pending ? '待复核' : '无',
        createdAt: found ? found.createdAt : now,
        updatedAt: now,
        revision: found ? nextRevision(found.revision) : 2
      })
    })
    if (payload.length > 0) await db.readings.bulkPut(payload)
    return payload.length
  },

  async saveSingleReading(patrolId, point, value, note, options) {
    const now = Date.now()
    const found = get().readings.find((reading) => reading.patrolId === patrolId && reading.pointId === point.id)
    // 仅改备注且要求保留历史口径：沿用原快照，判定结果不变
    const forceStandard =
      options?.preserveStandard && found
        ? {
            standardMin: found.standardMin,
            standardMax: found.standardMax,
            standardUnit: found.standardUnit,
            isCritical: found.isCritical,
            standardVersionId: found.standardVersionId,
            standardVersionNo: found.standardVersionNo
          }
        : undefined
    await putReading({
      id: found ? found.id : createId('rd'),
      patrolId,
      pointId: point.id,
      value,
      note,
      createdAt: found ? found.createdAt : now,
      updatedAt: now,
      forceStandard,
      reviewState: found && forceStandard ? found.reviewState : undefined
    })
  },

  async reviewReadingWithCurrent(readingId, point) {
    const reading = get().readings.find((item) => item.id === readingId)
    if (!reading) return
    const standard = standardOfPoint(point)
    const judgement = judgeByStandard(reading.value, standard)
    await db.readings.update(readingId, {
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      standardMin: standard.standardMin,
      standardMax: standard.standardMax,
      standardUnit: standard.standardUnit,
      isCritical: standard.isCritical,
      standardVersionId: point.currentVersionId,
      standardVersionNo: point.currentVersionNo,
      reviewState: '无',
      updatedAt: Date.now()
    })
  },

  async keepReadingJudgement(readingId) {
    const reading = get().readings.find((item) => item.id === readingId)
    if (!reading) return
    // 维持原判定：读数自身的 isAbnormal / deviationPct / 标准快照不动，仅解除待复核
    await db.readings.update(readingId, { reviewState: '无', updatedAt: Date.now() })
  },

  reviewDraftWithCurrent(patrolId, point) {
    const key = `${patrolId}:${point.id}`
    const standard = standardOfPoint(point)
    const meta: ReadingDraftMeta = {
      ...standard,
      standardVersionId: point.currentVersionId,
      standardVersionNo: point.currentVersionNo,
      reviewState: '无'
    }
    set((state) => {
      const metaMap = { ...state.readingDraftMeta, [key]: meta }
      persistDrafts(state.readingDraft, metaMap)
      return { readingDraftMeta: metaMap }
    })
  },

  keepDraftJudgement(patrolId, point) {
    const key = `${patrolId}:${point.id}`
    set((state) => {
      const old = state.readingDraftMeta[key]
      if (!old) return state
      // 维持原判定：版本保持旧版本，但待复核标记在草稿层面解除（保存时按旧快照冻结）
      const metaMap = {
        ...state.readingDraftMeta,
        [key]: { ...old, reviewState: '无' as const }
      }
      persistDrafts(state.readingDraft, metaMap)
      return { readingDraftMeta: metaMap }
    })
    void point
  },

  isDraftPending(patrolId, pointId) {
    const key = `${patrolId}:${pointId}`
    const point = useStationStore.getState().points.find((item) => item.id === pointId)
    const meta = get().readingDraftMeta[key]
    if (!point || !meta) return false
    return meta.standardVersionId !== point.currentVersionId
  },

  async removeReading(id) {
    await db.readings.delete(id)
  },

  judge(point, value) {
    return judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
  },

  judgeReadingRow(reading) {
    return judgeByStandard(reading.value, {
      standardMin: reading.standardMin,
      standardMax: reading.standardMax,
      standardUnit: reading.standardUnit,
      isCritical: reading.isCritical
    })
  },

  readingsOfPatrol(patrolId) {
    return get().readings.filter((reading) => reading.patrolId === patrolId)
  },

  pendingReviewCountOf(patrolId, points) {
    const saved = get()
      .readings.filter((reading) => reading.patrolId === patrolId && reading.reviewState === '待复核')
      .length
    const currentIds = new Set(points.map((point) => point.currentVersionId))
    let draftPending = 0
    points.forEach((point) => {
      const key = `${patrolId}:${point.id}`
      const value = get().readingDraft[key]
      const meta = get().readingDraftMeta[key]
      if (value !== undefined && meta && !currentIds.has(meta.standardVersionId)) draftPending += 1
    })
    return saved + draftPending
  },

  abnormalRows() {
    const points = useStationStore.getState().points
    return get()
      .readings.filter((reading) => reading.isAbnormal)
      .map((reading) => {
        const point = points.find((item) => item.id === reading.pointId) ?? null
        const patrol = get().patrols.find((item) => item.id === reading.patrolId) ?? null
        // 历史读数按其自带的当时标准分级，而不是点位现行标准
        const level: AbnormalLevel = point
          ? abnormalLevelOf(reading.deviationPct, reading.isCritical ?? point.isCritical)
          : '轻微超标'
        return {
          reading,
          patrol,
          point,
          level,
          weight: point ? abnormalWeight(level, reading.isCritical ?? point.isCritical) : 20
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

export { abnormalLevelOf }
