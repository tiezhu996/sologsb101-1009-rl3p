/**
 * /points 巡检点位与标准值配置
 * 维护点位上下限、单位与关键点标记，支持模板批量复制；标准值改动先进草稿再提交。
 * 消费 Point、Device；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<AbnormalTag>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ReadingRow } from '@/utils/db'
import {
  EMPTY_POINT_DRAFT,
  POINT_TEMPLATES,
  POINT_UNITS,
  type Point,
  type PointDraft,
  type PointTemplate
} from '@/types/point'
import { DEVICE_TYPES } from '@/types/device'
import { abnormalLevelOf, deviationPctOf, rangeText } from '@/utils/range'

export default function PointConfig() {
  const stationStore = useStationStore()
  const readingTable = useIdbTable<ReadingRow>(db.readings, { sortByUpdatedAt: false })

  const [pointForm] = Form.useForm<PointDraft>()
  const [templateForm] = Form.useForm<{ deviceId: string }>()
  const [pointOpen, setPointOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checkedTemplates, setCheckedTemplates] = useState<string[]>(POINT_TEMPLATES.map((item) => item.name))

  const filter = stationStore.pointFilter
  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'deviceTypes', label: '设备类型', options: DEVICE_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword: filter.keyword,
    stationId: filter.stationId,
    deviceTypes: filter.deviceTypes
  }

  const onModelChange = (next: FilterModel): void => {
    stationStore.patchPointFilter({
      keyword: String(next.keyword ?? ''),
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      deviceTypes: (Array.isArray(next.deviceTypes) ? next.deviceTypes : []) as string[]
    })
  }

  const rows = stationStore.points.filter((point) => {
    if (filter.stationId && point.stationId !== filter.stationId) return false
    if (filter.onlyCritical && !point.isCritical) return false
    if (filter.deviceTypes.length > 0) {
      const device = stationStore.devices.find((item) => item.id === point.deviceId)
      if (!device || !filter.deviceTypes.includes(device.type)) return false
    }
    const text = filter.keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === point.deviceId)
    return point.name.toLowerCase().includes(text) || (device ? device.model.toLowerCase().includes(text) : false)
  })

  const abnormalCountOf = (pointId: string): number =>
    readingTable.rows.filter((row) => row.pointId === pointId && row.isAbnormal).length

  const deviceOptions = stationStore.devices
    .filter((device) => !filter.stationId || device.stationId === filter.stationId)
    .map((device) => {
      const station = stationStore.stations.find((item) => item.id === device.stationId)
      return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
    })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先在调压站台账登记设备')
      return
    }
    setEditingId(null)
    pointForm.setFieldsValue({ ...EMPTY_POINT_DRAFT, deviceId: deviceOptions[0].value })
    setPointOpen(true)
  }

  const openEdit = (point: Point): void => {
    setEditingId(point.id)
    pointForm.setFieldsValue({
      deviceId: point.deviceId,
      name: point.name,
      standardMin: point.standardMin,
      standardMax: point.standardMax,
      unit: point.unit,
      isCritical: point.isCritical
    })
    setPointOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await pointForm.validate().catch(() => null)
    if (!values) return
    const payload: PointDraft = {
      ...values,
      standardMin: Math.min(values.standardMin, values.standardMax),
      standardMax: Math.max(values.standardMin, values.standardMax)
    }
    if (editingId) {
      await stationStore.updatePoint(editingId, payload)
      Message.success('点位已更新，历史读数偏差率已重算')
    } else {
      await stationStore.createPoint(payload)
      Message.success('点位已创建')
    }
    setPointOpen(false)
  }

  const remove = async (point: Point): Promise<void> => {
    await stationStore.removePoint(point.id)
    Message.success('点位及其读数已删除')
  }

  const commitAll = async (): Promise<void> => {
    const count = await stationStore.commitAllStandardDrafts()
    if (count === 0) {
      Message.warning('没有待提交的标准值草稿')
      return
    }
    Message.success(`已提交 ${count} 个点位的标准值，历史读数已重算`)
  }

  const openTemplate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    templateForm.setFieldsValue({ deviceId: deviceOptions[0].value })
    setCheckedTemplates(POINT_TEMPLATES.map((item) => item.name))
    setTemplateOpen(true)
  }

  const submitTemplate = async (): Promise<void> => {
    const values = await templateForm.validate().catch(() => null)
    if (!values) return
    const chosen: PointTemplate[] = POINT_TEMPLATES.filter((item) => checkedTemplates.includes(item.name))
    if (chosen.length === 0) {
      Message.warning('请至少选择一个模板点位')
      return
    }
    const created = await stationStore.applyTemplate(values.deviceId, chosen)
    Message.success(created === 0 ? '所选模板点位均已存在' : `已按模板复制 ${created} 个点位`)
    setTemplateOpen(false)
  }

  const columns: TableColumnProps<Point>[] = [
    { title: '点位名', dataIndex: 'name', width: 140, render: (value: string) => <strong>{value}</strong> },
    {
      title: '调压站 / 设备',
      width: 220,
      render: (_value, record) => {
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '标准区间（可编辑）',
      width: 330,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const min = draft ? draft.standardMin : record.standardMin
        const max = draft ? draft.standardMax : record.standardMax
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Space size={4}>
            <InputNumber
              size="small"
              style={{ width: 92 }}
              value={min}
              step={0.01}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
                  standardMin: Number(value ?? 0),
                  standardMax: max,
                  isCritical: critical
                })
              }
            />
            <span>~</span>
            <InputNumber
              size="small"
              style={{ width: 92 }}
              value={max}
              step={0.01}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
                  standardMin: min,
                  standardMax: Number(value ?? 0),
                  isCritical: critical
                })
              }
            />
            <span className="muted">{record.unit}</span>
            <Button
              type="text"
              size="small"
              disabled={!draft}
              onClick={async () => {
                await stationStore.commitStandardDraft(record.id)
                Message.success(`${record.name} 标准值已保存，历史读数已重算`)
              }}
            >
              保存
            </Button>
          </Space>
        )
      }
    },
    {
      title: '关键点',
      width: 110,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Switch
            size="small"
            checked={critical}
            onChange={(checked: boolean) =>
              stationStore.setStandardDraft(record.id, {
                standardMin: draft ? draft.standardMin : record.standardMin,
                standardMax: draft ? draft.standardMax : record.standardMax,
                isCritical: checked
              })
            }
          />
        )
      }
    },
    {
      title: '标准区间',
      width: 160,
      render: (_value, record) => rangeText(record.standardMin, record.standardMax, record.unit)
    },
    {
      title: '异常读数',
      width: 170,
      render: (_value, record) => {
        const count = abnormalCountOf(record.id)
        if (count === 0) return <Tag color="green">无异常</Tag>
        const worst = readingTable.rows
          .filter((row) => row.pointId === record.id && row.isAbnormal)
          .reduce((max, row) => Math.max(max, row.deviationPct), 0)
        return <AbnormalTag level={abnormalLevelOf(worst, record.isCritical)} deviationPct={worst} size="small" />
      }
    },
    {
      title: '操作',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该点位将同时删除其巡检读数" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const stats = stationStore.pointStats()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检点位与标准值配置</h2>
          <p className="page-head__desc">
            维护点位上下限、单位与关键点标记；关键点偏差率超过 5% 即判严重超标，普通点为 10%。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={openTemplate}>按模板批量复制</Button>
          <Button disabled={Object.keys(stationStore.standardDraft).length === 0} onClick={commitAll}>
            提交标准值草稿（{Object.keys(stationStore.standardDraft).length}）
          </Button>
          <Button type="primary" onClick={openCreate}>
            新增点位
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="点位总数" value={stats.total} suffix="个" tone="primary" />
        <StatBadge label="关键点" value={stats.critical} suffix="个" tone="warning" />
        <StatBadge label="设备数" value={stationStore.devices.length} suffix="台" tone="info" />
        <StatBadge
          label="异常读数占比"
          value={readingTable.rows.filter((row) => row.isAbnormal).length}
          percent={
            readingTable.rows.length === 0
              ? 0
              : Math.round((readingTable.rows.filter((row) => row.isAbnormal).length / readingTable.rows.length) * 100)
          }
          tone="danger"
        />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索点位名 / 设备型号"
        switchLabel="仅看关键点"
        switchValue={filter.onlyCritical}
        hasSwitch
        onModelChange={onModelChange}
        onSwitchChange={(value: boolean) => stationStore.patchPointFilter({ onlyCritical: value })}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            点位清单（{rows.length} / {stats.total}）
          </h3>
          <span className="muted">标准值改动先进入草稿，保存后自动重算历史读数偏差率</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的点位"
            description="先到调压站台账登记设备，再按模板批量复制或手工新增点位。"
            actionText="新增点位"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => stationStore.resetPointFilter()}
            compact
          />
        ) : (
          <Table<Point>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Modal
        visible={pointOpen}
        title={editingId ? '编辑点位' : '新增点位'}
        onCancel={() => setPointOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={pointForm} layout="vertical" initialValues={EMPTY_POINT_DRAFT}>
          <Form.Item field="deviceId" label="所属设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="name" label="点位名" rules={[{ required: true, message: '请填写点位名' }]}>
            <Input placeholder="如 出口压力 / 阀体泄漏浓度" />
          </Form.Item>
          <Form.Item field="standardMin" label="标准下限" rules={[{ required: true, message: '请填写标准下限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="standardMax" label="标准上限" rules={[{ required: true, message: '请填写标准上限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="unit" label="单位" rules={[{ required: true, message: '请选择单位' }]}>
            <Select options={POINT_UNITS.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="isCritical" label="是否关键点" triggerPropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={templateOpen}
        title="按模板批量复制标准值"
        onCancel={() => setTemplateOpen(false)}
        onOk={submitTemplate}
        okText="复制点位"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={templateForm} layout="vertical">
          <Form.Item field="deviceId" label="目标设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
        </Form>
        <div className="muted" style={{ marginBottom: 8 }}>
          已存在的同名点位会自动跳过：
        </div>
        <Checkbox.Group
          value={checkedTemplates}
          onChange={(values: string[]) => setCheckedTemplates(values)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {POINT_TEMPLATES.map((item) => (
            <Checkbox key={item.name} value={item.name}>
              {item.name}（{rangeText(item.standardMin, item.standardMax, item.unit)}
              {item.isCritical ? ' · 关键点' : ''}）
            </Checkbox>
          ))}
        </Checkbox.Group>
        <div className="muted" style={{ marginTop: 10 }}>
          当前读数平均偏差参考：{deviationPctOf(0.3, 0.18, 0.25).toFixed(2)}%（示例计算）
        </div>
      </Modal>
    </div>
  )
}
