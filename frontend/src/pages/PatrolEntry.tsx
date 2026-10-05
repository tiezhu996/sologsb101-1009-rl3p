/**
 * /patrols 巡检录入
 * 按计划日期逐点录入压力/温度/泄漏浓度，录入即与标准区间比对并给出异常级别。
 * - 标准升级后未提交草稿标「待复核」，保留原值与新旧差异
 * - 读数/完成巡检走行版本乐观锁，冲突完整留待合并，写入失败可从本地草稿找回
 * - 已保存读数按冻结的当时标准展示，后来的标准不改判
 * 消费 Patrol、Reading、Point；复用 <AbnormalTag>、<FilterBar>、<EmptyPanel>、<StatBadge>。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
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
import { usePatrolStore, type SaveOutcome } from '@/stores/patrolStore'
import { useMergeStore } from '@/stores/mergeStore'
import { usePatrolGap } from '@/hooks/usePatrolGap'
import { PATROL_STATES, type Patrol, type PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading } from '@/types/reading'
import { abnormalLevelOf, formatValue, rangeText } from '@/utils/range'

function describeOutcome(outcome: SaveOutcome, action: string): void {
  if (outcome.status === 'saved') {
    Message.success(outcome.count > 0 ? `已保存 ${outcome.count} 条读数，异常判定按提交时标准冻结` : `${action}成功`)
  } else if (outcome.status === 'conflict') {
    Message.warning('另一个标签页已先提交本巡检，本份已完整保留到「待处理中心」，可继续合并')
  } else {
    Message.error('写入失败，内容已存入本地草稿，可在顶部「待处理中心」重试找回')
  }
}

export default function PatrolEntry() {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const mergeStore = useMergeStore()

  const [completeForm] = Form.useForm<{ patrolDate: string; patrolman: string; envNote: string }>()
  const [noteForm] = Form.useForm<{ note: string }>()
  const [completeOpen, setCompleteOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteTarget, setNoteTarget] = useState<Reading | null>(null)

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

  const patrols = patrolStore.filteredPatrols()
  const activePatrol = patrolStore.activePatrolId
    ? patrolStore.patrols.find((patrol) => patrol.id === patrolStore.activePatrolId) ?? null
    : null

  /** 当前站点下所有设备点位 */
  const activePoints = useMemo<Point[]>(() => {
    if (!activePatrol) return []
    const deviceIds = stationStore.devices
      .filter((device) => device.stationId === activePatrol.stationId)
      .map((device) => device.id)
    return stationStore.points.filter((point) => deviceIds.includes(point.deviceId))
  }, [activePatrol, stationStore.devices, stationStore.points])

  const activeReadings = activePatrol ? patrolStore.readingsOfPatrol(activePatrol.id) : []

  useEffect(() => {
    if (activePatrol) patrolStore.seedDraftFromReadings(activePatrol.id, activePoints)
    // 仅在切换巡检任务或点位集合变化时回填草稿
  }, [activePatrol?.id, activePoints.length])

  const abnormalInDraft = activePoints.filter((point) => {
    const entry = patrolStore.draftEntry(activePatrol?.id ?? '', point.id)
    if (!entry || entry.needsReview) return false
    return patrolStore.judge(point, entry.value).isAbnormal
  }).length

  const reviewCount = activePatrol ? patrolStore.reviewCountOf(activePatrol.id) : 0
  const targetPendingMerges = activePatrol ? mergeStore.listOfTarget(activePatrol.id) : []

  const saveAll = async (): Promise<void> => {
    if (!activePatrol) return
    if (patrolStore.reviewCountOf(activePatrol.id) > 0) {
      Message.warning('存在标准更新后的待复核草稿，请先逐条「复核保留」或「按新值修改」')
      return
    }
    const outcome = await patrolStore.saveReadingDrafts(activePatrol.id, activePoints)
    describeOutcome(outcome, '保存')
  }

  const openComplete = (): void => {
    if (!activePatrol) return
    completeForm.setFieldsValue({
      patrolDate: new Date().toISOString().slice(0, 10),
      patrolman: activePatrol.patrolman,
      envNote: activePatrol.envNote
    })
    setCompleteOpen(true)
  }

  const submitComplete = async (): Promise<void> => {
    if (!activePatrol) return
    if (patrolStore.reviewCountOf(activePatrol.id) > 0) {
      Message.warning('存在待复核草稿，请先完成复核再提交巡检')
      setCompleteOpen(false)
      return
    }
    const values = await completeForm.validate().catch(() => null)
    if (!values) return
    const outcome = await patrolStore.completePatrolWithReadings(
      activePatrol.id,
      values.patrolDate,
      values.patrolman,
      values.envNote,
      activePoints
    )
    describeOutcome(outcome, '完成')
    if (outcome.status === 'saved') setCompleteOpen(false)
  }

  const markMissed = async (patrol: Patrol): Promise<void> => {
    await patrolStore.markMissed(patrol.id, '超期未执行，已标记漏检')
    Message.warning('已标记为漏检，可在巡检计划页跟踪')
  }

  const openNote = (reading: Reading): void => {
    setNoteTarget(reading)
    noteForm.setFieldsValue({ note: reading.note })
    setNoteOpen(true)
  }

  const submitNote = async (): Promise<void> => {
    const values = await noteForm.validate().catch(() => null)
    if (!values || !noteTarget) return
    await patrolStore.saveSingleReading(
      noteTarget.patrolId,
      stationStore.points.find((point) => point.id === noteTarget.pointId) as Point,
      noteTarget.value,
      values.note
    )
    Message.success('现场备注已保存（异常判定仍按该读数冻结的标准）')
    setNoteOpen(false)
  }

  /** 已保存读数的判定区间：优先用冻结快照，保证历史不改判 */
  const frozenPointView = (reading: Reading): Point | null => {
    const current = stationStore.points.find((item) => item.id === reading.pointId) ?? null
    const snapshot = reading.standardSnapshot
    if (!snapshot || !current) return current
    return {
      ...current,
      standardMin: snapshot.standardMin,
      standardMax: snapshot.standardMax,
      unit: snapshot.unit,
      isCritical: snapshot.isCritical,
      standardVersion: snapshot.version
    }
  }

  const readingColumns: TableColumnProps<Reading>[] = [
    {
      title: '点位',
      width: 140,
      render: (_value, record) => stationStore.points.find((point) => point.id === record.pointId)?.name ?? '点位已删除'
    },
    {
      title: '判定标准（当时冻结）',
      width: 210,
      render: (_value, record) => {
        const frozen = frozenPointView(record)
        if (!frozen) return '—'
        return (
          <Space size={4}>
            <Tag size="small" color="gray">v{record.standardSnapshot?.version ?? '—'}</Tag>
            <span>{rangeText(frozen.standardMin, frozen.standardMax, frozen.unit)}</span>
          </Space>
        )
      }
    },
    { title: '读数', dataIndex: 'value', width: 120, render: (value: number, record) => formatValue(value, record.standardSnapshot?.unit ?? '') },
    { title: '偏差率', dataIndex: 'deviationPct', width: 110, render: (value: number) => `${value.toFixed(2)}%` },
    {
      title: '判定',
      width: 160,
      render: (_value, record) => (
        <AbnormalTag
          level={abnormalLevelOf(record.deviationPct, record.standardSnapshot?.isCritical ?? false)}
          deviationPct={record.deviationPct}
          size="small"
        />
      )
    },
    { title: '备注', dataIndex: 'note', width: 200, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openNote(record)}>
            备注
          </Button>
          <Popconfirm title="确认删除该读数？" onOk={() => patrolStore.removeReading(record.id)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检录入</h2>
          <p className="page-head__desc">
            选定巡检任务后逐点录入读数，系统即时给出偏差率与异常级别；标准更新后的草稿先标待复核，完成后判定永久冻结。
          </p>
        </div>
        <div className="page-head__actions">
          <Button disabled={!activePatrol} onClick={saveAll}>
            保存全部读数
          </Button>
          <Button type="primary" disabled={!activePatrol} onClick={openComplete}>
            完成巡检
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="巡检任务" value={patrolStore.patrols.length} suffix="次" tone="primary" />
        <StatBadge label="已完成" value={patrolStore.patrols.filter((item) => item.state === '已完成').length} suffix="次" tone="success" />
        <StatBadge label="待巡检" value={patrolStore.patrols.filter((item) => item.state === '待巡检').length} suffix="次" tone="info" />
        <StatBadge label="漏检 / 超期" value={gap.overdueCount} suffix="次" tone="danger" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder=""
        onModelChange={onModelChange}
      />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">巡检任务（{patrols.length}）</h3>
          {patrols.length === 0 ? (
            <EmptyPanel title="没有巡检任务" description="可到巡检计划页按站点批量生成计划。" compact />
          ) : (
            patrols.map((patrol) => {
              const item = gap.gapOf(patrol)
              const station = stationStore.stations.find((entry) => entry.id === patrol.stationId)
              const pendingCount = mergeStore.listOfTarget(patrol.id).length
              return (
                <div
                  key={patrol.id}
                  className={`card-list-item${patrol.id === patrolStore.activePatrolId ? ' is-active' : ''}`}
                  onClick={() => patrolStore.setActivePatrol(patrol.id)}
                >
                  <div className="card-list-item__head">
                    <span>{station ? station.name : '未知站点'}</span>
                    <Space size={4}>
                      {pendingCount > 0 ? <Tag color="orange" size="small">待合并 {pendingCount}</Tag> : null}
                      <Tag color={patrol.state === '已完成' ? 'green' : patrol.state === '漏检' ? 'red' : 'blue'}>
                        {patrol.state}
                      </Tag>
                    </Space>
                  </div>
                  <div className="card-list-item__meta">
                    <span>计划 {patrol.planDate}</span>
                    <span>· 实际 {patrol.patrolDate || '未执行'}</span>
                    <span>· {patrol.patrolman || '未指派'}</span>
                  </div>
                  <div className="card-list-item__meta">
                    <span style={{ color: item.overdue ? '#f53f3f' : undefined }}>{item.text}</span>
                  </div>
                  <div className="card-list-item__meta" style={{ gap: 8 }}>
                    <Button
                      type="text"
                      size="small"
                      disabled={patrol.state === '已完成'}
                      onClick={(event) => {
                        event.stopPropagation()
                        patrolStore.setActivePatrol(patrol.id)
                        openComplete()
                      }}
                    >
                      完成
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      disabled={patrol.state === '已完成'}
                      onClick={(event) => {
                        event.stopPropagation()
                        void markMissed(patrol)
                      }}
                    >
                      标记漏检
                    </Button>
                    <Popconfirm
                      title="删除该巡检任务将同时删除其读数"
                      onOk={() => patrolStore.removePatrol(patrol.id)}
                    >
                      <Button type="text" size="small" status="danger" onClick={(event) => event.stopPropagation()}>
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="panel">
          {activePatrol ? (
            <>
              <div className="panel-head">
                <h3 className="panel-title" style={{ margin: 0 }}>
                  逐点录入 · {stationStore.stations.find((item) => item.id === activePatrol.stationId)?.name ?? ''}
                  <span className="muted"> （{activePatrol.planDate}，{activePoints.length} 个点位）</span>
                </h3>
                <span className="muted">
                  草稿异常 {abnormalInDraft} 项 · 待复核 {reviewCount} 项 · 已存档异常 {activeReadings.filter((item) => item.isAbnormal).length} 项
                </span>
              </div>

              {targetPendingMerges.length > 0 ? (
                <Alert
                  type="warning"
                  style={{ margin: '8px 0' }}
                  content={`本巡检有 ${targetPendingMerges.length} 份其他标签页的并发提交待合并，请在顶部「待处理中心」处理。`}
                />
              ) : null}

              {activePatrol.state === '已完成' ? (
                <Alert
                  type="info"
                  style={{ margin: '8px 0' }}
                  content="该巡检已完成：所有读数按完成时的标准版本冻结判定，之后修改点位标准不会改判历史异常或已派发的泄漏处置单。"
                />
              ) : null}

              {activePoints.length === 0 ? (
                <EmptyPanel
                  title="该站点暂无点位"
                  description="先到点位配置页为设备配置标准值区间。"
                  compact
                />
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                    gap: 12,
                    marginBottom: 16
                  }}
                >
                  {activePoints.map((point) => {
                    const entry = patrolStore.draftEntry(activePatrol.id, point.id)
                    const value = entry?.value
                    const currentJudgement = value === undefined ? null : patrolStore.judge(point, value)
                    const saved = activeReadings.find((item) => item.pointId === point.id)
                    return (
                      <div
                        key={point.id}
                        className="panel"
                        style={{
                          padding: 12,
                          border: entry?.needsReview ? '1px solid #ff7d00' : undefined,
                          background: entry?.needsReview ? '#fff7e8' : undefined
                        }}
                      >
                        <div className="card-list-item__head">
                          <span>
                            {point.name}
                            {point.isCritical ? <Tag color="orange" size="small" style={{ marginLeft: 6 }}>关键点</Tag> : null}
                            <Tag size="small" style={{ marginLeft: 6 }}>标准 v{point.standardVersion}</Tag>
                          </span>
                          {entry?.needsReview ? (
                            <Tag color="orange" size="small">待复核</Tag>
                          ) : currentJudgement ? (
                            <AbnormalTag level={currentJudgement.level} deviationPct={currentJudgement.deviationPct} size="small" />
                          ) : null}
                        </div>
                        <div className="card-list-item__meta">
                          <span>
                            现行 {rangeText(point.standardMin, point.standardMax, point.unit)}
                          </span>
                          {saved ? <span>· 已存档 {saved.value}</span> : null}
                        </div>

                        {entry?.needsReview ? (
                          <div style={{ marginTop: 8 }}>
                            <Alert
                              type="warning"
                              style={{ fontSize: 12 }}
                              content={
                                <div>
                                  <div>
                                    录入原值 <strong>{formatValue(entry.value, point.unit)}</strong> 依据 v{entry.basisVersion}
                                    ，现行标准 v{entry.latestVersion}
                                  </div>
                                  <div>
                                    原偏差 {entry.oldDeviationPct?.toFixed(2) ?? '—'}% ·
                                    原判定 {entry.oldIsAbnormal ? '异常' : '正常'} ·
                                    新偏差 {currentJudgement ? `${currentJudgement.deviationPct.toFixed(2)}%` : '—'} ·
                                    新判定 {currentJudgement?.level ?? '—'}
                                  </div>
                                </div>
                              }
                            />
                            <Space size={6} style={{ marginTop: 8 }} wrap>
                              <InputNumber
                                size="small"
                                style={{ width: 130 }}
                                value={value}
                                step={point.unit === 'ppm' ? 1 : 0.01}
                                onChange={(next: number | undefined) => {
                                  if (next === undefined) return
                                  // 修改数值即视为按新标准重录（清除待复核）
                                  patrolStore.reviseDraft(activePatrol.id, point, Number(next))
                                }}
                              />
                              <Button
                                size="small"
                                type="primary"
                                onClick={() => {
                                  patrolStore.acknowledgeDraft(activePatrol.id, point)
                                  Message.success(`已复核：保留原值 ${formatValue(entry.value, point.unit)}，按新标准 v${point.standardVersion} 判定`)
                                }}
                              >
                                复核保留原值
                              </Button>
                            </Space>
                          </div>
                        ) : (
                          <Space style={{ marginTop: 8 }}>
                            <InputNumber
                              size="small"
                              style={{ width: 140 }}
                              value={value}
                              step={point.unit === 'ppm' ? 1 : 0.01}
                              placeholder="输入读数"
                              onChange={(next: number | undefined) => {
                                if (next === undefined) return
                                patrolStore.setReadingDraft(activePatrol.id, point, Number(next))
                              }}
                            />
                            <Button
                              size="small"
                              disabled={value === undefined}
                              onClick={async () => {
                                if (value === undefined) return
                                await patrolStore.saveSingleReading(activePatrol.id, point, value, entry?.note ?? saved?.note ?? '')
                                Message.success(`${point.name} 读数已保存（按标准 v${point.standardVersion} 冻结）`)
                              }}
                            >
                              保存
                            </Button>
                          </Space>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <h4 className="panel-title">已保存读数</h4>
              {activeReadings.length === 0 ? (
                <EmptyPanel title="暂无已保存读数" description="录入后点击「保存全部读数」或逐点保存；草稿已存本地，重开页面可继续。" compact />
              ) : (
                <Table<Reading>
                  rowKey="id"
                  size="small"
                  border
                  data={activeReadings}
                  columns={readingColumns}
                  pagination={false}
                  scroll={{ x: 1200 }}
                />
              )}
            </>
          ) : (
            <EmptyPanel title="尚未选择巡检任务" description="在左侧任务列表中选择一次巡检后即可逐点录入读数。" compact />
          )}
        </div>
      </div>

      <Modal
        visible={completeOpen}
        title="完成巡检"
        onCancel={() => setCompleteOpen(false)}
        onOk={submitComplete}
        okText="确认完成"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={completeForm} layout="vertical">
          <Form.Item field="patrolDate" label="实际日期" rules={[{ required: true, message: '请填写实际日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="patrolman" label="巡检人" rules={[{ required: true, message: '请填写巡检人' }]}>
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="envNote" label="现场环境备注">
            <Input.TextArea placeholder="如 晴，气温 26℃，无异常气味" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
        <div className="muted">
          完成后全部读数按当前标准版本冻结；若其他标签页已先提交，本份将完整保留到待处理中心而不是覆盖。
        </div>
      </Modal>

      <Modal
        visible={noteOpen}
        title="现场备注"
        onCancel={() => setNoteOpen(false)}
        onOk={submitNote}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={noteForm} layout="vertical">
          <Form.Item field="note" label="备注">
            <Input.TextArea placeholder="如 便携式检漏仪测得，有轻微气味" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
