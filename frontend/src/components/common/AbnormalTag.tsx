/**
 * <AbnormalTag> 按 正常 / 轻微超标 / 严重超标 渲染底色与图标
 * 被巡检录入、异常分级两页消费。
 */
import { Tag } from '@arco-design/web-react'
import { IconCheckCircleFill, IconCloseCircleFill, IconExclamationCircleFill } from '@arco-design/web-react/icon'
import type { AbnormalLevel } from '@/utils/range'
import { ABNORMAL_THEME } from '@/utils/range'

export interface AbnormalTagProps {
  level: AbnormalLevel
  /** 附加展示的偏差率（%） */
  deviationPct?: number
  size?: 'small' | 'default' | 'large'
}

const ICON = {
  正常: IconCheckCircleFill,
  轻微超标: IconExclamationCircleFill,
  严重超标: IconCloseCircleFill
} as const

export function AbnormalTag({ level, deviationPct, size = 'default' }: AbnormalTagProps) {
  const Icon = ICON[level]
  return (
    <Tag
      color={ABNORMAL_THEME[level]}
      size={size === 'default' ? 'default' : size}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <Icon />
      <span>{level}</span>
      {deviationPct === undefined ? null : <span style={{ opacity: 0.85 }}>· {deviationPct.toFixed(2)}%</span>}
    </Tag>
  )
}

export default AbnormalTag
