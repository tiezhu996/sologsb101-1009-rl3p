/**
 * <StatBadge> 点位数、异常率与漏检数徽标
 * 被调压站台账、异常分级、计划页消费。
 */
import { Progress, Tooltip } from '@arco-design/web-react'

export type BadgeTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface StatBadgeProps {
  label: string
  value: number | string
  suffix?: string
  /** 占比 0-100，传入后渲染进度条并以百分比展示数值 */
  percent?: number
  tone?: BadgeTone
  hint?: string
}

const TONE_COLOR: Record<BadgeTone, string> = {
  default: '#6b6b6b',
  primary: '#165dff',
  success: '#00b42a',
  warning: '#ff7d00',
  danger: '#f53f3f',
  info: '#3491fa'
}

export function StatBadge({ label, value, suffix = '', percent, tone = 'default', hint }: StatBadgeProps) {
  const color = TONE_COLOR[tone]
  const display = percent === undefined ? value : `${percent}%`

  const body = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 140,
        padding: '12px 14px',
        background: '#ffffff',
        border: '1px solid #e5e6eb',
        borderLeft: `4px solid ${color}`,
        borderRadius: 10
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#86909c', fontSize: 13 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: '#1d2129', fontVariantNumeric: 'tabular-nums' }}>
          {display}
        </span>
        {suffix ? <span style={{ fontSize: 12, color: '#86909c' }}>{suffix}</span> : null}
      </div>
      {percent === undefined ? null : (
        <Progress percent={Math.min(100, Math.max(0, percent))} color={color} showText={false} size="small" />
      )}
    </div>
  )

  return hint ? <Tooltip content={hint}>{body}</Tooltip> : body
}

export default StatBadge
