/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 点位标准值版本档案（pointStandards）：新版本只管尚未提交的巡检，历史读数冻结当时快照
 * - 乐观并发（revision）、级联删除、整库导入导出、首屏幂等播种
 * - 待合并队列（pendingMerges）：并发提交后写入者的完整载荷留待合并
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point, PointStandardVersion } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { PendingMerge } from '@/types/merge'
import { judgeReading } from '@/utils/range'
import { RevisionConflictError } from '@/utils/conflict'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  pointStandards: PointStandardVersion[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  pendingMerges: PendingMerge[]
}

export interface Revisioned {
  revision?: number
}

/** 业务行的当前行版本基线（新建行取该值，之后每次乐观提交 +1） */
export const ROW_REVISION = 2

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type PointStandardRow = PointStandardVersion
export type PendingMergeRow = PendingMerge

/** 泄漏浓度兜底标准（找不到同设备 ppm 点位时用于冻结历史处置单） */
const FALLBACK_PPM_STANDARD = { standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true }

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  pointStandards!: Table<PointStandardRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  pendingMerges!: Table<PendingMergeRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(2).stores({
      stations: 'id, name, grade, updatedAt',
      devices: 'id, stationId, type, state, updatedAt',
      points: 'id, deviceId, stationId, name, isCritical, updatedAt',
      patrols: 'id, stationId, planDate, state, updatedAt',
      readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
      leaks: 'id, deviceId, stationId, state, handler, updatedAt'
    })

    // v3：点位标准值版本化 + 并发票据；读数/处置单冻结当时标准快照
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, standardVersion, updatedAt',
        pointStandards: 'id, pointId, version, stationId, effectiveAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt',
        pendingMerges: 'id, targetId, type, status, createdAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = ROW_REVISION
            })
        }

        // 迁移（沿用 v2）：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
            // 存量点位：当前区间即第 1 版标准
            if (typeof point.standardVersion !== 'number') point.standardVersion = 1
          })

        // 迁移（沿用 v2）：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          name: string
          stationId: string
          standardMin: number
          standardMax: number
          unit: string
          isCritical: boolean
        }>

        // 为每个存量点位补建第 1 版标准档案（可追溯）
        const now = Date.now()
        const baselineStandards = points.map((point) => ({
          id: `psv_${point.id}_v1`,
          pointId: point.id,
          pointName: point.name,
          stationId: point.stationId,
          version: 1,
          standardMin: point.standardMin,
          standardMax: point.standardMax,
          unit: point.unit,
          isCritical: point.isCritical,
          reason: '标准值版本化基线（升级前现行标准）',
          effectiveAt: now,
          basedOnVersion: 0
        }))
        await tx.table('pointStandards').bulkPut(baselineStandards)

        // 迁移：读数补 note，冻结当时标准快照（存量数据以现行区间作为判定基线）
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
              reading.standardSnapshot = {
                pointId: point.id,
                version: 1,
                standardMin: point.standardMin,
                standardMax: point.standardMax,
                unit: point.unit,
                isCritical: point.isCritical,
                effectiveAt: now,
                reason: '标准值版本化基线'
              }
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
              if (reading.standardSnapshot === undefined) reading.standardSnapshot = null
            }
          })

        // 迁移：历史泄漏处置单冻结派单当时的浓度标准（同设备 ppm 点位优先，否则用兜底阈值）
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (leak.standardSnapshot !== undefined) return
            const ownerPpm = points.find((point) => {
              const deviceId = String((point as { deviceId?: unknown }).deviceId ?? '')
              return deviceId === String(leak.deviceId) && point.unit === 'ppm'
            })
            const standard = ownerPpm ?? FALLBACK_PPM_STANDARD
            leak.standardSnapshot = {
              pointId: ownerPpm ? ownerPpm.id : '',
              version: 1,
              standardMin: standard.standardMin,
              standardMax: standard.standardMax,
              unit: 'ppm',
              isCritical: standard.isCritical,
              effectiveAt: now,
              reason: '标准值版本化基线'
            }
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 版本号 +1 */
export function nextRevision(current: number | undefined): number {
  return (typeof current === 'number' && current > 0 ? current : ROW_REVISION) + 1
}

