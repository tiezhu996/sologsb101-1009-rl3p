/**
 * 点位标准值版本：每次标准更新都生成一个不可变版本快照。
 * 历史读数 / 泄漏处置单按当时的版本号追溯，不被后续标准改判。
 */

/** 标准快照：判定读数所需的最小字段集合 */
export interface StandardSnapshot {
  standardMin: number
  standardMax: number
  standardUnit: string
  isCritical: boolean
}

/** 标准值版本行（不可变，追加写入 standardVersions 表） */
export interface PointStandardVersion extends StandardSnapshot {
  id: string
  pointId: string
  /** 版本序号，从 1 开始单调递增 */
  versionNo: number
  /** 变更原因，如「调压站升级」 */
  reason: string
  createdAt: number
}

/** 点位行上挂的当前版本指针字段 */
export interface PointStandardRef {
  currentVersionId: string
  currentVersionNo: number
}

/** 读数 / 处置单上留存的「当时标准」快照字段 */
export interface StandardRefFields extends StandardSnapshot {
  /** 判定时使用的标准版本 id（可能为空，如历史迁移数据） */
  standardVersionId: string
  /** 判定时使用的标准版本序号 */
  standardVersionNo: number
}

export const INITIAL_STANDARD_REASON = '初始标准'

/** 由点位行构造 v1 初始版本 id */
export function initialVersionId(pointId: string): string {
  return `sv_${pointId}_v1`
}
