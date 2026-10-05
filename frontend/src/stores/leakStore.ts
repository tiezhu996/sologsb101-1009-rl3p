/**
 * 泄漏处置状态（Zustand）
 * 维护处置单状态机、复检值与闭环统计。
 * - 创建时冻结当时浓度标准快照，后来的标准不能改判历史处置单
 * - 推进 / 复检 / 编辑走行版本号乐观锁，冲突载荷完整进入待合并队列
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, commitWithRevision, db, latestStandardOf, type LeakRow } from '@/utils/db'
import { captureSubmitFailure } from '@/stores/mergeStore'
import {
  LEAK_RETEST_PASS_PPM,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'
import type { LeakMergePayload } from '@/types/merge'

export type LeakCommitOutcome =
  | { status: 'saved'; passed?: boolean }
  | { status: 'conflict' }
  | { status: 'failed' }

interface LeakState_ {
  leaks: Leak[]
  stateFilter: LeakState[]
  stationId: string
  onlyOpen: boolean
  ready: boolean
  patchFilter: (patch: { stateFilter?: LeakState[]; stationId?: string; onlyOpen?: boolean }) => void
  resetFilter: () => void
  createLeak: (draft: LeakDraft) => Promise<Leak>
  /** 乐观锁更新；冲突入待合并，写入失败入本地待恢复 */
  updateLeak: (id: string, patch: Partial<LeakDraft>, expectedRevision?: number) => Promise<LeakCommitOutcome>
  removeLeak: (id: string) => Promise<void>
  advance: (
    id: string,
    params?: { handler?: string; measure?: string },
    expectedRevision?: number
  ) => Promise<{ state: LeakState | null; outcome: LeakCommitOutcome }>
  submitRetest: (
    id: string,
    retestValuePpm: number,
    handler: string,
    expectedRevision?: number
  ) => Promise<LeakCommitOutcome & { passed: boolean }>
  hasLeakOfDevice: (deviceId: string) => boolean
  createFromAbnormal: (payload: {
    deviceId: string
    stationId: string
    concentrationPpm: number
    foundTime: string
    measure: string
    /** 派发来源读数点位（冻结其当时标准） */
    pointId?: string
    standardVersion?: number
  }) => Promise<Leak>
  counts: () => Record<LeakState, number>
  closedPercent: () => number
  retestPassCount: () => number
  filteredLeaks: () => Leak[]
}

/** 组装泄漏单的泄漏更新载荷 */
function leakPatchPayload(leakId: string, patch: Partial<LeakDraft>, advanceTo: LeakState | null): LeakMergePayload {
  return { kind: 'leak', leakId, patch, advanceTo }
}

async function snapshotForLeak(pointId: string | undefined, version: number | undefined) {
  if (!pointId) {
    return {
      pointId: '',
      version: version ?? 1,
      standardMin: 0,
      standardMax: LEAK_RETEST_PASS_PPM,
      unit: 'ppm',
      isCritical: true,
      effectiveAt: Date.now(),
      reason: '泄漏浓度兜底标准（≤50ppm）'
    }
  }
  try {
    const standard = await latestStandardOf(pointId, version)
    return {
      pointId: standard.pointId,
      version: standard.version,
      standardMin: standard.standardMin,
      standardMax: standard.standardMax,
      unit: standard.unit,
      isCritical: standard.isCritical,
      effectiveAt: standard.effectiveAt,
      reason: standard.reason
    }
  } catch {
    return {
      pointId,
      version: version ?? 1,
      standardMin: 0,
      standardMax: LEAK_RETEST_PASS_PPM,
      unit: 'ppm',
      isCritical: true,
      effectiveAt: Date.now(),
      reason: '泄漏浓度兜底标准（≤50ppm）'
    }
  }
}

