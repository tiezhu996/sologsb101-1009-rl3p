/**
 * /patrols 巡检录入
 * 按计划日期逐点录入压力/温度/泄漏浓度，录入即与标准区间比对并给出异常级别。
 *
 * 标准更新口径：
 * - 草稿读数记录录入时版本，标准更新后先标「待复核」，保留原值与差异，可选按新标准重判 / 维持原判定
 * - 已保存读数在巡检完成前同样可待复核；完成后按各自当时标准冻结，后续标准不改判
 *
 * 并发口径：完成巡检走乐观锁，两个标签页并发时先写入的生效，败方完整载荷在下方待合并面板留档。
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
import MergePanel from '@/components/common/MergePanel'
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { useMergeStore } from '@/stores/mergeStore'
import { usePatrolGap } from '@/hooks/usePatrolGap'
import { judgeByStandard } from '@/utils/range'
import { enqueueConflict, enqueueRecovery } from '@/utils/conflict'
import {
  saveSubmitDraft,
  removeSubmitDraftByEntity,
  type LocalSubmitDraft
} from '@/utils/localDraft'
import { createId } from '@/utils/db'
import { PATROL_STATES, type Patrol, type PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading, ReadingDraftMeta } from '@/types/reading'
import type { MergeQueueItem, PatrolCompletePayload } from '@/types/merge'
import { isPatrolPayload } from '@/types/merge'

interface CompleteFormValues {
  patrolDate: string
  patrolman: string
  envNote: string
}

export default function PatrolEntry() {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const mergeStore = useMergeStore()

  const [completeForm] = Form.useForm<CompleteFormValues>()
  const [noteForm] = Form.useForm<{ note: string }>()
  const [completeOpen, setCompleteOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteTarget, setNoteTarget] = useState<Reading | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePatrol?.id, activePoints.length, activePoints.map((p) => p.currentVersionId).join(',')])

  /** 草稿是否待复核：草稿元信息的版本 ≠ 点位当前版本 */
  const draftMetaOf = (pointId: string): ReadingDraftMeta | undefined =>
    activePatrol ? patrolStore.readingDraftMeta[`${activePatrol.id}:${pointId}`] : undefined

  const isDraftStale = (point: Point): boolean => {
    const meta = draftMetaOf(point.id)
    return !!meta && meta.standardVersionId !== point.currentVersionId
  }

  const abnormalInDraft = activePoints.filter((point) => {
    const value = activePatrol ? patrolStore.readingDraft[`${activePatrol.id}:${point.id}`] : undefined
    if (value === undefined) return false
    const meta = draftMetaOf(point.id)
    // 待复核草稿异常仍按录入时旧标准展示，保留原差异
    const standard = meta
      ? {
          standardMin: meta.standardMin,
          standardMax: meta.standardMax,
          standardUnit: meta.standardUnit,
          isCritical: meta.isCritical
        }
      : {
          standardMin: point.standardMin,
          standardMax: point.standardMax,
          standardUnit: point.unit,
          isCritical: point.isCritical
        }
    return judgeByStandard(value, standard).isAbnormal
  }).length

  const pendingCount = activePatrol ? patrolStore.pendingReviewCountOf(activePatrol.id, activePoints) : 0

  const saveAll = async (): Promise<void> => {
    if (!activePatrol) return
    const count = await patrolStore.saveReadingDrafts(activePatrol.id, activePoints)
    if (count === 0) {
      Message.warning('没有可保存的读数，请先录入')
      return
    }
    Message.success(`已保存 ${count} 条读数；待复核项保留原值与差异，处理后才会解除标记`)
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

  /** 构造完成提交的完整载荷（并发败方 / 写入失败时完整留档） */
  const buildCompletePayload = (values: CompleteFormValues): PatrolCompletePayload | null => {
    if (!activePatrol) return null
    return {
      patrol: {
        stationId: activePatrol.stationId,
        planDate: activePatrol.planDate,
        patrolDate: values.patrolDate,
        patrolman: values.patrolman,
        envNote: values.envNote,
        state: '待巡检'
      },
      readings: activePoints
        .map((point) => ({ pointId: point.id, value: patrolStore.readingDraft[`${activePatrol.id}:${point.id}`] }))
        .filter((item) => item.value !== undefined && Number.isFinite(item.value))
    }
  }

  const submitComplete = async (): Promise<void> => {
    if (!activePatrol) return
    const values = await completeForm.validate().catch(() => null)
    if (!values) return
    if (pendingCount > 0) {
      Message.warning(`还有 ${pendingCount} 项待复核（标准已更新），请先选择「按新标准重判」或「维持原判定」`)
      return
    }
    const payload = buildCompletePayload(values)
    if (!payload) return
    const expectedRevision = activePatrol.revision ?? 0
    setSubmitting(true)
    // 提交前先落本地草稿：任何写入失败都能从本地找回
    saveSubmitDraft({
      id: createId('ld'),
      entityType: 'patrol',
      entityId: activePatrol.id,
      title: `${activePatrol.planDate} 巡检完成提交`,
      baseRevision: expectedRevision,
      payload,
      createdAt: Date.now()
    })
    try {
      await patrolStore.saveReadingDrafts(activePatrol.id, activePoints)
      const result = await patrolStore.completePatrol(
        activePatrol.id,
        { patrolDate: values.patrolDate, patrolman: values.patrolman, envNote: values.envNote },
        expectedRevision,
        activePoints
      )
      if (result.outcome === 'committed') {
        removeSubmitDraftByEntity('patrol', activePatrol.id)
        mergeStore.refreshLocalDrafts()
        Message.success('巡检已完成并提交；异常读数按当时标准冻结，可在异常分级页派发处置单')
        setCompleteOpen(false)
      } else {
        // 冲突：败方完整载荷留作待合并
        removeSubmitDraftByEntity('patrol', activePatrol.id)
        mergeStore.refreshLocalDrafts()
        await enqueueConflict({
          entityType: 'patrol',
          entityId: activePatrol.id,
          title: `${activePatrol.planDate} 巡检完成提交（并发冲突）`,
          baseRevision: expectedRevision,
          currentRevision: result.currentRevision,
          payload
        })
        Message.error(
          `另一个标签页已先提交该巡检（v${expectedRevision} → v${result.currentRevision}），你的完整内容已留作待合并`
        )
        setCompleteOpen(false)
      }
    } catch (error) {
      // 非冲突写入失败：本地草稿保留，并在待合并面板登记一条找回条目
      await enqueueRecovery({
        entityType: 'patrol',
        entityId: activePatrol.id,
        title: `${activePatrol.planDate} 巡检完成提交（写入失败）`,
        baseRevision: expectedRevision,
        payload
      })
      mergeStore.refreshLocalDrafts()
      Message.error('写入本地数据库失败，内容已留存：可从下方「待合并 / 待找回」面板找回')
    } finally {
      setSubmitting(false)
    }
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
      values.note,
      { preserveStandard: true }
    )
    Message.success('现场备注已保存（判定维持当时标准）')
    setNoteOpen(false)
  }

  /** 载入并发败方 / 本地找回的完整载荷，重开后继续处理 */
  const adoptPayload = (item: MergeQueueItem | LocalSubmitDraft): void => {
    if (!isPatrolPayload(item.payload)) return
    const patrol = patrolStore.patrols.find((entry) => entry.id === item.entityId)
    if (!patrol) {
      Message.error('原巡检任务已不存在，无法载入')
      return
    }
    patrolStore.setActivePatrol(patrol.id)
    patrolStore.hydrateDraftFromPayload(patrol.id, item.payload.readings, activePointsFor(patrol.stationId))
    completeForm.setFieldsValue({
      patrolDate: item.payload.patrol.patrolDate || new Date().toISOString().slice(0, 10),
      patrolman: item.payload.patrol.patrolman,
      envNote: item.payload.patrol.envNote
    })
    if ('status' in item) {
      void mergeStore.markResolved(item.id, '已处理')
    } else {
      mergeStore.removeLocalDraft(item.id)
    }
    setCompleteOpen(true)
    Message.info('已载入另一份提交内容，请核对后重新提交')
  }

  const activePointsFor = (stationId: string): Point[] => {
    const deviceIds = stationStore.devices
      .filter((device) => device.stationId === stationId)
      .map((device) => device.id)
    return stationStore.points.filter((point) => deviceIds.includes(point.deviceId))
  }

  const readingColumns: TableColumnProps<Reading>[] = [
    {
      title: '点位',
      width: 130,
      render: (_value, record) => stationStore.points.find((point) => point.id === record.pointId)?.name ?? '点位已删除'
    },
    {
      title: '当时标准（冻结）',
      width: 190,
      render: (_value, record) => `${record.standardMin} ~ ${record.standardMax} ${record.standardUnit}（v${record.standardVersionNo || '—'}）`
    },
    { title: '读数', dataIndex: 'value', width: 90, render: (value: number) => value },
    {
      title: '偏差率',
      dataIndex: 'deviationPct',
      width: 100,
      render: (value: number) => `${value.toFixed(2)}%`
    },
    {
      title: '判定',
      width: 150,
      render: (_value, record) => (
        <AbnormalTag level={patrolStore.judgeReadingRow(record).level} size="small" />
      )
    },
    {
      title: '复核',
      width: 260,
      render: (_value, record) => {
        if (record.reviewState !== '待复核') return <Tag color="green">已按当时标准确认</Tag>
        const point = stationStore.points.find((item) => item.id === record.pointId)
        const newJudge = point
          ? patrolStore.judge(point, record.value)
          : null
        return (
          <Space size={4} wrap>
            <Tag color="orange">待复核</Tag>
            <Button
              size="mini"
              type="outline"
              disabled={!point}
              onClick={async () => {
                if (!point) return
                await patrolStore.reviewReadingWithCurrent(record.id, point)
                Message.success('已按新标准重判并冻结')
              }}
            >
              按新标准重判{newJudge ? `（${newJudge.level}）` : ''}
            </Button>
            <Button
              size="mini"
              type="outline"
              onClick={async () => {
                await patrolStore.keepReadingJudgement(record.id)
                Message.success('已维持原判定，按旧标准留痕')
              }}
            >
              维持原判定
            </Button>
          </Space>
        )
      }
    },
    { title: '备注', dataIndex: 'note', width: 160, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 130,
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
            选定巡检任务后逐点录入读数；标准更新后未提交的草稿先标待复核，已完成巡检按当时标准标记异常。
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

      <MergePanel
        entityType="patrol"
        onAdopt={adoptPayload}
        onRecover={(draft: LocalSubmitDraft) => adoptPayload(draft)}
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
              const pending = patrolStore.pendingReviewCountOf(patrol.id, activePointsFor(patrol.stationId))
              return (
                <div
                  key={patrol.id}
                  className={`card-list-item${patrol.id === patrolStore.activePatrolId ? ' is-active' : ''}`}
                  onClick={() => patrolStore.setActivePatrol(patrol.id)}
                >
                  <div className="card-list-item__head">
                    <span>{station ? station.name : '未知站点'}</span>
                    <Space size={4}>
                      {pending > 0 && patrol.state !== '已完成' ? <Tag color="orange">待复核 {pending}</Tag> : null}
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
                  草稿中异常 {abnormalInDraft} 项 / 已存档异常 {activeReadings.filter((item) => item.isAbnormal).length} 项
                </span>
              </div>

              {pendingCount > 0 ? (
                <Alert
                  type="warning"
                  style={{ marginBottom: 12 }}
                  content={`该巡检有 ${pendingCount} 项因标准更新待复核：原值与差异已保留，请逐项选择「按新标准重判」或「维持原判定」后再完成巡检。`}
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
                    const key = `${activePatrol.id}:${point.id}`
                    const value = patrolStore.readingDraft[key]
                    const meta = draftMetaOf(point.id)
                    const stale = isDraftStale(point)
                    const oldJudge =
                      value !== undefined && meta
                        ? judgeByStandard(value, meta)
                        : value !== undefined
                        ? patrolStore.judge(point, value)
                        : null
                    const newJudge = value !== undefined ? patrolStore.judge(point, value) : null
                    const saved = activeReadings.find((item) => item.pointId === point.id)
                    return (
                      <div key={point.id} className="panel" style={{ padding: 12, borderColor: stale ? '#ffb65c' : undefined }}>
                        <div className="card-list-item__head">
                          <span>
                            {point.name}
                            {point.isCritical ? <Tag color="orange" size="small" style={{ marginLeft: 6 }}>关键点</Tag> : null}
                          </span>
                          {oldJudge ? <AbnormalTag level={oldJudge.level} deviationPct={oldJudge.deviationPct} size="small" /> : null}
                        </div>
                        <div className="card-list-item__meta">
                          <span>
                            录入时标准 v{meta?.standardVersionNo ?? point.currentVersionNo}：
                            {meta ? `${meta.standardMin} ~ ${meta.standardMax} ${meta.standardUnit}` : `${point.standardMin} ~ ${point.standardMax} ${point.unit}`}
                          </span>
                        </div>
                        <div className="card-list-item__meta">
                          <span>
                            现行标准 v{point.currentVersionNo}：{point.standardMin} ~ {point.standardMax} {point.unit}
                          </span>
                          {saved ? <span>· 已存档 {saved.value}</span> : null}
                        </div>
                        {stale ? (
                          <Alert
                            style={{ margin: '6px 0' }}
                            type="warning"
                            content={
                              <div>
                                <div>标准已更新，草稿待复核（原值 {value} 与差异 {oldJudge?.deviationPct.toFixed(2)}% 已保留）</div>
                                <Space size={4} style={{ marginTop: 4 }}>
                                  <Button
                                    size="mini"
                                    type="outline"
                                    onClick={() => patrolStore.reviewDraftWithCurrent(activePatrol.id, point)}
                                  >
                                    按新标准重判（{newJudge?.level ?? '—'}）
                                  </Button>
                                  <Button
                                    size="mini"
                                    type="outline"
                                    onClick={() => patrolStore.keepDraftJudgement(activePatrol.id, point)}
                                  >
                                    维持原判定
                                  </Button>
                                </Space>
                              </div>
                            }
                          />
                        ) : null}
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
                              await patrolStore.saveSingleReading(activePatrol.id, point, value, saved ? saved.note : '')
                              Message.success(`${point.name} 读数已按当前标准保存`)
                            }}
                          >
                            保存
                          </Button>
                        </Space>
                      </div>
                    )
                  })}
                </div>
              )}

              <h4 className="panel-title">已保存读数</h4>
              {activeReadings.length === 0 ? (
                <EmptyPanel title="暂无已保存读数" description="录入后点击「保存全部读数」或逐点保存。" compact />
              ) : (
                <Table<Reading>
                  rowKey="id"
                  size="small"
                  border
                  data={activeReadings}
                  columns={readingColumns}
                  pagination={false}
                  scroll={{ x: 1300 }}
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
        confirmLoading={submitting}
        unmountOnExit
      >
        {pendingCount > 0 ? (
          <Alert
            type="error"
            style={{ marginBottom: 12 }}
            content={`尚有 ${pendingCount} 项待复核未处理，完成前请先在录入区选择重判或维持原判定。`}
          />
        ) : null}
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
