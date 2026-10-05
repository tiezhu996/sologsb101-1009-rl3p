/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页消费。
 */
import { Button, Empty, Space } from '@arco-design/web-react'
import type { ReactNode } from 'react'

export interface EmptyPanelProps {
  title: string
  description?: ReactNode
  actionText?: string
  onAction?: () => void
  secondaryText?: string
  onSecondary?: () => void
  showSeed?: boolean
  onSeed?: () => void
  compact?: boolean
}

export function EmptyPanel({
  title,
  description,
  actionText,
  onAction,
  secondaryText,
  onSecondary,
  showSeed = false,
  onSeed,
  compact = false
}: EmptyPanelProps) {
  return (
    <div
      style={{
        padding: compact ? '20px 12px' : '42px 24px',
        textAlign: 'center',
        background: '#fafbfc',
        border: '1px dashed #e5e6eb',
        borderRadius: 10
      }}
    >
      <Empty
        description={
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1d2129' }}>{title}</div>
            {description ? <div style={{ fontSize: 13, color: '#86909c', marginTop: 4 }}>{description}</div> : null}
          </div>
        }
      />
      {actionText || secondaryText || showSeed ? (
        <Space style={{ marginTop: 12 }}>
          {actionText && onAction ? (
            <Button type="primary" onClick={onAction}>
              {actionText}
            </Button>
          ) : null}
          {secondaryText && onSecondary ? <Button onClick={onSecondary}>{secondaryText}</Button> : null}
          {showSeed && onSeed ? (
            <Button type="outline" onClick={onSeed}>
              生成样例数据
            </Button>
          ) : null}
        </Space>
      ) : null}
    </div>
  )
}

export default EmptyPanel