export const useLeakStore = create<LeakState_>((set, get) => ({
  leaks: [],
  stateFilter: [],
  stationId: '',
  onlyOpen: false,
  ready: false,

  patchFilter(patch) {
    set({
      stateFilter: patch.stateFilter ?? get().stateFilter,
      stationId: patch.stationId ?? get().stationId,
      onlyOpen: patch.onlyOpen ?? get().onlyOpen
    })
  },

  resetFilter() {
    set({ stateFilter: [], stationId: '', onlyOpen: false })
  },

  async createLeak(draft) {
    const device = await db.devices.get(draft.deviceId)
    const now = Date.now()
    // 手工新建处置单：取该设备 ppm 点位当前标准作为快照依据
    const ppmPoint = device
      ? (
          await db.points
            .where('deviceId')
            .equals(draft.deviceId)
            .toArray()
        ).find((point) => point.unit === 'ppm')
      : undefined
    const standardSnapshot = ppmPoint
      ? await snapshotForLeak(ppmPoint.id, ppmPoint.standardVersion)
      : await snapshotForLeak(undefined, undefined)
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      concentrationPpm: Number(draft.concentrationPpm) || 0,
      foundTime: draft.foundTime,
      measure: draft.measure.trim(),
      state: draft.state,
      retestValuePpm: Number(draft.retestValuePpm) || 0,
      handler: draft.handler.trim(),
      standardSnapshot,
      createdAt: now,
      updatedAt: now
    }
    await db.leaks.put(row)
    return row
  },

  async updateLeak(id, patch, expectedRevision) {
    const leak = get().leaks.find((item) => item.id === id)
    const base = expectedRevision ?? (leak as LeakRow | undefined)?.revision ?? 2
    const next: Partial<LeakRow> = { ...patch }
    if (patch.measure !== undefined) next.measure = patch.measure.trim()
    if (patch.handler !== undefined) next.handler = patch.handler.trim()
    try {
      await commitWithRevision(db.leaks, id, next, base)
      return { status: 'saved' }
    } catch (error) {
      const outcome = await captureSubmitFailure({
        error,
        type: 'leak',
        targetId: id,
        baseRevision: base,
        payload: leakPatchPayload(id, patch, null)
      })
      return { status: outcome === 'merged' ? 'conflict' : 'failed' }
    }
  },

  async removeLeak(id) {
    await db.leaks.delete(id)
  },

  async advance(id, params, expectedRevision) {
    const leak = get().leaks.find((item) => item.id === id)
    if (!leak) return { state: null, outcome: { status: 'failed' } as LeakCommitOutcome }
    const next: LeakState | null = leak.state === '待处置' ? '已处置' : leak.state === '已处置' ? '已复检' : null
    if (!next) return { state: null, outcome: { status: 'saved' } }
    const base = expectedRevision ?? (leak as LeakRow).revision ?? 2
    const patch: Partial<LeakRow> = { state: next }
    if (params?.handler !== undefined) patch.handler = params.handler.trim()
    if (params?.measure !== undefined) patch.measure = params.measure.trim()
    try {
      await commitWithRevision(db.leaks, id, patch, base)
      return { state: next, outcome: { status: 'saved' } }
    } catch (error) {
      const outcome = await captureSubmitFailure({
        error,
        type: 'leak',
        targetId: id,
        baseRevision: base,
        payload: leakPatchPayload(
          id,
          {
            ...(params?.handler !== undefined ? { handler: params.handler } : {}),
            ...(params?.measure !== undefined ? { measure: params.measure } : {})
          },
          next
        )
      })
      return { state: next, outcome: { status: outcome === 'merged' ? 'conflict' : 'failed' } }
    }
  },

  async submitRetest(id, retestValuePpm, handler, expectedRevision) {
    const leak = get().leaks.find((item) => item.id === id)
    const base = expectedRevision ?? (leak as LeakRow | undefined)?.revision ?? 2
    const value = Number(retestValuePpm) || 0
    const patch: Partial<LeakRow> = {
      state: '已复检',
      retestValuePpm: value,
      handler: handler.trim() || '未署名'
    }
    const passed = retestPassed(value)
    try {
      await commitWithRevision(db.leaks, id, patch, base)
      return { status: 'saved', passed }
    } catch (error) {
      const outcome = await captureSubmitFailure({
        error,
        type: 'leak',
        targetId: id,
        baseRevision: base,
        payload: leakPatchPayload(id, { retestValuePpm: value, handler: handler.trim() || '未署名' }, '已复检')
      })
      return { status: outcome === 'merged' ? 'conflict' : 'failed', passed }
    }
  },

  hasLeakOfDevice(deviceId) {
    return get().leaks.some((leak) => leak.deviceId === deviceId)
  },

  async createFromAbnormal(payload) {
    const device = await db.devices.get(payload.deviceId)
    const now = Date.now()
    const standardSnapshot = await snapshotForLeak(payload.pointId, payload.standardVersion)
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: payload.deviceId,
      stationId: payload.stationId || (device ? device.stationId : ''),
      concentrationPpm: Number(payload.concentrationPpm) || 0,
      foundTime: payload.foundTime,
      measure: payload.measure.trim(),
      state: '待处置',
      retestValuePpm: 0,
      handler: '',
      standardSnapshot,
      createdAt: now,
      updatedAt: now
    }
    await db.leaks.put(row)
    return row
  },

  counts() {
    const counts: Record<LeakState, number> = { 待处置: 0, 已处置: 0, 已复检: 0 }
    get().leaks.forEach((leak) => {
      counts[leak.state] += 1
    })
    return counts
  },

  closedPercent() {
    const { leaks } = get()
    if (leaks.length === 0) return 0
    const closed = leaks.filter((leak) => leak.state === '已复检').length
    return Math.round((closed / leaks.length) * 100)
  },

  retestPassCount() {
    return get().leaks.filter((leak) => leak.state === '已复检' && retestPassed(leak.retestValuePpm)).length
  },

  filteredLeaks() {
    const { leaks, stateFilter, stationId, onlyOpen } = get()
    return leaks
      .filter((leak) => {
        if (stationId && leak.stationId !== stationId) return false
        if (stateFilter.length > 0 && !stateFilter.includes(leak.state)) return false
        if (onlyOpen && leak.state === '已复检') return false
        return true
      })
      .sort((a, b) => b.foundTime.localeCompare(a.foundTime))
  }
}))

liveQuery(async () => (await db.leaks.toArray()).sort((a, b) => b.foundTime.localeCompare(a.foundTime))).subscribe({
  next: (rows) => useLeakStore.setState({ leaks: rows, ready: true }),
  error: () => useLeakStore.setState({ ready: true })
})

export { LEAK_RETEST_PASS_PPM }
