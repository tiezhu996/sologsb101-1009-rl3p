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
  writeUiPrefs,
  type DeviceRow,
  type PointRow,
  type StandardVersionRow,
  type StationRow
} from '@/utils/db'
import { initialVersionId } from '@/types/standard'
import {
  isStandardChanged,
  listStandardVersions,
  normalizeChange,
  publishStandardVersion,
  publishStandardVersions,
  type StandardChange
} from '@/utils/standards'
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
  /** 更新点位；标准字段变化时发布新版本（不回改历史），其余字段普通更新 */
  updatePoint: (id: string, patch: Partial<PointDraft>, reason?: string) => Promise<{ point: Point; pendingReadings: number } | null>
  removePoint: (id: string) => Promise<void>
  applyTemplate: (deviceId: string, templates: PointTemplate[]) => Promise<number>
  setStandardDraft: (pointId: string, draft: StandardDraft) => void
  clearStandardDraft: (pointId?: string) => void
  /** 提交单个点位标准草稿 → 追加标准版本；返回待复核读数条数 */
  commitStandardDraft: (pointId: string, reason?: string) => Promise<{ point: Point; pendingReadings: number } | null>
  /** 批量提交标准草稿；返回发布版本数与待复核读数总数 */
  commitAllStandardDrafts: (reason?: string) => Promise<{ versionCount: number; pendingReadings: number }>
  listPointVersions: (pointId: string) => Promise<StandardVersionRow[]>
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
    const id = createId('pt')
    const min = Math.min(Number(draft.standardMin) || 0, Number(draft.standardMax) || 0)
    const max = Math.max(Number(draft.standardMin) || 0, Number(draft.standardMax) || 0)
    const row: PointRow = {
      id,
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      name: draft.name.trim(),
      standardMin: min,
      standardMax: max > min ? max : min + 0.001,
      unit: draft.unit,
      isCritical: draft.isCritical,
      currentVersionId: initialVersionId(id),
      currentVersionNo: 1,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.points, db.standardVersions], async () => {
      await db.points.put(row)
      // 新建点位自带 v1 不可变初始版本
      await db.standardVersions.put({
        id: initialVersionId(id),
        pointId: id,
        versionNo: 1,
        standardMin: row.standardMin,
        standardMax: row.standardMax,
        standardUnit: row.unit,
        isCritical: row.isCritical,
        reason: '初始标准',
        createdAt: now
      })
    })
    return row
  },

  async updatePoint(id, patch, reason = '调压站升级') {
    const point = await db.points.get(id)
    if (!point) return null
    const next: Partial<PointRow> = { updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.unit !== undefined) next.unit = patch.unit
    if (patch.deviceId !== undefined) {
      const device = await db.devices.get(patch.deviceId)
      if (device) next.stationId = device.stationId
    }
    const touchesStandard =
      patch.standardMin !== undefined || patch.standardMax !== undefined || patch.isCritical !== undefined
    if (touchesStandard) {
      const normalized = normalizeChange(point, {
        standardMin: patch.standardMin ?? point.standardMin,
        standardMax: patch.standardMax ?? point.standardMax,
        isCritical: patch.isCritical ?? point.isCritical
      })
      if (isStandardChanged(point, normalized)) {
        const result = await publishStandardVersion({ pointId: id, ...normalized }, reason)
        // 非标准字段（改名 / 调设备 / 单位）在版本事务之外补一次普通更新
        const plainPatch: Partial<PointRow> = {}
        if (next.name !== undefined) plainPatch.name = next.name
        if (next.unit !== undefined) plainPatch.unit = next.unit
        if (next.stationId !== undefined) plainPatch.stationId = next.stationId
        if (Object.keys(plainPatch).length > 0) await db.points.update(id, plainPatch)
        if (result) {
          const fresh = await db.points.get(id)
          return fresh ? { point: fresh, pendingReadings: result.pendingReadings } : null
        }
      }
    }
    // 不涉及标准变化：普通字段更新，历史读数维持原快照，无需重算
    const plainPatch: Partial<PointRow> = { ...next }
    delete plainPatch.standardMin
    delete plainPatch.standardMax
    delete plainPatch.isCritical
    if (Object.keys(plainPatch).length > 0) await db.points.update(id, plainPatch)
    const fresh = await db.points.get(id)
    return fresh ? { point: fresh, pendingReadings: 0 } : null
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
    const chosen = templates.filter((template) => !existing.includes(template.name))
    const rows: PointRow[] = chosen.map((template, index) => {
      const id = createId('pt')
      return {
        id,
        deviceId,
        stationId,
        name: template.name,
        standardMin: template.standardMin,
        standardMax: template.standardMax,
        unit: template.unit,
        isCritical: template.isCritical,
        currentVersionId: initialVersionId(id),
        currentVersionNo: 1,
        createdAt: now + index,
        updatedAt: now + index
      }
    })
    if (rows.length > 0) {
      await db.transaction('rw', [db.points, db.standardVersions], async () => {
        await db.points.bulkPut(rows)
        await db.standardVersions.bulkPut(
          rows.map((row) => ({
            id: initialVersionId(row.id),
            pointId: row.id,
            versionNo: 1,
            standardMin: row.standardMin,
            standardMax: row.standardMax,
            standardUnit: row.unit,
            isCritical: row.isCritical,
            reason: '初始标准',
            createdAt: row.createdAt
          }))
        )
      })
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

  async commitStandardDraft(pointId, reason = '调压站升级') {
    const point = get().points.find((item) => item.id === pointId)
    const draft = get().standardDraft[pointId]
    if (!point || !draft) return null
    const normalized = normalizeChange(point, draft)
    if (!isStandardChanged(point, normalized)) {
      get().clearStandardDraft(pointId)
      return { point, pendingReadings: 0 }
    }
    const result = await publishStandardVersion({ pointId, ...normalized }, reason)
    get().clearStandardDraft(pointId)
    if (!result) return { point, pendingReadings: 0 }
    const fresh = get().points.find((item) => item.id === pointId) ?? point
    return { point: fresh, pendingReadings: result.pendingReadings }
  },

  async commitAllStandardDrafts(reason = '调压站升级') {
    const entries = Object.entries(get().standardDraft)
    if (entries.length === 0) return { versionCount: 0, pendingReadings: 0 }
    const changes: StandardChange[] = []
    entries.forEach(([id, draft]) => {
      const point = get().points.find((item) => item.id === id)
      if (!point) return
      const normalized = normalizeChange(point, draft)
      if (isStandardChanged(point, normalized)) changes.push({ pointId: id, ...normalized })
    })
    const published = await publishStandardVersions(changes, reason)
    get().clearStandardDraft()
    return {
      versionCount: published.length,
      pendingReadings: published.reduce((sum, result) => sum + result.pendingReadings, 0)
    }
  },

  async listPointVersions(pointId) {
    return listStandardVersions(pointId)
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
