/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 * - 点位标准值版本表（standardVersions）：新标准只追加，不改写历史
 * - 并发待合并队列（mergeQueue）：后写入一方完整留档，重开后继续处理
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { PointStandardVersion } from '@/types/standard'
import { initialVersionId, INITIAL_STANDARD_REASON } from '@/types/standard'
import type { MergeQueueItem } from '@/types/merge'
import { deviationPctOf, judgeByStandard, judgeReading } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs',
  recoveryDrafts: 'gbgaspress:recovery-drafts',
  readingDrafts: 'gbgaspress:reading-drafts'
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
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  standardVersions: PointStandardVersion[]
}

export interface Revisioned {
  revision?: number
}

/** 历史行结构版本（v2 迁移时补齐）；并发乐观锁在此基础上单调递增 */
export const ROW_REVISION = 2

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type StandardVersionRow = PointStandardVersion
export type MergeQueueRow = MergeQueueItem

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  standardVersions!: Table<StandardVersionRow, string>
  mergeQueue!: Table<MergeQueueRow, string>

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

    /*
     * v3：标准值可追溯 + 历史不被改判 + 并发待合并
     * - standardVersions：点位标准版本（追加不可变）
     * - mergeQueue：并发提交败方完整载荷 / 写入失败找回队列
     * - readings / leaks 增加 reviewState、标准版本快照列；points 增加当前版本指针
     */
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, reviewState, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt',
        standardVersions: 'id, pointId, versionNo, createdAt',
        mergeQueue: 'id, entityType, entityId, status, source, createdAt'
      })
      .upgrade(async (tx) => {
        // v1 → v2 的数据补齐（旧库直升 v3 时同样需要）
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = ROW_REVISION
            })
        }

        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        const patrols = (await tx.table('patrols').toArray()) as Array<{ id: string; state: string }>
        const stateOfPatrol = new Map(patrols.map((patrol) => [patrol.id, patrol.state]))

        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

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

        const points = (await tx.table('points').toArray()) as Array<Record<string, unknown>>
        const pointMap = new Map<string, Record<string, unknown>>(points.map((point) => [String(point.id), point]))

        // 为每个点位补当前版本指针与 v1 不可变版本行
        const versionRows: Array<Record<string, unknown>> = []
        points.forEach((point) => {
          const pointId = String(point.id)
          const versionId = initialVersionId(pointId)
          point.currentVersionId = versionId
          point.currentVersionNo = 1
          versionRows.push({
            id: versionId,
            pointId,
            versionNo: 1,
            standardMin: Number(point.standardMin) || 0,
            standardMax: Number(point.standardMax) || 1,
            standardUnit: typeof point.unit === 'string' ? point.unit : 'MPa',
            isCritical: point.isCritical === true,
            reason: INITIAL_STANDARD_REASON,
            createdAt: typeof point.createdAt === 'number' ? point.createdAt : Date.now()
          })
        })
        await tx.table('standardVersions').bulkPut(versionRows)

        /*
         * 读数迁移：
         * - 已完成巡检的读数按「当时标准」冻结快照（沿用现行点位值作为其历史标准）；
         * - 未完成巡检（待巡检 / 漏检）中的读数保留原值与差异，标记「待复核」。
         */
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            const patrolState = stateOfPatrol.get(String(reading.patrolId))
            if (point && Number.isFinite(value)) {
              const min = Number(point.standardMin) || 0
              const max = Number(point.standardMax) || 1
              const isCritical = point.isCritical === true
              const judgement = judgeReading(value, min, max, isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
              reading.standardMin = min
              reading.standardMax = max
              reading.standardUnit = typeof point.unit === 'string' ? point.unit : ''
              reading.isCritical = isCritical
              reading.standardVersionId = point.currentVersionId
              reading.standardVersionNo = 1
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
              reading.standardMin = Number(reading.standardMin) || 0
              reading.standardMax = Number(reading.standardMax) || 1
              reading.standardUnit = typeof reading.standardUnit === 'string' ? reading.standardUnit : ''
              if (typeof reading.isCritical !== 'boolean') reading.isCritical = false
              reading.standardVersionId = ''
              reading.standardVersionNo = 0
            }
            reading.reviewState = patrolState === '已完成' ? '无' : '待复核'
          })

        // 处置单迁移：历史单据按当时标准（取点位 v1 / 默认 0~50 ppm）冻结，后续标准不改判
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            const pointRow = points.find(
              (item) => item.deviceId === leak.deviceId && String(item.unit) === 'ppm'
            )
            const min = pointRow ? Number(pointRow.standardMin) || 0 : 0
            const max = pointRow ? Number(pointRow.standardMax) || 50 : 50
            const isCritical = pointRow ? pointRow.isCritical === true : true
            leak.standardMin = min
            leak.standardMax = max
            leak.standardUnit = 'ppm'
            leak.isCritical = isCritical
            leak.standardVersionId = pointRow ? pointRow.currentVersionId : ''
            leak.standardVersionNo = pointRow ? 1 : 0
            leak.sourceReadingId = ''
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 乐观锁：取下一版 revision */
export function nextRevision(current: number | undefined): number {
  return (typeof current === 'number' && current > 0 ? current : ROW_REVISION) + 1
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

/** 播种点位：挂上 v1 当前版本指针 */
const SEED_POINTS: PointRow[] = SEED_POINT_SHAPES.map((shape) => ({
  ...shape,
  currentVersionId: initialVersionId(shape.id),
  currentVersionNo: 1,
  revision: ROW_REVISION
}))

/** 播种标准版本：每点位一条 v1 不可变快照 */
const SEED_STANDARD_VERSIONS: StandardVersionRow[] = SEED_POINT_SHAPES.map((shape) => ({
  id: initialVersionId(shape.id),
  pointId: shape.id,
  versionNo: 1,
  standardMin: shape.standardMin,
  standardMax: shape.standardMax,
  standardUnit: shape.unit,
  isCritical: shape.isCritical,
  reason: INITIAL_STANDARD_REASON,
  createdAt: shape.createdAt
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

const SEED_LEAK_SHAPES: Array<{
  id: string
  deviceId: string
  stationId: string
  pointId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: Leak['state']
  retestValuePpm: number
  handler: string
  sourceReadingId: string
  createdAt: number
  updatedAt: number
}> = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', pointId: 'pt-3', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', sourceReadingId: 'rd-3', createdAt: stamp(-15), updatedAt: stamp(-10) },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', pointId: 'pt-5', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', sourceReadingId: 'rd-7', createdAt: stamp(-8), updatedAt: stamp(-6) },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', pointId: 'pt-10', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', sourceReadingId: 'rd-11', createdAt: stamp(-12), updatedAt: stamp(-12) }
]

