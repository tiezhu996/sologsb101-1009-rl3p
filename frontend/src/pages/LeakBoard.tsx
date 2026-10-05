/**
 * /leaks 泄漏处置单与复检闭环
 * 派单、填写措施、录复检浓度并闭环；状态机 待处置 → 已处置 → 已复检。
 *
 * 追溯口径：浓度与异常标记按单据冻结的当时标准展示，后续标准不改判历史处置单。
 * 并发口径：提交走 revision 乐观锁，两个标签页并发时先写入的生效，败方完整载荷留作待合并。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
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
import MergePanel from '@/components/common/MergePanel'
import { useStationStore } from '@/stores/stationStore'
import { useLeakStore } from '@/stores/leakStore'
import { useMergeStore } from '@/stores/mergeStore'
import { enqueueConflict, enqueueRecovery } from '@/utils/conflict'
import {
  saveSubmitDraft,
  removeSubmitDraft,
  type LocalSubmitDraft
} from '@/utils/localDraft'
import { createId, type LeakRow } from '@/utils/db'
import {
  EMPTY_LEAK_DRAFT,
  LEAK_RETEST_PASS_PPM,
  LEAK_STATES,
  LEAK_STATE_FLOW,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'
import { deviationPctOf, formatLeakConcentration, judgeByStandard } from '@/utils/range'
import type { LeakSubmitPayload, MergeQueueItem } from '@/types/merge'
import { isPatrolPayload } from '@/types/merge'

type SubmitKind = 'edit' | 'treat' | 'retest'

export default function LeakBoard() {
  const stationStore = useStationStore()
  const leakStore = useLeakStore()
  const mergeStore = useMergeStore()

  const [form] = Form.useForm<LeakDraft>()
  const [treatForm] = Form.useForm<{ handler: string; measure: string }>()
  const [retestForm] = Form.useForm<{ retestValuePpm: number; handler: string }>()
  const [formOpen, setFormOpen] = useState(false)
  const [treatOpen, setTreatOpen] = useState(false)
  const [retestOpen, setRetestOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [target, setTarget] = useState<LeakRow | null>(null)
  const [keyword, setKeyword] = useState('')

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '处置状态', options: LEAK_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword,
    stationId: leakStore.stationId,
    states: leakStore.stateFilter
  }

  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    leakStore.patchFilter({
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      stateFilter: (Array.isArray(next.states) ? next.states : []) as LeakState[]
    })
  }

  const rows = leakStore.filteredLeaks().filter((leak) => {
    const text = keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === leak.deviceId)
    return (
      (device ? device.model.toLowerCase().includes(text) || device.serialNo.toLowerCase().includes(text) : false) ||
      leak.handler.toLowerCase().includes(text) ||
      leak.measure.toLowerCase().includes(text)
    )
  })

  const deviceOptions = stationStore.devices.map((device) => {
    const station = stationStore.stations.find((item) => item.id === device.stationId)
    return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
  })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    setEditingId(null)
    form.setFieldsValue({ ...EMPTY_LEAK_DRAFT, deviceId: deviceOptions[0].value, foundTime: new Date().toISOString().slice(0, 10) })
    setFormOpen(true)
  }

  const openEdit = (leak: LeakRow): void => {
    setEditingId(leak.id)
    form.setFieldsValue({
      deviceId: leak.deviceId,
      concentrationPpm: leak.concentrationPpm,
      foundTime: leak.foundTime,
      measure: leak.measure,
      state: leak.state,
      retestValuePpm: leak.retestValuePpm,
      handler: leak.handler
    })
    setFormOpen(true)
  }

  /** 构造提交完整载荷（冲突 / 失败时完整留档） */
  const buildPayload = (leak: LeakRow, patch: Partial<LeakDraft>): LeakSubmitPayload => ({
    leakId: leak.id,
    deviceId: patch.deviceId ?? leak.deviceId,
    concentrationPpm: patch.concentrationPpm ?? leak.concentrationPpm,
    foundTime: patch.foundTime ?? leak.foundTime,
    measure: patch.measure ?? leak.measure,
    state: patch.state ?? leak.state,
    retestValuePpm: patch.retestValuePpm ?? leak.retestValuePpm,
    handler: patch.handler ?? leak.handler
  })

  /**
   * 受保护提交：先落本地草稿 → 乐观锁提交
   * - committed：清除本地草稿
   * - conflict：败方完整载荷进 mergeQueue
   * - 其他异常：登记 recovery 条目，本地草稿保留
   */
  const guardedLeakSubmit = async (
    leak: LeakRow,
    kind: SubmitKind,
    patch: Partial<LeakDraft>,
    commit: (expectedRevision: number) => Promise<{ outcome: 'committed' } | { outcome: 'conflict'; currentRevision: number }>
  ): Promise<boolean> => {
    const expectedRevision = leak.revision ?? 0
    const payload = buildPayload(leak, patch)
    const draftId = createId('ld')
    saveSubmitDraft({
      id: draftId,
      entityType: 'leak',
      entityId: leak.id,
      title: `${leak.foundTime} 泄漏处置单 · ${kind === 'edit' ? '编辑' : kind === 'treat' ? '填写措施' : '录入复检'}`,
      baseRevision: expectedRevision,
      payload,
      createdAt: Date.now()
    })
    mergeStore.refreshLocalDrafts()
    try {
      const result = await commit(expectedRevision)
      if (result.outcome === 'committed') {
        removeSubmitDraft(draftId)
        mergeStore.refreshLocalDrafts()
        return true
      }
      removeSubmitDraft(draftId)
      mergeStore.refreshLocalDrafts()
      await enqueueConflict({
        entityType: 'leak',
        entityId: leak.id,
        title: `${leak.foundTime} 泄漏处置单 · 并发冲突`,
        baseRevision: expectedRevision,
        currentRevision: result.currentRevision,
        payload
      })
      Message.error(
        `另一个标签页已先提交该处置单（v${expectedRevision} → v${result.currentRevision}），你的完整内容已留作待合并`
      )
      return false
    } catch (error) {
      await enqueueRecovery({
        entityType: 'leak',
        entityId: leak.id,
        title: `${leak.foundTime} 泄漏处置单 · 写入失败找回`,
        baseRevision: expectedRevision,
        payload
      })
      mergeStore.refreshLocalDrafts()
      Message.error('写入失败，内容已留存：可从下方「待合并 / 待找回」面板找回')
      return false
    }
  }

  const submit = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    if (editingId) {
      const leak = leakStore.leaks.find((item) => item.id === editingId)
      if (!leak) return
      const ok = await guardedLeakSubmit(leak, 'edit', values, (expectedRevision) =>
        leakStore.updateLeak(editingId, values, expectedRevision)
      )
      if (ok) Message.success('处置单已更新')
    } else {
      await leakStore.createLeak(values)
      Message.success('处置单已创建')
    }
    setFormOpen(false)
  }

  const remove = async (leak: Leak): Promise<void> => {
    await leakStore.removeLeak(leak.id)
    Message.success('处置单已删除')
  }

  const advance = async (stale: LeakRow): Promise<void> => {
    // 打开弹窗前取最新行（另一个标签页可能已提交过），避免弹窗里拿着过期 revision
    const leak = leakStore.leaks.find((item) => item.id === stale.id) ?? stale
    const next = LEAK_STATE_FLOW[leak.state]
    if (!next) {
      Message.info('该处置单已完成复检闭环')
      return
    }
    if (next === '已处置') {
      setTarget(leak)
      treatForm.setFieldsValue({ handler: leak.handler, measure: leak.measure })
      setTreatOpen(true)
      return
    }
    setTarget(leak)
    retestForm.setFieldsValue({ retestValuePpm: leak.retestValuePpm || 0, handler: leak.handler })
    setRetestOpen(true)
  }

  const submitTreat = async (): Promise<void> => {
    if (!target) return
    const values = await treatForm.validate().catch(() => null)
    if (!values) return
    const fresh = leakStore.leaks.find((item) => item.id === target.id)
    if (!fresh) {
      Message.error('处置单已不存在')
      setTreatOpen(false)
      return
    }
    const ok = await guardedLeakSubmit(fresh, 'treat', { handler: values.handler, measure: values.measure }, async (expectedRevision) => {
      const result = await leakStore.advance(fresh.id, expectedRevision, { handler: values.handler, measure: values.measure })
      if (result.outcome === 'committed') return { outcome: 'committed' as const }
      if (result.outcome === 'conflict') return { outcome: 'conflict' as const, currentRevision: result.currentRevision }
      return { outcome: 'conflict' as const, currentRevision: expectedRevision }
    })
    if (ok) Message.success('处置措施已归档，状态置为「已处置」')
    if (ok) setTreatOpen(false)
  }

  const submitRetest = async (): Promise<void> => {
    if (!target) return
    const values = await retestForm.validate().catch(() => null)
    if (!values) return
    const fresh = leakStore.leaks.find((item) => item.id === target.id)
    if (!fresh) {
      Message.error('处置单已不存在')
      setRetestOpen(false)
      return
    }
    const ok = await guardedLeakSubmit(
      fresh,
      'retest',
      { state: '已复检', retestValuePpm: values.retestValuePpm, handler: values.handler },
      async (expectedRevision) => {
        const result = await leakStore.submitRetest(fresh.id, expectedRevision, values.retestValuePpm, values.handler)
        if (result.outcome === 'committed') {
          if (result.passed) {
            Message.success(`复检浓度 ${values.retestValuePpm} ppm ≤ ${LEAK_RETEST_PASS_PPM} ppm，判定合格，处置单已闭环`)
          } else {
            Message.warning(`复检浓度 ${values.retestValuePpm} ppm 仍超标，处置单已复检但仍需继续整改`)
          }
          return { outcome: 'committed' as const }
        }
        if (result.outcome === 'conflict') {
          return { outcome: 'conflict' as const, currentRevision: result.currentRevision }
        }
        return { outcome: 'conflict' as const, currentRevision: expectedRevision }
      }
    )
    if (ok) setRetestOpen(false)
  }

  /** 载入待合并 / 找回的完整处置单内容到编辑弹窗 */
  const adoptLeak = (item: MergeQueueItem | LocalSubmitDraft): void => {
    if (isPatrolPayload(item.payload)) return
    const payload = item.payload as LeakSubmitPayload
    const leak = leakStore.leaks.find((entry) => entry.id === payload.leakId)
    if (!leak) {
      Message.error('原处置单已不存在，无法载入')
      return
    }
    setEditingId(leak.id)
    form.setFieldsValue({
      deviceId: payload.deviceId,
      concentrationPpm: payload.concentrationPpm,
      foundTime: payload.foundTime,
      measure: payload.measure,
      state: payload.state,
      retestValuePpm: payload.retestValuePpm,
      handler: payload.handler
    })
    if ('status' in item) {
      void mergeStore.markResolved(item.id, '已处理')
    } else {
      mergeStore.removeLocalDraft(item.id)
    }
    setFormOpen(true)
    Message.info('已载入另一份完整提交内容，请核对当前单据后重新保存')
  }

  const columns: TableColumnProps<LeakRow>[] = [
    {
      title: '调压站 / 设备',
      width: 220,
      render: (_value, record) => {
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '泄漏浓度（当时标准）',
      width: 230,
      render: (_value, record) => {
        // 历史单据按冻结的当时标准算偏差，现行标准变化不改判
        const deviation = deviationPctOf(record.concentrationPpm, record.standardMin, record.standardMax)
        const abnormal = judgeByStandard(record.concentrationPpm, record).isAbnormal
        return (
          <Space size={6}>
            <span style={{ color: abnormal ? '#f53f3f' : undefined, fontWeight: 600 }}>
              {formatLeakConcentration(record.concentrationPpm)}
            </span>
            <Tag color={abnormal ? 'red' : 'green'} size="small">
              偏差 {deviation.toFixed(0)}%
            </Tag>
            <span className="muted">v{record.standardVersionNo || '—'}</span>
          </Space>
        )
      }
    },
    { title: '发现时间', dataIndex: 'foundTime', width: 110 },
    { title: '处置措施', dataIndex: 'measure', width: 220, render: (value: string) => value || '—' },
    {
      title: '状态',
      width: 100,
      render: (_value, record) => (
        <Tag color={record.state === '已复检' ? 'green' : record.state === '已处置' ? 'blue' : 'red'}>{record.state}</Tag>
      )
    },
    {
      title: '复检值',
      width: 150,
      render: (_value, record) => {
        if (record.retestValuePpm <= 0) return <span className="muted">未复检</span>
        return (
          <Space size={6}>
            <span>{formatLeakConcentration(record.retestValuePpm)}</span>
            <Tag color={retestPassed(record.retestValuePpm) ? 'green' : 'red'} size="small">
              {retestPassed(record.retestValuePpm) ? '合格' : '不合格'}
            </Tag>
          </Space>
        )
      }
    },
    { title: '处置人', dataIndex: 'handler', width: 90, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 230,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" disabled={!LEAK_STATE_FLOW[record.state]} onClick={() => advance(record)}>
            {LEAK_STATE_FLOW[record.state] === '已处置' ? '填写措施' : LEAK_STATE_FLOW[record.state] === '已复检' ? '录入复检' : '已闭环'}
          </Button>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该处置单？" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const stats = leakStore.counts()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">泄漏处置单与复检闭环</h2>
          <p className="page-head__desc">
            待处置 → 已处置（填写措施与处置人）→ 已复检（复检浓度 ≤ {LEAK_RETEST_PASS_PPM} ppm 判合格）；历史单据按当时标准留痕。
          </p>
        </div>
        <div className="page-head__actions">
          <Button
            onClick={() => {
              leakStore.patchFilter({ onlyOpen: !leakStore.onlyOpen })
            }}
          >
            {leakStore.onlyOpen ? '查看全部' : '仅看未闭环'}
          </Button>
          <Button type="primary" onClick={openCreate}>
            新建处置单
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="处置单总数" value={leakStore.leaks.length} suffix="张" tone="primary" />
        <StatBadge label="待处置" value={stats['待处置']} suffix="张" tone="danger" />
        <StatBadge label="已处置" value={stats['已处置']} suffix="张" tone="warning" />
        <StatBadge label="复检合格" value={leakStore.retestPassCount()} percent={leakStore.closedPercent()} suffix="张" tone="success" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索设备型号 / 编号 / 处置人" onModelChange={onModelChange} />

      <MergePanel entityType="leak" onAdopt={adoptLeak} onRecover={adoptLeak} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            处置单清单（{rows.length} / {leakStore.leaks.length}）
          </h3>
          <span className="muted">复检不合格的处置单需继续整改并再次复检；并发提交败方内容见上方待合并面板</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的处置单"
            description="可在异常分级页对浓度异常读数直接派发处置单。"
            actionText="新建处置单"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => leakStore.resetFilter()}
            compact
          />
        ) : (
          <Table<LeakRow>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1450 }}
          />
        )}
      </div>

      <Modal
        visible={formOpen}
        title={editingId ? '编辑处置单' : '新建泄漏处置单'}
        onCancel={() => setFormOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_LEAK_DRAFT}>
          <Form.Item field="deviceId" label="泄漏设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="concentrationPpm" label="泄漏浓度(ppm)" rules={[{ required: true, message: '请填写浓度' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="foundTime" label="发现时间" rules={[{ required: true, message: '请填写发现时间' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="measure" label="处置措施">
            <Input.TextArea placeholder="如 更换阀体密封垫并做气密试验" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item field="handler" label="处置人">
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="state" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={LEAK_STATES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="retestValuePpm" label="复检浓度(ppm)">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={treatOpen}
        title="填写处置措施"
        onCancel={() => setTreatOpen(false)}
        onOk={submitTreat}
        okText="确认已处置"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={treatForm} layout="vertical">
          <Form.Item field="handler" label="处置人" rules={[{ required: true, message: '请填写处置人' }]}>
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="measure" label="处置措施" rules={[{ required: true, message: '请填写处置措施' }]}>
            <Input.TextArea placeholder="如 紧固法兰螺栓并涂抹检漏液复测" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={retestOpen}
        title="录入复检结果"
        onCancel={() => setRetestOpen(false)}
        onOk={submitRetest}
        okText="提交复检"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={retestForm} layout="vertical">
          <Form.Item
            field="retestValuePpm"
            label={`复检浓度(ppm)，≤ ${LEAK_RETEST_PASS_PPM} 判合格`}
            rules={[{ required: true, message: '请填写复检浓度' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="handler" label="复检人" rules={[{ required: true, message: '请填写复检人' }]}>
            <Input placeholder="如 李娜" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