/* ============================ 乐观并发提交 ============================ */

/**
 * 按行版本号提交更新：
 * - expectedRevision 与库中一致才写入并把 revision +1
 * - 不一致抛 RevisionConflictError，调用方转待合并队列
 * - force=true 时跳过版本检查（用户在待合并中心确认覆盖）
 * 返回提交后的最新版本号。
 */
export async function commitWithRevision<T extends Revisioned>(
  table: Table<T, string>,
  id: string,
  patch: Partial<T>,
  expectedRevision: number | undefined,
  force = false
): Promise<number> {
  return db.transaction('rw', table, async () => {
    const current = await table.get(id)
    if (!current) {
      throw new Error(`目标记录不存在：${id}`)
    }
    const currentRevision = typeof current.revision === 'number' ? current.revision : ROW_REVISION
    if (!force && typeof expectedRevision === 'number' && expectedRevision !== currentRevision) {
      throw new RevisionConflictError(expectedRevision, currentRevision)
    }
    const revision = nextRevision(currentRevision)
    await table.update(id, { ...patch, revision } as never)
    return revision
  })
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

interface SeedPointShape {
  id: string
  deviceId: string
  stationId: string
  name: string
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
  createdAt: number
  updatedAt: number
}

const SEED_POINT_SHAPES: SeedPointShape[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2) },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2) },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2) },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2) },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2) },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, createdAt: stamp(-278), updatedAt: stamp(-4) },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1) },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1) },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, createdAt: stamp(-260), updatedAt: stamp(-1) },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1) },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1) }
]

/** 播种点位：当前均为第 1 版标准 */
const SEED_POINTS: PointRow[] = SEED_POINT_SHAPES.map((shape) => ({
  ...shape,
  standardVersion: 1,
  revision: ROW_REVISION
}))

/** 播种点位标准版本档案（每个点位一条 v1） */
const SEED_POINT_STANDARDS: PointStandardRow[] = SEED_POINT_SHAPES.map((shape) => ({
  id: `psv_${shape.id}_v1`,
  pointId: shape.id,
  pointName: shape.name,
  stationId: shape.stationId,
  version: 1,
  standardMin: shape.standardMin,
  standardMax: shape.standardMax,
  unit: shape.unit,
  isCritical: shape.isCritical,
  reason: '投运基线标准',
  effectiveAt: shape.createdAt,
  basedOnVersion: 0
}))

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注] */
const SEED_READING_ROWS: Array<[string, string, number, string]> = [
  ['pa-1', 'pt-1', 0.41, ''],
  ['pa-1', 'pt-2', 0.23, ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味'],
  ['pa-2', 'pt-1', 0.38, ''],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度'],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹'],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏'],
  ['pa-4', 'pt-7', 0.21, ''],
  ['pa-4', 'pt-8', 0.145, ''],
  ['pa-4', 'pt-9', 12, ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高']
]

interface SeedLeakShape {
  id: string
  deviceId: string
  stationId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: Leak['state']
  retestValuePpm: number
  handler: string
  createdAt: number
  updatedAt: number
}

const SEED_LEAK_SHAPES: SeedLeakShape[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', createdAt: stamp(-15), updatedAt: stamp(-10) },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', createdAt: stamp(-8), updatedAt: stamp(-6) },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', createdAt: stamp(-12), updatedAt: stamp(-12) }
]

/** 由原始行派生偏差率、异常标记与标准快照 */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const shape = SEED_POINT_SHAPES.find((item) => item.id === pointId)
    const judgement = shape
      ? judgeReading(value, shape.standardMin, shape.standardMax, shape.isCritical)
      : { isAbnormal: false, deviationPct: 0 }
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      standardSnapshot: shape
        ? {
            pointId: shape.id,
            version: 1,
            standardMin: shape.standardMin,
            standardMax: shape.standardMax,
            unit: shape.unit,
            isCritical: shape.isCritical,
            effectiveAt: shape.createdAt,
            reason: '投运基线标准'
          }
        : null,
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

