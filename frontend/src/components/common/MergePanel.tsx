/**
 * 待合并 / 本地找回面板
 * - 并发提交败方：完整载荷留档，展示基线版本与当前版本，可「载入继续处理」或「放弃」
 * - 写入失败找回：从本地草稿登记的 recovery 条目，可重新载入或丢弃
 * - 纯展示 + 回调，具体载入动作由巡检录入 / 泄漏处置页提供
 */
import { Button, Empty, Popconfirm, Space, Table, Tag } from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import { useMergeStore } from '@/stores/mergeStore'
import type { MergeEntityType, MergeQueueItem } from '@/types/merge'
import { isPatrolPayload } from '@/types/merge'
import type { LocalSubmitDraft } from '@/utils/localDraft'

export interface MergePanelHandle {
  /** 载入冲突败方载荷继续处理 */
  onAdopt: (item: MergeQueueItem) => void | Promise<void>
  /** 载入本地写入失败草稿 */
  onRecover: (draft: LocalSubmitDraft) => void | Promise<void>
}

interface Props extends MergePanelHandle {
  entityType: MergeEntityType
  /** 仅展示某条业务记录（巡检 / 处置单）的条目；省略则展示该实体全部 */
  entityId?: string
}

interface UnifiedRow {
  key: string
  kind: 'conflict' | 'recovery'
  title: string
  detail: string
  baseRevision: number
  currentRevision?: number
  createdAt: number
  raw: MergeQueueItem | LocalSubmitDraft
}

export default function MergePanel({ entityType, entityId, onAdopt, onRecover }: Props) {
  const mergeStore = useMergeStore()
  const queue = mergeStore.pendingOf(entityType, entityId)
  const localDrafts = mergeStore.localDraftsOf(entityType, entityId)

  const rows: UnifiedRow[] = [
    ...queue.map((item) => ({
      key: `q-${item.id}`,
      kind: 'conflict' as const,
      title: item.title,
      detail: isPatrolPayload(item.payload)
        ? `巡检完成提交 · ${item.payload.readings.length} 条读数`
        : '处置单提交',
      baseRevision: item.baseRevision,
      currentRevision: item.currentRevision,
      createdAt: item.createdAt,
      raw: item
    })),
    ...localDrafts.map((draft) => ({
      key: `d-${draft.id}`,
      kind: 'recovery' as const,
      title: draft.title,
      detail: isPatrolPayload(draft.payload)
        ? `本地找回 · ${draft.payload.readings.length} 条读数待提交`
        : '本地找回 · 处置单内容待提交',
      baseRevision: draft.baseRevision,
      createdAt: draft.createdAt,
      raw: draft
    }))
  ].sort((a, b) => b.createdAt - a.createdAt)

  if (rows.length === 0) return null

  const columns: TableColumnProps<UnifiedRow>[] = [
    {
      title: '类型',
      width: 130,
      render: (_v, record) =>
        record.kind === 'conflict' ? <Tag color="red">并发冲突</Tag> : <Tag color="orange">写入失败找回</Tag>
    },
    { title: '对象', dataIndex: 'title', width: 220, render: (value: string) => <strong>{value}</strong> },
    { title: '内容', dataIndex: 'detail' },
    {
      title: '版本',
      width: 180,
      render: (_v, record) =>
        record.kind === 'conflict' ? (
          <span className="muted">
            你基于 v{record.baseRevision}，已被先提交到 v{record.currentRevision}
          </span>
        ) : (
          <span className="muted">基于 v{record.baseRevision}</span>
        )
    },
    {
      title: '时间',
      width: 170,
      render: (_v, record) => new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })
    },
    {
      title: '操作',
      width: 180,
      render: (_v, record) => (
        <Space size={4}>
          {record.kind === 'conflict' ? (
            <>
              <Button
                type="text"
                size="small"
                onClick={() => {
                  void onAdopt(record.raw as MergeQueueItem)
                }}
              >
                载入继续
              </Button>
              <Popconfirm
                title="放弃后该份提交内容将被标记为已放弃"
                onOk={() => mergeStore.markResolved((record.raw as MergeQueueItem).id, '已放弃')}
              >
                <Button type="text" size="small" status="danger">
                  放弃
                </Button>
              </Popconfirm>
            </>
          ) : (
            <>
              <Button
                type="text"
                size="small"
                onClick={() => {
                  void onRecover(record.raw as LocalSubmitDraft)
                }}
              >
                找回内容
              </Button>
              <Popconfirm title="丢弃这份本地草稿？" onOk={() => mergeStore.removeLocalDraft((record.raw as LocalSubmitDraft).id)}>
                <Button type="text" size="small" status="danger">
                  丢弃
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      )
    }
  ]

  return (
    <div className="panel" style={{ marginTop: 16, borderColor: '#ffb65c' }}>
      <div className="panel-head">
        <h3 className="panel-title" style={{ margin: 0 }}>
          待合并 / 待找回（{rows.length}）
        </h3>
        <span className="muted">
          {entityType === 'patrol'
            ? '两个标签页并发提交同一巡检时，先写入的生效；另一份完整保留在此，重开后仍可继续处理。'
            : '两个标签页并发提交同一处置单时，先写入的生效；另一份完整保留在此，重开后仍可继续处理。'}
        </span>
      </div>
      <Table<UnifiedRow>
        rowKey="key"
        size="small"
        border
        data={rows}
        columns={columns}
        pagination={false}
        noDataElement={<Empty description="暂无待合并内容" />}
      />
    </div>
  )
}
