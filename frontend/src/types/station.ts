/** 调压站：燃气输配管网中的压力调节单元 */
export type StationGrade = '高中压' | '中中压' | '中低压'

export interface Station {
  id: string
  name: string
  location: string
  /** 设计流量（m³/h） */
  designFlowM3h: number
  /** 进口压力（MPa） */
  inletPressureMpa: number
  grade: StationGrade
  /** 投运日期 YYYY-MM-DD */
  commissionDate: string
  createdAt: number
  updatedAt: number
}

export const STATION_GRADES: StationGrade[] = ['高中压', '中中压', '中低压']

export interface StationDraft {
  name: string
  location: string
  designFlowM3h: number
  inletPressureMpa: number
  grade: StationGrade
  commissionDate: string
}

export const EMPTY_STATION_DRAFT: StationDraft = {
  name: '',
  location: '',
  designFlowM3h: 0,
  inletPressureMpa: 0.4,
  grade: '高中压',
  commissionDate: ''
}

/** 调压站卡片回显用的聚合值 */
export interface StationStat {
  stationId: string
  deviceCount: number
  pointCount: number
  openLeakCount: number
  missedPatrolCount: number
}

export function formatFlow(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(0)} m³/h`
}

export function formatPressure(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(3)} MPa`
}