/** 历史泄漏处置单冻结同设备 ppm 点位的派单时标准 */
function buildSeedLeaks(): LeakRow[] {
  return SEED_LEAK_SHAPES.map((shape) => {
    const ppmPoint = SEED_POINT_SHAPES.find((point) => point.deviceId === shape.deviceId && point.unit === 'ppm')
    const standard = ppmPoint ?? { ...FALLBACK_PPM_STANDARD, id: '' }
    return {
      ...shape,
      standardSnapshot: {
        pointId: ppmPoint ? ppmPoint.id : '',
        version: 1,
        standardMin: standard.standardMin,
        standardMax: standard.standardMax,
        unit: 'ppm',
        isCritical: standard.isCritical,
        effectiveAt: shape.createdAt,
        reason: '投运基线标准'
      },
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.pointStandards,
        db.patrols,
        db.readings,
        db.leaks,
        db.pendingMerges
      ],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.pointStandards.bulkPut(SEED_POINT_STANDARDS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(buildSeedLeaks())
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

const ALL_TABLES = [
  db.stations,
  db.devices,
  db.points,
  db.pointStandards,
  db.patrols,
  db.readings,
  db.leaks,
  db.pendingMerges
]

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.pointStandards.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.pointStandards.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.pendingMerges.where('targetId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  const pointIds = (await db.points.where('deviceId').anyOf(deviceIds).toArray()).map((point) => point.id)
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  if (pointIds.length > 0) await db.pointStandards.where('pointId').anyOf(pointIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入（冻结当时标准） ============================ */

/**
 * 写入读数：自动按提交时点位的当前标准（新版本只管尚未提交的巡检）冻结判定快照。
 * 已完成巡检的历史读数不会因标准升级被重算——历史行更新时沿用其既有快照。
 */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  /** 调用方可显式指定标准版本（批量保存时由草稿带入）；默认点位当前版本 */
  standardVersion?: number
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const patrol = await db.patrols.get(row.patrolId)
  // 已完成/漏检巡检：沿用历史标准快照，绝不按新标准改判
  const existing = await db.readings.get(row.id)
  if (patrol && (patrol.state === '已完成' || patrol.state === '漏检') && existing?.standardSnapshot) {
    const snapshot = existing.standardSnapshot
    const judgement = judgeReading(row.value, snapshot.standardMin, snapshot.standardMax, snapshot.isCritical)
    const next: ReadingRow = {
      ...row,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      standardSnapshot: snapshot,
      revision: nextRevision(existing.revision)
    }
    await db.readings.put(next)
    return next
  }
  if (!point) {
    const fallback: ReadingRow = {
      ...row,
      isAbnormal: false,
      deviationPct: 0,
      standardSnapshot: existing?.standardSnapshot ?? null,
      revision: nextRevision(existing?.revision)
    }
    await db.readings.put(fallback)
    return fallback
  }
  const standard = await latestStandardOf(point.id, row.standardVersion)
  const judgement = judgeReading(row.value, standard.standardMin, standard.standardMax, standard.isCritical)
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    standardSnapshot: {
      pointId: point.id,
      version: standard.version,
      standardMin: standard.standardMin,
      standardMax: standard.standardMax,
      unit: standard.unit,
      isCritical: standard.isCritical,
      effectiveAt: standard.effectiveAt,
      reason: standard.reason
    },
    revision: nextRevision(existing?.revision)
  }
  await db.readings.put(next)
  return next
}

/* ============================ 点位标准版本档案 ============================ */

/** 取点位某版本标准；version 缺省取最新版 */
export async function latestStandardOf(pointId: string, version?: number): Promise<PointStandardRow> {
  const list = await db.pointStandards.where('pointId').equals(pointId).toArray()
  if (list.length === 0) throw new Error(`点位 ${pointId} 缺少标准版本档案`)
  if (typeof version === 'number') {
    const hit = list.find((item) => item.version === version)
    if (hit) return hit
  }
  return list.reduce((max, item) => (item.version > max.version ? item : max), list[0])
}

export interface StandardCommitResult {
  point: PointRow
  standard: PointStandardRow
}

/**
 * 提交点位标准新版本（写新版本档案 + 回写点位当前值）。
 * 历史读数与泄漏处置单不做重算；新标准只管尚未提交的巡检。
 */
export async function commitPointStandard(input: {
  pointId: string
  standardMin: number
  standardMax: number
  isCritical: boolean
  reason: string
  effectiveAt?: number
}): Promise<StandardCommitResult> {
  return db.transaction('rw', [db.points, db.pointStandards], async () => {
    const point = await db.points.get(input.pointId)
    if (!point) throw new Error('点位不存在或已被删除')
    const prevVersion =
      typeof point.standardVersion === 'number' && point.standardVersion > 0 ? point.standardVersion : 0
    const effectiveAt = input.effectiveAt ?? Date.now()
    const standard: PointStandardRow = {
      id: createId('psv'),
      pointId: point.id,
      pointName: point.name,
      stationId: point.stationId,
      version: prevVersion + 1,
      standardMin: input.standardMin,
      standardMax: input.standardMax,
      unit: point.unit,
      isCritical: input.isCritical,
      reason: input.reason.trim() || (prevVersion > 0 ? '标准值修订' : '建立标准'),
      effectiveAt,
      basedOnVersion: prevVersion
    }
    await db.pointStandards.put(standard)
    const updated: PointRow = {
      ...point,
      standardMin: standard.standardMin,
      standardMax: standard.standardMax,
      isCritical: standard.isCritical,
      standardVersion: standard.version,
      updatedAt: effectiveAt,
      revision: nextRevision(point.revision)
    }
    await db.points.put(updated)
    return { point: updated, standard }
  })
}

/** 为新建点位建立第 1 版标准档案（与 createPoint 配套） */
export async function establishPointStandard(
  point: PointRow,
  reason = '建立标准'
): Promise<PointStandardRow> {
  const standard: PointStandardRow = {
    id: `psv_${point.id}_v1`,
    pointId: point.id,
    pointName: point.name,
    stationId: point.stationId,
    version: 1,
    standardMin: point.standardMin,
    standardMax: point.standardMax,
    unit: point.unit,
    isCritical: point.isCritical,
    reason,
    effectiveAt: point.createdAt,
    basedOnVersion: 0
  }
  await db.pointStandards.put(standard)
  return standard
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, pointStandards, patrols, readings, leaks, pendingMerges] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.pointStandards.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.pendingMerges.count()
  ])
  return { stations, devices, points, pointStandards, patrols, readings, leaks, pendingMerges }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, pointStandards, patrols, readings, leaks, pendingMerges] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.pointStandards.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.pendingMerges.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    pointStandards,
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    pendingMerges
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      ALL_TABLES,
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.pointStandards.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.pendingMerges.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    // 兼容旧备份：缺 standardVersion 的点位补 1 并补建基线档案
    const points = (payload.points ?? []).map((row) => ({
      ...row,
      standardVersion: typeof row.standardVersion === 'number' ? row.standardVersion : 1
    }))
    await db.points.bulkPut(points.map(rev))
    if (payload.pointStandards && payload.pointStandards.length > 0) {
      await db.pointStandards.bulkPut(payload.pointStandards)
    } else {
      await db.pointStandards.bulkPut(
        points.map((point) => ({
          id: `psv_${point.id}_v1`,
          pointId: point.id,
          pointName: point.name,
          stationId: point.stationId,
          version: 1,
          standardMin: point.standardMin,
          standardMax: point.standardMax,
          unit: point.unit,
          isCritical: point.isCritical,
          reason: '导入备份补建基线',
          effectiveAt: point.createdAt,
          basedOnVersion: 0
        }))
      )
    }
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut(
      (payload.readings ?? []).map((row) =>
        rev({
          ...row,
          standardSnapshot: row.standardSnapshot ?? null
        })
      )
    )
    await db.leaks.bulkPut(
      (payload.leaks ?? []).map((row) =>
        rev({
          ...row,
          standardSnapshot: row.standardSnapshot ?? null
        })
      )
    )
    if (payload.pendingMerges) await db.pendingMerges.bulkPut(payload.pendingMerges)
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.pointStandards.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.pendingMerges.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
