/**
 * 导出工具：整库 JSON 存档、巡检/泄漏台账 CSV、结构版本导出
 */
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import { abnormalLevelOf, deviationPctOf, formatLeakConcentration } from '@/utils/range'

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function exportBackupJson(payload: unknown): string {
  const filename = `gbgaspress-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
  return filename
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 巡检读数台账 CSV */
export function exportReadingCsv(
  stations: Station[],
  devices: Device[],
  points: Point[],
  patrols: Patrol[],
  readings: Reading[]
): string {
  const header = [
    '调压站',
    '设备',
    '点位',
    '标准下限',
    '标准上限',
    '单位',
    '关键点',
    '计划日期',
    '实际日期',
    '巡检人',
    '巡检状态',
    '读数',
    '偏差率(%)',
    '判定',
    '备注'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  readings.forEach((reading) => {
    const point = points.find((item) => item.id === reading.pointId)
    const patrol = patrols.find((item) => item.id === reading.patrolId)
    const device = point ? devices.find((item) => item.id === point.deviceId) : undefined
    const station = patrol ? stations.find((item) => item.id === patrol.stationId) : undefined
    lines.push(
      [
        station ? station.name : '—',
        device ? `${device.type} ${device.model}` : '—',
        point ? point.name : '—',
        point ? point.standardMin : '—',
        point ? point.standardMax : '—',
        point ? point.unit : '—',
        point ? (point.isCritical ? '是' : '否') : '—',
        patrol ? patrol.planDate : '—',
        patrol ? patrol.patrolDate || '未执行' : '—',
        patrol ? patrol.patrolman || '—' : '—',
        patrol ? patrol.state : '—',
        reading.value,
        reading.deviationPct.toFixed(2),
        point ? abnormalLevelOf(reading.deviationPct, point.isCritical) : '—',
        reading.note || '—'
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `巡检读数台账-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 泄漏处置台账 CSV */
export function exportLeakCsv(stations: Station[], devices: Device[], leaks: Leak[]): string {
  const header = ['调压站', '设备', '出厂编号', '浓度(ppm)', '发现时间', '处置措施', '状态', '复检值(ppm)', '复检结论', '处置人']
  const lines: string[] = [header.map(csvCell).join(',')]
  leaks.forEach((leak) => {
    const device = devices.find((item) => item.id === leak.deviceId)
    const station = stations.find((item) => item.id === leak.stationId)
    const pass = leak.retestValuePpm > 0 && leak.retestValuePpm <= 50
    lines.push(
      [
        station ? station.name : '—',
        device ? `${device.type} ${device.model}` : '—',
        device ? device.serialNo : '—',
        leak.concentrationPpm,
        leak.foundTime,
        leak.measure || '—',
        leak.state,
        leak.retestValuePpm,
        leak.state === '已复检' ? (pass ? '合格' : '不合格') : '未复检',
        leak.handler || '—'
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `泄漏处置台账-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 点位标准值配置 CSV */
export function exportPointCsv(stations: Station[], devices: Device[], points: Point[]): string {
  const header = ['调压站', '设备类型', '设备型号', '点位名', '标准下限', '标准上限', '单位', '关键点', '区间宽度']
  const lines: string[] = [header.map(csvCell).join(',')]
  points.forEach((point) => {
    const device = devices.find((item) => item.id === point.deviceId)
    const station = stations.find((item) => item.id === point.stationId)
    lines.push(
      [
        station ? station.name : '—',
        device ? device.type : '—',
        device ? device.model : '—',
        point.name,
        point.standardMin,
        point.standardMax,
        point.unit,
        point.isCritical ? '是' : '否',
        (point.standardMax - point.standardMin).toFixed(4)
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `点位标准值-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 导出结构版本（库名、版本号、各表行数） */
export function exportStructureVersion(summary: {
  dbName: string
  dbVersion: number
  counts: Record<string, number>
  missedPatrolCount: number
  exportedAt: string
}): string {
  const filename = `gbgaspress-structure-${stampSuffix()}.json`
  download(filename, JSON.stringify(summary, null, 2), 'application/json;charset=utf-8')
  return filename
}

/** 供异常分级页复用的偏差率计算 */
export function deviationOf(value: number, min: number, max: number): number {
  return deviationPctOf(value, min, max)
}

export function concentrationText(ppm: number): string {
  return formatLeakConcentration(ppm)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}
