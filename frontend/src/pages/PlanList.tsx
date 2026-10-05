/**
 * /plans 巡检计划与漏检提醒
 * 生成计划、标记漏检站并导出结构版本。
 * 消费 Patrol、Station；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { usePatrolGap } from '@/hooks/usePatrolGap'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  countAll,
  DB_NAME,
  DB_VERSION,
  db,
  exportSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  type ReadingRow
} from '@/utils/db'
import { PATROL_STATES, type Patrol, type PatrolGap, type PatrolState } from '@/types/patrol'
import { exportReadingCsv, exportStructureVersion } from '@/utils/export'

export default function PlanList() {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const readingTable = useIdbTable<ReadingRow>(db.readings, { sortByUpdatedAt: false })

  const [planForm] = Form.useForm<{ stationIds: string[]; planDate: string; patrolman: string }>()
  const [planOpen, setPlanOpen] = useState(false)

  const gap = usePatrolGap(patrolStore.patrols)
  const filter = patrolStore.filter

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '巡检状态', options: PATROL_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = { keyword: '', stationId: filter.stationId, states: filter.states }

  const onModelChange = (next: FilterModel): void => {
    patrolStore.patchFilter({
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      states: (Array.isArray(next.states) ? next.states : []) as PatrolState[]
    })
  }

  const rows = patrolStore.filteredPatrols()

  const openPlan = (): void => {
    if (stationStore.stations.length === 0) {
      Message.warning('请先新建调压站')
      return
    }
    planForm.setFieldsValue({
      stationIds: stationStore.stations.map((station) => station.id),
      planDate: new Date().toISOString().slice(0, 10),
      patrolman: ''
    })
    setPlanOpen(true)
  }

  const submitPlan = async (): Promise<void> => {
    const values = await planForm.validate().catch(() => null)
    if (!values) return
    if (!values.stationIds || values.stationIds.length === 0) {
      Message.warning('请至少选择一个调压站')
      return
    }
    const created = await patrolStore.generatePlans(values.stationIds, values.planDate, values.patrolman)
    Message.success(created === 0 ? '所选站点当日计划已存在' : `已生成 ${created} 条巡检计划`)
    setPlanOpen(false)
  }

  const markMissed = async (patrol: Patrol): Promise<void> => {
    await patrolStore.markMissed(patrol.id, '超期未执行，已标记漏检')
    Message.warning('已标记为漏检')
  }

  const complete = async (patrol: Patrol): Promise<void> => {
    await patrolStore.completePatrol(
      patrol.id,
      new Date().toISOString().slice(0, 10),
      patrol.patrolman || '未署名',
      patrol.envNote || '补检完成'
    )
    Message.success('已补检完成')
  }

  const remove = async (patrol: Patrol): Promise<void> => {
    await patrolStore.removePatrol(patrol.id)
    Message.success('计划已删除')
  }

  const exportStructure = async (): Promise<void> => {
    const counts = await countAll()
    const filename = exportStructureVersion({
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      counts,
      missedPatrolCount: gap.overdueCount,
      exportedAt: new Date().toISOString()
    })
    Message.success(
      `已导出结构版本 ${filename}（记录 v${readStampedDbVersion()}，最近备份 ${readLastBackupAt() ?? '—'}）`
    )
  }

  const exportReadings = (): void => {
    const filename = exportReadingCsv(
      stationStore.stations,
      stationStore.devices,
      stationStore.points,
      patrolStore.patrols,
      readingTable.rows
    )
    Message.success(`已导出 ${filename}`)
  }

  const exportJson = async (): Promise<void> => {
    const payload = await exportSnapshot()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `gbgaspress-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    Message.success('已导出全量 JSON 存档')
  }

  const reseed = async (): Promise<void> => {
    await resetDatabase()
    Message.success('已重置为演示数据')
  }

  const columns: TableColumnProps<Patrol>[] = [
    {
      title: '调压站',
      width: 200,
      render: (_value, record) => stationStore.stations.find((item) => item.id === record.stationId)?.name ?? '—'
    },
    { title: '计划日期', dataIndex: 'planDate', width: 120 },
    { title: '实际日期', dataIndex: 'patrolDate', width: 120, render: (value: string) => value || '未执行' },
    { title: '巡检人', dataIndex: 'patrolman', width: 100, render: (value: string) => value || '未指派' },
    {
      title: '状态',
      width: 100,
      render: (_value, record) => (
        <Tag color={record.state === '已完成' ? 'green' : record.state === '漏检' ? 'red' : 'blue'}>{record.state}</Tag>
      )
    },
    {
      title: '漏检/超期提示',
      width: 220,
      render: (_value, record) => {
        const item = gap.gapOf(record)
        return <span style={{ color: item.overdue ? '#f53f3f' : undefined }}>{item.text}</span>
      }
    },
    { title: '现场备注', dataIndex: 'envNote', width: 220, render: (value: string) => value || '—' },
    {
      title: '读数条数',
      width: 100,
      render: (_value, record) => readingTable.rows.filter((row) => row.patrolId === record.id).length
    },
    {
      title: '操作',
      width: 250,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" disabled={record.state === '已完成'} onClick={() => complete(record)}>
            补检完成
          </Button>
          <Button type="text" size="small" disabled={record.state === '已完成'} onClick={() => markMissed(record)}>
            标记漏检
          </Button>
          <Popconfirm title="删除该计划将同时删除其读数" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const reminderColumns: TableColumnProps<PatrolGap>[] = [
    {
      title: '调压站',
      width: 200,
      render: (_value, record) =>
        stationStore.stations.find((item) => item.id === record.patrol.stationId)?.name ?? '—'
    },
    { title: '计划日期', width: 120, render: (_value, record) => record.patrol.planDate },
    { title: '当前状态', width: 110, render: (_value, record) => record.patrol.state },
    {
      title: '超期天数',
      width: 110,
      render: (_value, record) => <span style={{ color: '#f53f3f' }}>{record.overdueDays} 天</span>
    },
    { title: '提示', render: (_value, record) => record.text },
    {
      title: '操作',
      width: 150,
      render: (_value, record) => (
        <Button type="text" size="small" onClick={() => complete(record.patrol)}>
          立即补检
        </Button>
      )
    }
  ]

  const missedCount = patrolStore.patrols.filter((patrol) => patrol.state === '漏检').length

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检计划与漏检提醒</h2>
          <p className="page-head__desc">
            按站点批量生成巡检计划，计划日期早于今天且未执行的自动计入漏检提醒。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={exportReadings}>导出读数台账 CSV</Button>
          <Button onClick={exportStructure}>导出结构版本</Button>
          <Button onClick={exportJson}>导出全量 JSON</Button>
          <Button type="primary" onClick={openPlan}>
            生成巡检计划
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="计划总数" value={patrolStore.patrols.length} suffix="条" tone="primary" />
        <StatBadge label="待巡检" value={patrolStore.patrols.filter((item) => item.state === '待巡检').length} suffix="条" tone="info" />
        <StatBadge label="漏检标记" value={missedCount} suffix="条" tone="warning" />
        <StatBadge label="超期未检" value={gap.overdueCount} percent={patrolStore.patrols.length === 0 ? 0 : Math.round((gap.overdueCount / patrolStore.patrols.length) * 100)} suffix="条" tone="danger" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            漏检提醒（{gap.reminders.length}）
          </h3>
          <span className="muted">按超期天数降序排列，可一键补检</span>
        </div>
        {gap.reminders.length === 0 ? (
          <EmptyPanel title="暂无漏检与超期" description="所有计划任务均在有效期内或已完成。" compact />
        ) : (
          <Table<PatrolGap>
            rowKey={(record: PatrolGap) => record.patrol.id}
            size="small"
            border
            data={gap.reminders}
            columns={reminderColumns}
            pagination={false}
          />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            巡检计划（{rows.length} / {patrolStore.patrols.length}）
          </h3>
          <Space size={8}>
            <span className="muted">读数台账共 {readingTable.rows.length} 条</span>
            <Button size="small" onClick={reseed}>
              重置为演示数据
            </Button>
          </Space>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="还没有巡检计划"
            description="按站点批量生成计划后即可逐点录入读数。"
            actionText="生成巡检计划"
            onAction={openPlan}
            showSeed
            onSeed={reseed}
            compact
          />
        ) : (
          <Table<Patrol>
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
        visible={planOpen}
        title="批量生成巡检计划"
        onCancel={() => setPlanOpen(false)}
        onOk={submitPlan}
        okText="生成计划"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={planForm} layout="vertical">
          <Form.Item field="stationIds" label="调压站（可多选）" rules={[{ required: true, message: '请选择调压站' }]}>
            <Select
              mode="multiple"
              placeholder="选择需要巡检的调压站"
              options={stationStore.stations.map((station) => ({ label: station.name, value: station.id }))}
            />
          </Form.Item>
          <Form.Item field="planDate" label="计划日期" rules={[{ required: true, message: '请填写计划日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="patrolman" label="巡检人">
            <Input placeholder="如 张伟" />
          </Form.Item>
        </Form>
        <div className="muted">同日同站点已存在的计划会自动跳过，不会重复生成。</div>
      </Modal>
    </div>
  )
}
