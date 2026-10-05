/**
 * 点位标准值的版本快照：读数、泄漏处置单在产生时冻结当时的标准，
 * 之后标准升级不回改历史判定。
 */
export interface StandardSnapshot {
  /** 所属点位 */
  pointId: string
  /** 点位标准版本号（pointStandards 表中的 version） */
  version: number
  standardMin: number
  standardMax: number
  unit: string
  /** 判定时是否关键点 */
  isCritical: boolean
  /** 版本生效时间（ms 时间戳），便于台账追溯 */
  effectiveAt: number
  /** 变更原因（可空） */
  reason: string
}

/** 点位：设备上的巡检点位与标准值区间 */
export interface Point {
  id: string
  deviceId: string
  /** 冗余站点 id，便于按站点快速筛选 */
  stationId: string
  /** 点位名，如 出口压力 */
  name: string
  standardMin: number
  standardMax: number
  unit: string
  /** 是否关键点：关键点偏差超过 5% 即判严重超标 */
  isCritical: boolean
  /** 当前生效的标准版本号（对应 pointStandards 表） */
  standardVersion: number
  createdAt: number
  updatedAt: number
}

/** pointStandards 表：点位标准值的可追溯版本档案 */
export interface PointStandardVersion {
  id: string
  pointId: string
  pointName: string
  stationId: string
  /** 版本号，从 1 起，逐次 +1 */
  version: number
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
  /** 变更原因 */
  reason: string
  /** 生效时间 */
  effectiveAt: number
  /** 上一版本号（首版为 0） */
  basedOnVersion: number
}

/** 由点位标准版本生成判定用快照 */
export function snapshotOfStandard(
  standard: Pick<PointStandardVersion, 'pointId' | 'version' | 'standardMin' | 'standardMax' | 'unit' | 'isCritical' | 'effectiveAt' | 'reason'>
): StandardSnapshot {
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
}

export const POINT_UNITS = ['MPa', '℃', 'ppm', 'kPa', 'm³/h']

export interface PointDraft {
  deviceId: string
  name: string
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
}

export const EMPTY_POINT_DRAFT: PointDraft = {
  deviceId: '',
  name: '',
  standardMin: 0,
  standardMax: 1,
  unit: 'MPa',
  isCritical: false
}

/** 标准值模板：批量复制用 */
export interface PointTemplate {
  name: string
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
}

export const POINT_TEMPLATES: PointTemplate[] = [
  { name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true },
  { name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true },
  { name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false },
  { name: '泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true }
]

/** 点位标准值编辑草稿：点位 id → 待提交的上下限 */
export interface StandardDraft {
  standardMin: number
  standardMax: number
  isCritical: boolean
  /** 变更原因（提交时写入版本档案，可空） */
  reason?: string
}

/** 点位筛选条件（存于 patrolStore 之外的组合条件） */
export interface PointFilterState {
  keyword: string
  stationId: string
  deviceTypes: string[]
  onlyCritical: boolean
}

export function createEmptyPointFilter(): PointFilterState {
  return { keyword: '', stationId: '', deviceTypes: [], onlyCritical: false }
}
