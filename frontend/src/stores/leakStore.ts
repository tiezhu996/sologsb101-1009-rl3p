/**
 * 泄漏处置状态（Zustand）
 * 维护处置单状态机、复检值与闭环统计。
 *
 * 追溯口径：处置单创建时冻结当时浓度点位标准（版本号 / 上下限 / 关键点），
 * 后续标准更新不改判历史处置单；复检合格阈值仍按固定 50 ppm 口径。
 *
 * 并发口径：advance / submitRetest / 编辑提交走 revision 乐观锁，
 * 两个标签页并发时先写入者生效，败方完整载荷由页面层留作待合并。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, nextRevision, standardOfPoint, type LeakRow } from '@/utils/db'
import { RevisionConflict } from '@/utils/conflict'
import {
  LEAK_RETEST_PASS_PPM,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'

export type LeakCommitResult =
  | { outcome: 'committed'; leak: LeakRow }
  | { outcome: 'conflict'; expectedRevision: number; currentRevision: number }

interface LeakState_ {
  leaks: LeakRow[]
  stateFilter: LeakState[]
  stationId: string
  onlyOpen: boolean
  ready: boolean
  patchFilter: (patch: { stateFilter?: LeakState[]; stationId?: string; onlyOpen?: boolean }) => void
  resetFilter: () => void
  createLeak: (draft: LeakDraft) => Promise<Leak>
  /** 编辑提交（乐观锁） */
  updateLeak: (id: string, patch: Partial<LeakDraft>, expectedRevision: number) => Promise<LeakCommitResult>
  removeLeak: (id: string) => Promise<void>
  /** 状态推进（乐观锁） */
  advance: (
    id: string,
    expectedRevision: number,
    params?: { handler?: string; measure?: string }
  ) => Promise<LeakCommitResult | { outcome: 'noop' }>
  /** 录入复检（乐观锁） */
  submitRetest: (
    id: string,
    expectedRevision: number,
    retestValuePpm: number,
    handler: string
  ) => Promise<(LeakCommitResult & { passed?: boolean }) | { outcome: 'noop' }>
  hasLeakOfDevice: (deviceId: string) => boolean
  createFromAbnormal: (payload: {
    deviceId: string
    stationId: string
    concentrationPpm: number
    foundTime: string
    measure: string
    /** 来源浓度点位（冻结当时标准） */
    point?: { standardMin: number; standardMax: number; unit: string; isCritical: boolean; currentVersionId: string; currentVersionNo: number }
    sourceReadingId?: string
  }) => Promise<Leak>
  counts: () => Record<LeakState, number>
  closedPercent: () => number
  retestPassCount: () => number
  filteredLeaks: () => LeakRow[]
}

/** 手工新建处置单的默认浓度标准（找不到 ppm 点位时） */
function fallbackPpmStandard() {
  return { standardMin: 0, standardMax: LEAK_RETEST_PASS_PPM, standardUnit: 'ppm', isCritical: true, standardVersionId: '', standardVersionNo: 0 }
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
    // 手工新建：尝试取该设备上的浓度点位冻结当时标准，找不到则用默认 0~50 ppm
    const ppmPoint = await db.points.where('deviceId').equals(draft.deviceId).first()
    const standard = ppmPoint
      ? {
          ...standardOfPoint(ppmPoint),
          standardVersionId: ppmPoint.currentVersionId,
          standardVersionNo: ppmPoint.currentVersionNo
        }
      : fallbackPpmStandard()
    const now = Date.now()
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
      sourceReadingId: '',
      ...standard,
      createdAt: now,
      updatedAt: now
    }
    await db.leaks.put(row)
    return row
  },

  async updateLeak(id, patch, expectedRevision) {
    try {
      const result = await db.transaction('rw', db.leaks, async () => {
        const current = await db.leaks.get(id)
        if (!current) throw new Error('处置单不存在')
        const currentRev = typeof current.revision === 'number' ? current.revision : 0
        if (currentRev !== expectedRevision) throw new RevisionConflict(expectedRevision, currentRev)
        const next: LeakRow = {
          ...current,
          ...patch,
          measure: patch.measure !== undefined ? patch.measure.trim() : current.measure,
          handler: patch.handler !== undefined ? patch.handler.trim() : current.handler,
          // 历史快照不随编辑改判：未提供的标准字段一律沿用原值
          standardMin: current.standardMin,
          standardMax: current.standardMax,
          standardUnit: current.standardUnit,
          isCritical: current.isCritical,
          standardVersionId: current.standardVersionId,
          standardVersionNo: current.standardVersionNo,
          sourceReadingId: current.sourceReadingId,
          updatedAt: Date.now(),
          revision: nextRevision(currentRev)
        }
        await db.leaks.put(next)
        return next
      })
      return { outcome: 'committed', leak: result }
    } catch (error) {
      if (error instanceof RevisionConflict) {
        return { outcome: 'conflict', expectedRevision, currentRevision: error.currentRevision }
      }
      throw error
    }
  },

  async removeLeak(id) {
    await db.leaks.delete(id)
  },

  async advance(id, expectedRevision, params) {
    const leak = get().leaks.find((item) => item.id === id)
    if (!leak) return { outcome: 'noop' as const }
    const nextState: LeakState | null = leak.state === '待处置' ? '已处置' : leak.state === '已处置' ? '已复检' : null
    if (!nextState) return { outcome: 'noop' as const }
    return get().updateLeak(
      id,
      {
        state: nextState,
        ...(params?.handler !== undefined ? { handler: params.handler } : {}),
        ...(params?.measure !== undefined ? { measure: params.measure } : {})
      },
      expectedRevision
    )
  },

  async submitRetest(id, expectedRevision, retestValuePpm, handler) {
    const value = Number(retestValuePpm) || 0
    const result = await get().updateLeak(
      id,
      { state: '已复检', retestValuePpm: value, handler: handler.trim() || '未署名' },
      expectedRevision
    )
    if (result.outcome === 'committed') return { ...result, passed: retestPassed(value) }
    return result
  },

  hasLeakOfDevice(deviceId) {
    return get().leaks.some((leak) => leak.deviceId === deviceId)
  },

  async createFromAbnormal(payload) {
    const standard = payload.point
      ? {
          standardMin: payload.point.standardMin,
          standardMax: payload.point.standardMax,
          standardUnit: payload.point.unit,
          isCritical: payload.point.isCritical,
          standardVersionId: payload.point.currentVersionId,
          standardVersionNo: payload.point.currentVersionNo
        }
      : fallbackPpmStandard()
    const device = await db.devices.get(payload.deviceId)
    const now = Date.now()
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: payload.deviceId,
      stationId: device ? device.stationId : payload.stationId,
      concentrationPpm: Number(payload.concentrationPpm) || 0,
      foundTime: payload.foundTime,
      measure: payload.measure.trim(),
      state: '待处置',
      retestValuePpm: 0,
      handler: '',
      sourceReadingId: payload.sourceReadingId ?? '',
      ...standard,
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
