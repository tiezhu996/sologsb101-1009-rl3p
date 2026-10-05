/**
 * 站点、设备与点位状态（Zustand）
 * 维护站点/设备/点位列表、当前选中站点与筛选条件（点位作为设备的标准值档案一并维护）。
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createId,
  db,
  deleteDeviceCascade,
  deletePointCascade,
  deleteStationCascade,
  readUiPrefs,
  recalculateReadingsOfPoint,
  writeUiPrefs,
  type DeviceRow,
  type PointRow,
  type StationRow
} from '@/utils/db'
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
  commitStandardDraft: (pointId: string) => Promise<void>
  commitAllStandardDrafts: () => Promise<number>
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
      createdAt: now,
      updatedAt: now
    }
    await db.points.put(row)
    return row
  },

  async updatePoint(id, patch) {
    const next: Partial<PointRow> = { ...patch, updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.deviceId !== undefined) {
      const device = await db.devices.get(patch.deviceId)
      if (device) next.stationId = device.stationId
    }
    await db.points.update(id, next)
    await recalculateReadingsOfPoint(id)
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
        createdAt: now,
        updatedAt: now
      }))
    if (rows.length > 0) await db.points.bulkPut(rows)
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

  async commitStandardDraft(pointId) {
    const draft = get().standardDraft[pointId]
    if (!draft) return
    const min = Math.min(draft.standardMin, draft.standardMax)
    const max = Math.max(draft.standardMin, draft.standardMax)
    await db.points.update(pointId, {
      standardMin: min,
      standardMax: max > min ? max : min + 0.001,
      isCritical: draft.isCritical,
      updatedAt: Date.now()
    })
    get().clearStandardDraft(pointId)
    await recalculateReadingsOfPoint(pointId)
  },

  async commitAllStandardDrafts() {
    const entries = Object.entries(get().standardDraft)
    if (entries.length === 0) return 0
    const rows = get()
      .points.filter((point) => entries.some(([id]) => id === point.id))
      .map((point) => {
        const draft = get().standardDraft[point.id]
        const min = Math.min(draft.standardMin, draft.standardMax)
        const max = Math.max(draft.standardMin, draft.standardMax)
        return {
          ...point,
          standardMin: min,
          standardMax: max > min ? max : min + 0.001,
          isCritical: draft.isCritical,
          updatedAt: Date.now()
        }
      })
    if (rows.length > 0) await db.points.bulkPut(rows)
    get().clearStandardDraft()
    for (const row of rows) {
      await recalculateReadingsOfPoint(row.id)
    }
    return rows.length
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
