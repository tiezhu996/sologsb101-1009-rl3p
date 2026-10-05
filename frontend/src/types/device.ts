/** 设备：调压站内的调压器 / 过滤器 / 切断阀 / 放散阀 */
export type DeviceType = '调压器' | '过滤器' | '切断阀' | '放散阀'
export type DeviceState = '运行' | '停用' | '检修'

export interface Device {
  id: string
  stationId: string
  type: DeviceType
  model: string
  /** 出厂编号 */
  serialNo: string
  installDate: string
  state: DeviceState
  createdAt: number
  updatedAt: number
}

export const DEVICE_TYPES: DeviceType[] = ['调压器', '过滤器', '切断阀', '放散阀']
export const DEVICE_STATES: DeviceState[] = ['运行', '停用', '检修']

export interface DeviceDraft {
  stationId: string
  type: DeviceType
  model: string
  serialNo: string
  installDate: string
  state: DeviceState
}

export const EMPTY_DEVICE_DRAFT: DeviceDraft = {
  stationId: '',
  type: '调压器',
  model: '',
  serialNo: '',
  installDate: '',
  state: '运行'
}

export function deviceLabel(device: Device): string {
  return `${device.type} ${device.model || ''}`.trim()
}
