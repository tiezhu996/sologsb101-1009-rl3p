/**
 * 点位标准值版本履历弹窗：展示某点位全部不可变版本。
 * 历史读数 / 处置单按读数与单据上留存的版本号追溯，新标准不改判历史。
 */
import { useEffect, useState } from 'react'
import { Modal, Table, Tag } from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import type { PointStandardVersion } from '@/types/standard'
import { listStandardVersions } from '@/utils/standards'
import { rangeText } from '@/utils/range'

interface Props {
  visible: boolean
  pointId: string | null
  pointName?: string
  onClose: () => void
}

export default function StandardHistoryModal({ visible, pointId, pointName, onClose }: Props) {
  const [rows, setRows] = useState<PointStandardVersion[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!visible || !pointId) return
    setLoading(true)
    void listStandardVersions(pointId)
      .then(setRows)
      .finally(() => setLoading(false))
  }, [visible, pointId])

  const columns: TableColumnProps<PointStandardVersion>[] = [
    {
      title: '版本',
      width: 90,
      render: (_v, record) => (
        <Tag color={record.versionNo === rows[0]?.versionNo ? 'arcoblue' : undefined}>v{record.versionNo}</Tag>
      )
    },
    { title: '标准区间', width: 200, render: (_v, record) => rangeText(record.standardMin, record.standardMax, record.standardUnit) },
    {
      title: '关键点',
      width: 90,
      render: (_v, record) => (record.isCritical ? <Tag color="orange">关键点</Tag> : '普通点')
    },
    { title: '变更原因', dataIndex: 'reason', width: 180 },
    {
      title: '生效时间',
      width: 180,
      render: (_v, record) => new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })
    }
  ]

  return (
    <Modal
      visible={visible}
      title={`标准值版本履历${pointName ? ` · ${pointName}` : ''}`}
      onCancel={onClose}
      footer={null}
      unmountOnExit
      style={{ width: 760 }}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        每个版本不可变；已完成巡检的读数与泄漏处置单始终按当时版本标记异常，本履历用于追溯。
      </p>
      <Table<PointStandardVersion>
        rowKey="id"
        size="small"
        border
        loading={loading}
        data={rows}
        columns={columns}
        pagination={false}
      />
    </Modal>
  )
}
