/**
 * 站点、设备与点位状态（Zustand）
 * 维护站点/设备/点位列表、当前选中站点与筛选条件（点位作为设备的标准值档案一并维护）。
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  commitPointStandard,
  createId,
  db,
  deleteDeviceCascade,
  deletePointCascade,
  deleteStationCascade,
  establishPointStandard,
  nextRevision,
  readUiPrefs,
  writeUiPrefs,
  type DeviceRow,
  type PointRow,
  type StationRow
} from '@/utils/db'
import { markDraftsForReview } from '@/utils/localDraft'
import type { Device, DeviceDraft, DeviceState, DeviceType } from '@/types/device'
import type { Point, PointDraft, PointFilterState, PointTemplate, StandardDraft } from '@/types/point'
import { createEmptyPointFilter } from '@/types/point'
import type { Station, StationDraft, StationGrade } from '@/types/station'

export interface StationFilterState {
  keyword: string
  grades: StationGrade[]
  deviceTypes: DeviceType[]
}

export function createEmptyStationFilter(): StationFilterState {
  return { keyword: '', grades: [], deviceTypes: [] }
}

interface StationState {
  stations: Station[]
  devices: Device[]
  points: Point[]
  currentStationId: string | null
  filter: StationFilterState
  pointFilter: PointFilterState
  /** 标准值编辑草稿：点位 id → 待提交的上下限 */
  standardDraft: Record<string, StandardDraft>
  ready: boolean
  selectStation: (id: string | null) => void
  patchFilter: (patch: Partial<StationFilterState>) => void
  resetFilter: () => void
  patchPointFilter: (patch: Partial<PointFilterState>) => void
  resetPointFilter: () => void
  createStation: (draft: StationDraft) => Promise<Station>
  updateStation: (id: string, patch: Partial<StationDraft>) => Promise<void>
  removeStation: (id: string) => Promise<void>
  createDevice: (draft: DeviceDraft) => Promise<Device>
  updateDevice: (id: string, patch: Partial<DeviceDraft>) => Promise<void>
  removeDevice: (id: string) => Promise<void>
  createPoint: (draft: PointDraft) => Promise<Point>
  updatePoint: (id: string, patch: Partial<PointDraft>) => Promise<void>
  removePoint: (id: string) => Promise<void>
  applyTemplate: (deviceId: string, templates: PointTemplate[]) => Promise<number>
  setStandardDraft: (pointId: string, draft: StandardDraft) => void
  clearStandardDraft: (pointId?: string) => void
  /**
   * 提交单个点位的标准新版本：
   * 写入可追溯版本档案；不重算历史读数；把依据旧版本的巡检草稿标为待复核。
   */
  commitStandardVersion: (
    pointId: string,
    draft: StandardDraft
  ) => Promise<{ version: number; reviewCount: number }>
  /** 兼容旧调用名 */
  commitStandardDraft: (pointId: string) => Promise<void>
  /** 批量提交标准草稿（统一一个变更原因） */
  commitAllStandardDrafts: (reason?: string) => Promise<number>
  /** 查询点位标准版本档案 */
  standardHistory: (pointId: string) => Promise<import('@/types/point').PointStandardVersion[]>
  devicesOfStation: (stationId: string) => Device[]
  pointsOfDevice: (deviceId: string) => Point[]
  currentStation: () => Station | null
  filteredStations: () => Station[]
  pointStats: () => { total: number; critical: number }
}