/** 播种读数：按当时标准（v1）冻结快照；已完成巡检不留待复核 */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINT_SHAPES.find((item) => item.id === pointId)
    const patrol = SEED_PATROLS.find((item) => item.id === patrolId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      standardMin: point ? point.standardMin : 0,
      standardMax: point ? point.standardMax : 1,
      standardUnit: point ? point.unit : '',
      isCritical: point ? point.isCritical : false,
      standardVersionId: point ? initialVersionId(point.id) : '',
      standardVersionNo: 1,
      reviewState: patrol?.state === '已完成' ? '无' : '待复核',
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

/** 播种处置单：按当时浓度点位标准冻结，后续标准不改判 */
function buildSeedLeaks(): LeakRow[] {
  return SEED_LEAK_SHAPES.map((shape) => {
    const point = SEED_POINT_SHAPES.find((item) => item.id === shape.pointId)
    return {
      id: shape.id,
      deviceId: shape.deviceId,
      stationId: shape.stationId,
      concentrationPpm: shape.concentrationPpm,
      foundTime: shape.foundTime,
      measure: shape.measure,
      state: shape.state,
      retestValuePpm: shape.retestValuePpm,
      handler: shape.handler,
      sourceReadingId: shape.sourceReadingId,
      standardMin: point ? point.standardMin : 0,
      standardMax: point ? point.standardMax : 50,
      standardUnit: 'ppm',
      isCritical: point ? point.isCritical : true,
      standardVersionId: point ? initialVersionId(point.id) : '',
      standardVersionNo: 1,
      createdAt: shape.createdAt,
      updatedAt: shape.updatedAt,
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
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.standardVersions.bulkPut(SEED_STANDARD_VERSIONS)
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

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    const deviceIds = devices.map((device) => device.id)
    const stationPoints = await db.points.where('deviceId').anyOf(deviceIds.length > 0 ? deviceIds : ['__none__']).toArray()
    const stationPatrols = await db.patrols.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(deviceIds)
    if (deviceIds.length > 0) await db.devices.bulkDelete(deviceIds)
    if (stationPoints.length > 0) {
      await db.standardVersions.where('pointId').anyOf(stationPoints.map((point) => point.id)).delete()
    }
    if (stationPatrols.length > 0) {
      await db.readings.where('patrolId').anyOf(stationPatrols.map((patrol) => patrol.id)).delete()
      await db.mergeQueue.where('entityId').anyOf(stationPatrols.map((patrol) => patrol.id)).delete()
    }
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.standardVersions.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.mergeQueue.where('entityId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0)
    return
  const points = await db.points.where('deviceId').anyOf(deviceIds).toArray()
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.readings.where('pointId').anyOf(points.map((point) => point.id)).delete()
  await db.standardVersions.where('pointId').anyOf(points.map((point) => point.id)).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

/** 判定依据的标准快照（读点位时使用） */
export interface StandardLike {
  standardMin: number
  standardMax: number
  standardUnit?: string
  unit?: string
  isCritical: boolean
}

/** 由点位行取标准快照 */
export function standardOfPoint(point: StandardLike): {
  standardMin: number
  standardMax: number
  standardUnit: string
  isCritical: boolean
} {
  return {
    standardMin: point.standardMin,
    standardMax: point.standardMax,
    standardUnit: point.standardUnit ?? point.unit ?? '',
    isCritical: point.isCritical
  }
}

export interface PutReadingInput {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
  /** 维持原判定（人工选择保留旧标准结论）时传入旧快照，否则按点位当前标准 */
  forceStandard?: {
    standardMin: number
    standardMax: number
    standardUnit: string
    isCritical: boolean
    standardVersionId: string
    standardVersionNo: number
  }
  reviewState?: Reading['reviewState']
}

/**
 * 写入读数：自动与「提交时的点位标准」比对并冻结快照（isAbnormal / deviationPct / 标准版本）。
 * 新标准日后变更不会回改该读数。已存在读数的 revision 单调递增。
 */
export async function putReading(row: PutReadingInput): Promise<ReadingRow> {
  const [existing, currentPoint] = await Promise.all([db.readings.get(row.id), db.points.get(row.pointId)])
  const base = row.forceStandard ?? (currentPoint ? { ...standardOfPoint(currentPoint), standardVersionId: currentPoint.currentVersionId, standardVersionNo: currentPoint.currentVersionNo } : null)
  const judgement = base
    ? judgeByStandard(row.value, base)
    : { isAbnormal: false, deviationPct: 0 }
  const next: ReadingRow = {
    id: row.id,
    patrolId: row.patrolId,
    pointId: row.pointId,
    value: row.value,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    note: row.note,
    standardMin: base?.standardMin ?? 0,
    standardMax: base?.standardMax ?? 1,
    standardUnit: base?.standardUnit ?? currentPoint?.unit ?? '',
    isCritical: base?.isCritical ?? false,
    standardVersionId: base?.standardVersionId ?? '',
    standardVersionNo: base?.standardVersionNo ?? 0,
    reviewState: row.reviewState ?? '无',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: existing ? nextRevision(existing.revision) : ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/* ============================ 整库导入导出 ============================ */

const ALL_TABLES = [
  'stations',
  'devices',
  'points',
  'patrols',
  'readings',
  'leaks'
] as const

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions, mergeQueue] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.standardVersions.count(),
    db.mergeQueue.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, standardVersions, mergeQueue }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.standardVersions.toArray()
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
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    standardVersions
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.standardVersions.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.standardVersions.bulkPut(payload.standardVersions ?? [])
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.mergeQueue
      ],
      async () => {
    await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
    await db.standardVersions.clear()
    await db.mergeQueue.clear()
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
