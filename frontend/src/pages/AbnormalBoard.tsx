/**
 * /abnormal 异常判定与分级
 * 按偏差率与关键点权重分级排序，批量确认并派发泄漏处置单。
 * 消费 Reading、Point；复用 <AbnormalTag>、<StatBadge>、<FilterBar>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore, type AbnormalRow } from '@/stores/patrolStore'
import { useLeakStore } from '@/stores/leakStore'
import type { AbnormalLevel } from '@/utils/range'
import { CRITICAL_DEVIATION_PCT, SEVERE_DEVIATION_PCT } from '@/utils/range'

const LEVELS: AbnormalLevel[] = ['轻微超标', '严重超标']

export default function AbnormalBoard() {
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const leakStore = useLeakStore()

  const [stationId, setStationId] = useState('')
  const [levels, setLevels] = useState<AbnormalLevel[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [fixForm] = Form.useForm<{ value: number; note: string }>()
  const [fixOpen, setFixOpen] = useState(false)
  const [fixTarget, setFixTarget] = useState<AbnormalRow | null>(null)

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'levels', label: '异常级别', options: LEVELS.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = { keyword: '', stationId, levels }

  const onModelChange = (next: FilterModel): void => {
    setStationId(typeof next.stationId === 'string' ? next.stationId : '')
    setLevels((Array.isArray(next.levels) ? next.levels : []) as AbnormalLevel[])
  }

  const rows = patrolStore.abnormalRows().filter((row) => {
    if (stationId && row.point?.stationId !== stationId) return false
    if (levels.length > 0 && !levels.includes(row.level)) return false
    return true
  })

  const leakConcentrationRows = rows.filter((row) => row.point?.unit === 'ppm')

  const confirm = async (row: AbnormalRow): Promise<void> => {
    const point = row.point
    if (!point) return
    if (point.unit === 'ppm') {
      const foundTime = row.patrol
        ? row.patrol.patrolDate || row.patrol.planDate
        : new Date().toISOString().slice(0, 10)
      if (leakStore.leaks.some((leak) => leak.deviceId === point.deviceId && leak.foundTime === foundTime)) {
        Message.info('该设备当日已派发过处置单')
        return
      }
      const station = stationStore.stations.find((item) => item.id === point.stationId)
      await leakStore.createFromAbnormal({
        deviceId: point.deviceId,
        stationId: point.stationId,
        concentrationPpm: row.reading.value,
        foundTime,
        measure: `${point.name} 实测 ${row.reading.value} ${point.unit}，偏差率 ${row.reading.deviationPct.toFixed(2)}%，${
          station ? station.name : ''
        } 已派发处置单`
      })
      Message.success('已派发泄漏处置单')
      return
    }
    await patrolStore.saveSingleReading(row.reading.patrolId, point, row.reading.value, '异常已确认并记录')
    Message.success('异常已确认并记录')
  }

  const confirmSelected = async (): Promise<void> => {
    if (selectedKeys.length === 0) {
      Message.warning('请先勾选需要确认的异常读数')
      return
    }
    let leakCount = 0
    let notedCount = 0
    for (const key of selectedKeys) {
      const row = rows.find((item) => item.reading.id === key)
      if (!row || !row.point) continue
      if (row.point.unit === 'ppm') {
        await leakStore.createFromAbnormal({
          deviceId: row.point.deviceId,
          stationId: row.point.stationId,
          concentrationPpm: row.reading.value,
          foundTime: row.patrol ? row.patrol.patrolDate || row.patrol.planDate : new Date().toISOString().slice(0, 10),
          measure: `${row.point.name} 实测 ${row.reading.value} ppm，批量派单`
        })
        leakCount += 1
      } else {
        await patrolStore.saveSingleReading(row.reading.patrolId, row.point, row.reading.value, '异常已批量确认')
        notedCount += 1
      }
    }
    Message.success(`批量确认完成：派发处置单 ${leakCount} 张，记录确认 ${notedCount} 条`)
    setSelectedKeys([])
  }

  const openFix = (row: AbnormalRow): void => {
    setFixTarget(row)
    fixForm.setFieldsValue({ value: row.reading.value, note: row.reading.note })
    setFixOpen(true)
  }

  const submitFix = async (): Promise<void> => {
    if (!fixTarget || !fixTarget.point) return
    const values = await fixForm.validate().catch(() => null)
    if (!values) return
    await patrolStore.saveSingleReading(
      fixTarget.reading.patrolId,
      fixTarget.point,
      Number(values.value),
      values.note
    )
    Message.success('读数已修正，偏差率与异常级别已重算')
    setFixOpen(false)
  }

  const removeReading = async (row: AbnormalRow): Promise<void> => {
    await patrolStore.removeReading(row.reading.id)
    Message.success('误录读数已删除')
  }

  const columns: TableColumnProps<AbnormalRow>[] = [
    { title: '权重', width: 80, render: (_value, record) => <strong>{record.weight}</strong> },
    {
      title: '调压站 / 设备',
      width: 230,
      render: (_value, record) => {
        const station = stationStore.stations.find((item) => item.id === record.point?.stationId)
        const device = stationStore.devices.find((item) => item.id === record.point?.deviceId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '点位',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <span>{record.point?.name ?? '点位已删除'}</span>
          {record.point?.isCritical ? <Tag color="orange" size="small">关键</Tag> : null}
        </Space>
      )
    },
    {
      title: '标准区间',
      width: 180,
      render: (_value, record) =>
        record.point ? `${record.point.standardMin} ~ ${record.point.standardMax} ${record.point.unit}` : '—'
    },
    {
      title: '读数',
      width: 120,
      render: (_value, record) => `${record.reading.value} ${record.point?.unit ?? ''}`
    },
    {
      title: '偏差率',
      width: 110,
      render: (_value, record) => (
        <span style={{ color: record.level === '严重超标' ? '#f53f3f' : '#ff7d00' }}>
          {record.reading.deviationPct.toFixed(2)}%
        </span>
      )
    },
    {
      title: '判定',
      width: 170,
      render: (_value, record) => (
        <AbnormalTag level={record.level} deviationPct={record.reading.deviationPct} size="small" />
      )
    },
    {
      title: '巡检日期',
      width: 120,
      render: (_value, record) => record.patrol?.planDate ?? '—'
    },
    {
      title: '备注',
      width: 180,
      render: (_value, record) => record.reading.note || '—'
    },
    {
      title: '操作',
      width: 280,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => confirm(record)}>
            {record.point?.unit === 'ppm' ? '派发处置单' : '确认异常'}
          </Button>
          <Button type="text" size="small" onClick={() => openFix(record)}>
            修正读数
          </Button>
          <Popconfirm title="确认删除该条误录读数？" onOk={() => removeReading(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
          <Button type="text" size="small" onClick={() => navigate('/leaks')}>
            处置台账
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">异常判定与分级</h2>
          <p className="page-head__desc">
            关键点偏差率 &gt; {CRITICAL_DEVIATION_PCT}%、普通点 &gt; {SEVERE_DEVIATION_PCT}% 判严重超标；按权重降序排列。
          </p>
        </div>
        <div className="page-head__actions">
          <Button disabled={selectedKeys.length === 0} onClick={confirmSelected}>
            批量确认（{selectedKeys.length}）
          </Button>
          <Button type="primary" onClick={() => navigate('/leaks')}>
            前往泄漏处置
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="异常读数" value={rows.length} suffix="条" tone="warning" />
        <StatBadge label="严重超标" value={rows.filter((row) => row.level === '严重超标').length} suffix="条" tone="danger" />
        <StatBadge label="泄漏类异常" value={leakConcentrationRows.length} suffix="条" tone="info" />
        <StatBadge label="待处置泄漏单" value={leakStore.counts()['待处置']} suffix="张" tone="default" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            异常清单（{rows.length}）
          </h3>
          <span className="muted">勾选后可批量确认；浓度类点位会直接派发泄漏处置单</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有异常读数"
            description="所有已录入读数均在标准区间内，或尚未录入读数。"
            secondaryText="前往巡检录入"
            onSecondary={() => navigate('/patrols')}
            compact
          />
        ) : (
          <Table<AbnormalRow>
            rowKey={(record: AbnormalRow) => record.reading.id}
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1600 }}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: (keys: (string | number)[]) => setSelectedKeys(keys.map((key) => String(key)))
            }}
          />
        )}
      </div>

      <Modal
        visible={fixOpen}
        title={fixTarget?.point ? `修正读数 · ${fixTarget.point.name}` : '修正读数'}
        onCancel={() => setFixOpen(false)}
        onOk={submitFix}
        okText="保存并重算"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={fixForm} layout="vertical">
          <Form.Item
            field="value"
            label={`实测读数（${fixTarget?.point?.unit ?? ''}）`}
            rules={[{ required: true, message: '请填写读数' }]}
          >
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="note" label="现场备注">
            <Input.TextArea placeholder="如 便携式检漏仪复测，读数修正" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