export const useStationStore = create<StationState>((set, get) => ({
  stations: [],
  devices: [],
  points: [],
  currentStationId: readUiPrefs().lastStationId,
  filter: createEmptyStationFilter(),
  pointFilter: createEmptyPointFilter(),
  standardDraft: {},
  ready: false,

  selectStation(id) {
    set({ currentStationId: id })
    writeUiPrefs({ ...readUiPrefs(), lastStationId: id })
  },

  patchFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  resetFilter() {
    set({ filter: createEmptyStationFilter() })
  },

  patchPointFilter(patch) {
    set({ pointFilter: { ...get().pointFilter, ...patch } })
  },

  resetPointFilter() {
    set({ pointFilter: createEmptyPointFilter() })
  },

  async createStation(draft) {
    const now = Date.now()
    const row: StationRow = {
      id: createId('st'),
      name: draft.name.trim(),
      location: draft.location.trim(),
      designFlowM3h: Number(draft.designFlowM3h) || 0,
      inletPressureMpa: Number(draft.inletPressureMpa) || 0,
      grade: draft.grade,
      commissionDate: draft.commissionDate,
      createdAt: now,
      updatedAt: now
    }
    await db.stations.put(row)
    get().selectStation(row.id)
    return row
  },

  async updateStation(id, patch) {
    const next: Partial<StationRow> = { ...patch, updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.location !== undefined) next.location = patch.location.trim()
    await db.stations.update(id, next)
  },

  async removeStation(id) {
    await deleteStationCascade(id)
    if (get().currentStationId === id) {
      const fallback = get().stations.find((station) => station.id !== id) ?? null
      get().selectStation(fallback ? fallback.id : null)
    }
  },

  async createDevice(draft) {
    const now = Date.now()
    const row: DeviceRow = {
      id: createId('dv'),
      stationId: draft.stationId || get().currentStationId || '',
      type: draft.type,
      model: draft.model.trim(),
      serialNo: draft.serialNo.trim(),
      installDate: draft.installDate,
      state: draft.state,
      createdAt: now,
      updatedAt: now
    }
    await db.devices.put(row)
    return row
  },

  async updateDevice(id, patch) {
    const next: Partial<DeviceRow> = { ...patch, updatedAt: Date.now() }
    if (patch.model !== undefined) next.model = patch.model.trim()
    if (patch.serialNo !== undefined) next.serialNo = patch.serialNo.trim()
    await db.devices.update(id, next)
  },

  async removeDevice(id) {
    await deleteDeviceCascade(id)
  },

  async createPoint(draft) {
    const now = Date.now()
    const device = await db.devices.get(draft.deviceId)
    const row: PointRow = {
      id: createId('pt'),
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      name: draft.name.trim(),
      standardMin: Number(draft.standardMin) || 0,
      standardMax: Number(draft.standardMax) || 0,
      unit: draft.unit,
      isCritical: draft.isCritical,
      standardVersion: 1,
      createdAt: now,
      updatedAt: now
    }
    await db.points.put(row)
    await establishPointStandard(row, '新建点位基线标准')
    return row
  },

  /**
   * 更新点位非标准字段（名称/设备/单位等）。
   * 标准区间的修改必须走 commitPointStandard 形成新版本，历史读数不在此重算。
   */
  async updatePoint(id, patch) {
    const point = await db.points.get(id)
    const next: Partial<PointRow> = {
      updatedAt: Date.now(),
      revision: nextRevision(point?.revision)
    }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.unit !== undefined) next.unit = patch.unit
    if (patch.deviceId !== undefined) {
      const device = await db.devices.get(patch.deviceId)
      next.deviceId = patch.deviceId
      if (device) next.stationId = device.stationId
    }
    // 标准区间 / 关键点标记如出现在编辑表单中，按「标准升级」落新版本档案
    const standardChanged =
      point &&
      (patch.standardMin !== undefined ||
        patch.standardMax !== undefined ||
        patch.isCritical !== undefined) &&
      (point.standardMin !== Number(patch.standardMin ?? point.standardMin) ||
        point.standardMax !== Number(patch.standardMax ?? point.standardMax) ||
        point.isCritical !== (patch.isCritical ?? point.isCritical))
    if (standardChanged && point) {
      const min = Math.min(Number(patch.standardMin ?? point.standardMin), Number(patch.standardMax ?? point.standardMax))
      const max = Math.max(Number(patch.standardMin ?? point.standardMin), Number(patch.standardMax ?? point.standardMax))
      await get().commitStandardVersion(id, {
        standardMin: min,
        standardMax: max > min ? max : min + 0.001,
        isCritical: patch.isCritical ?? point.isCritical,
        reason: '点位编辑中修订标准值'
      })
      return
    }
    await db.points.update(id, next)
  },

  async removePoint(id) {
    await deletePointCascade(id)
    get().clearStandardDraft(id)
  },

  async applyTemplate(deviceId, templates) {
    const device = await db.devices.get(deviceId)
    const stationId = device ? device.stationId : ''
    const existing = get().points.filter((point) => point.deviceId === deviceId).map((point) => point.name)
    const now = Date.now()
    const rows: PointRow[] = templates
      .filter((template) => !existing.includes(template.name))
      .map((template) => ({
        id: createId('pt'),
        deviceId,
        stationId,
        name: template.name,
        standardMin: template.standardMin,
        standardMax: template.standardMax,
        unit: template.unit,
        isCritical: template.isCritical,
        standardVersion: 1,
        createdAt: now,
        updatedAt: now
      }))
    if (rows.length > 0) {
      await db.points.bulkPut(rows)
      for (const row of rows) {
        await establishPointStandard(row, '按模板建立基线标准')
      }
    }
    return rows.length
  },

  setStandardDraft(pointId, draft) {
    set({ standardDraft: { ...get().standardDraft, [pointId]: draft } })
  },

  clearStandardDraft(pointId) {
    if (pointId === undefined) {
      set({ standardDraft: {} })
      return
    }
    const next = { ...get().standardDraft }
    delete next[pointId]
    set({ standardDraft: next })
  },

  async commitStandardVersion(pointId, draft) {
    const min = Math.min(draft.standardMin, draft.standardMax)
    const max = Math.max(draft.standardMin, draft.standardMax)
    const { standard } = await commitPointStandard({
      pointId,
      standardMin: min,
      standardMax: max > min ? max : min + 0.001,
      isCritical: draft.isCritical,
      reason: draft.reason ?? '点位标准值修订'
    })
    get().clearStandardDraft(pointId)
    // 新标准只管尚未提交的巡检：仅未完成巡检的旧草稿标待复核（保留原值与差异）
    const openPatrols = await db.patrols.where('state').notEqual('已完成').toArray()
    const allowed = new Set(openPatrols.map((patrol) => patrol.id))
    const touched = markDraftsForReview(pointId, standard.version, allowed)
    // 通知其它标签页（storage 事件无法感知 IndexedDB，主动广播一次）
    try {
      localStorage.setItem(
        'gbgaspress:standard-bump',
        JSON.stringify({ pointId, version: standard.version, at: Date.now() })
      )
    } catch {
      /* ignore */
    }
    return { version: standard.version, reviewCount: touched.length }
  },

  async commitStandardDraft(pointId) {
    const draft = get().standardDraft[pointId]
    if (!draft) return
    await get().commitStandardVersion(pointId, draft)
  },

  async commitAllStandardDrafts(reason) {
    const entries = Object.entries(get().standardDraft)
    if (entries.length === 0) return 0
    let count = 0
    for (const [pointId, draft] of entries) {
      await get().commitStandardVersion(pointId, {
        ...draft,
        reason: draft.reason || reason || '后台批量修订标准值'
      })
      count += 1
    }
    return count
  },

  async standardHistory(pointId) {
    const list = await db.pointStandards.where('pointId').equals(pointId).toArray()
    return list.sort((a, b) => b.version - a.version)
  },

  devicesOfStation(stationId) {
    return get().devices.filter((device) => device.stationId === stationId)
  },

  pointsOfDevice(deviceId) {
    return get().points.filter((point) => point.deviceId === deviceId)
  },

  currentStation() {
    return get().stations.find((station) => station.id === get().currentStationId) ?? null
  },

  filteredStations() {
    const { stations, filter } = get()
    const text = filter.keyword.trim().toLowerCase()
    return stations.filter((station) => {
      if (filter.grades.length > 0 && !filter.grades.includes(station.grade)) return false
      if (filter.deviceTypes.length > 0) {
        const has = get().devices.some(
          (device) => device.stationId === station.id && filter.deviceTypes.includes(device.type)
        )
        if (!has) return false
      }
      if (text.length === 0) return true
      return station.name.toLowerCase().includes(text) || station.location.toLowerCase().includes(text)
    })
  },

  pointStats() {
    const points = get().points
    return { total: points.length, critical: points.filter((point) => point.isCritical).length }
  }
}))

liveQuery(async () => (await db.stations.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))).subscribe({
  next: (rows) => useStationStore.setState({ stations: rows, ready: true }),
  error: () => useStationStore.setState({ ready: true })
})

liveQuery(async () => (await db.devices.toArray()).sort((a, b) => a.serialNo.localeCompare(b.serialNo))).subscribe({
  next: (rows) => useStationStore.setState({ devices: rows })
})

liveQuery(async () =>
  (await db.points.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
).subscribe({
  next: (rows) => useStationStore.setState({ points: rows })
})

export type { DeviceState, DeviceType }
