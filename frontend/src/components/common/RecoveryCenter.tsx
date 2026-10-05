/**
 * 待合并 / 待恢复中心（全局横幅 + 抽屉）
 * - 并发提交落败的完整载荷：可查看差异、重新应用（可强制覆盖）、放弃
 * - 写入失败的本地兜底载荷：可一键重试找回或丢弃
 * 数据分别持久化在 IndexedDB(pendingMerges) 与 localStorage(failed-writes)，重开后仍可处理。
 */
import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Message,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Timeline,
  Typography
} from '@arco-design/web-react'
import { useMergeStore } from '@/stores/mergeStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { useLeakStore } from '@/stores/leakStore'
import { useStationStore } from '@/stores/stationStore'
import { mergeEntityLabel, type FailedWrite, type PendingMerge } from '@/types/merge'
import { formatValue } from '@/utils/range'

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function MergePayloadDetail({ merge }: { merge: PendingMerge }) {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const leakStore = useLeakStore()
  const { payload } = merge

  if (payload.kind === 'leak') {
    const leak = leakStore.leaks.find((item) => item.id === payload.leakId)
    return (
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text>处置单：{leak ? `${leak.foundTime} · ${leak.concentrationPpm} ppm` : payload.leakId}</Typography.Text>
        {payload.advanceTo ? <Tag color="blue">状态推进到「{payload.advanceTo}」</Tag> : null}
        {payload.patch.measure !== undefined ? <Typography.Text>处置措施：{payload.patch.measure || '—'}</Typography.Text> : null}
        {payload.patch.handler !== undefined ? <Typography.Text>处置/复检人：{payload.patch.handler || '—'}</Typography.Text> : null}
        {payload.patch.retestValuePpm !== undefined ? (
          <Typography.Text>复检浓度：{payload.patch.retestValuePpm} ppm</Typography.Text>
        ) : null}
      </Space>
    )
  }

  const patrol = patrolStore.patrols.find((item) => item.id === payload.patrolId)
  const station = patrol ? stationStore.stations.find((item) => item.id === patrol.stationId) : null
  const readings = payload.kind === 'patrol-complete' ? payload.readings : payload.readings
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text>
        巡检：{station ? station.name : '未知站'} · {patrol ? patrol.planDate : payload.patrolId}
      </Typography.Text>
      {payload.kind === 'patrol-complete' ? (
        <>
          <Tag color="green">完成巡检（实际 {payload.patrolDate}，{payload.patrolman || '未署名'}）</Tag>
          {payload.envNote ? <Typography.Text>环境备注：{payload.envNote}</Typography.Text> : null}
        </>
      ) : (
        <Tag color="arcoblue">批量保存读数</Tag>
      )}
      {readings.length === 0 ? (
        <Typography.Text type="secondary">（无读数载荷，仅状态变更）</Typography.Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {readings.map((item) => {
            const point = stationStore.points.find((entry) => entry.id === item.pointId)
            return (
              <Space key={item.pointId} size={6}>
                <Tag size="small">{point?.name ?? item.pointId}</Tag>
                <span>{formatValue(item.value, point?.unit ?? '')}</span>
                <Typography.Text type="secondary">（依据标准 v{item.standardVersion}）</Typography.Text>
              </Space>
            )
          })}
        </div>
      )}
    </Space>
  )
}

function FailedWriteDetail({ failed }: { failed: FailedWrite }) {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const { payload } = failed
  if (payload.kind === 'leak') {
    return <Typography.Text>处置单 {payload.leakId}：{payload.advanceTo ? `推进到「${payload.advanceTo}」` : '编辑保存'}</Typography.Text>
  }
  const patrol = patrolStore.patrols.find((item) => item.id === payload.patrolId)
  const station = patrol ? stationStore.stations.find((item) => item.id === patrol.stationId) : null
  return (
    <Typography.Text>
      {mergeEntityLabel(failed.type)} · {station ? station.name : payload.patrolId} · {payload.readings.length} 条读数
    </Typography.Text>
  )
}

export default function RecoveryCenter() {
  const mergeStore = useMergeStore()
  const [open, setOpen] = useState(false)

  const pendingMerges = useMemo(
    () => mergeStore.pendingMerges.filter((item) => item.status === '待合并'),
    [mergeStore.pendingMerges]
  )
  const resolvedMerges = useMemo(
    () => mergeStore.pendingMerges.filter((item) => item.status !== '待合并'),
    [mergeStore.pendingMerges]
  )
  const failedWrites = mergeStore.failedWrites
  const total = pendingMerges.length + failedWrites.length

  const apply = async (merge: PendingMerge, force: boolean): Promise<void> => {
    const error = await mergeStore.applyMerge(merge.id, force)
    if (error) {
      Message.warning(error)
      return
    }
    Message.success(force ? '已强制合并，本份内容已覆盖写入' : '已合并到当前记录')
  }

  const confirmForce = (merge: PendingMerge): void => {
    Modal.confirm({
      title: '强制合并将覆盖当前记录',
      content: '先写入者之后的修改会被本份载荷覆盖，确认继续？',
      okText: '强制覆盖',
      cancelText: '取消',
      onOk: () => apply(merge, true)
    })
  }

  const retry = async (failed: FailedWrite): Promise<void> => {
    const ok = await mergeStore.retryFailedWrite(failed.id)
    if (ok) Message.success('已按本地草稿重试写入成功')
    else Message.error('重试仍失败，请稍后再试')
  }

  return (
    <>
      {total > 0 ? (
        <div
          className="panel"
          style={{
            marginBottom: 12,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            border: '1px solid #ffb65d',
            background: '#fff7e8'
          }}
        >
          <Space size={10} wrap>
            <Badge count={total} color="#ff7d00" />
            <Typography.Text>
              有 {pendingMerges.length} 份并发提交待合并、{failedWrites.length} 份写入失败待恢复（重开页面后仍可处理）
            </Typography.Text>
          </Space>
          <Button size="small" type="primary" status="warning" onClick={() => setOpen(true)}>
            打开待处理中心
          </Button>
        </div>
      ) : null}

      <Drawer
        width={560}
        title={
          <Space>
            <span>待合并 / 待恢复中心</span>
            {total > 0 ? <Tag color="orange">{total} 待处理</Tag> : null}
          </Space>
        }
        visible={open}
        onCancel={() => setOpen(false)}
        footer={
          <Space>
            {resolvedMerges.length > 0 ? (
              <Button size="small" onClick={() => mergeStore.clearResolved()}>
                清除已处理记录（{resolvedMerges.length}）
              </Button>
            ) : null}
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </Space>
        }
      >
        <Timeline>
          {pendingMerges.map((merge) => (
            <Timeline.Item key={merge.id} dotColor="#ff7d00" label={formatTime(merge.createdAt)}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space size={6}>
                  <Tag color="orange">{mergeEntityLabel(merge.type)}</Tag>
                  <Typography.Text bold>并发提交 · 完整保留待合并</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {merge.reason}
                </Typography.Text>
                <MergePayloadDetail merge={merge} />
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => void apply(merge, false)}>
                    重新应用
                  </Button>
                  <Button size="small" status="warning" onClick={() => confirmForce(merge)}>
                    强制覆盖合并
                  </Button>
                  <Popconfirm title="放弃后该份提交将被丢弃，确认？" onOk={() => mergeStore.discardMerge(merge.id)}>
                    <Button size="small" status="danger">
                      放弃
                    </Button>
                  </Popconfirm>
                </Space>
              </Space>
            </Timeline.Item>
          ))}

          {failedWrites.map((failed) => (
            <Timeline.Item key={failed.id} dotColor="#f53f3f" label={formatTime(failed.createdAt)}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space size={6}>
                  <Tag color="red">{mergeEntityLabel(failed.type)}</Tag>
                  <Typography.Text bold>写入失败 · 已存本地草稿</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  失败原因：{failed.error}
                </Typography.Text>
                <FailedWriteDetail failed={failed} />
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => void retry(failed)}>
                    重试找回
                  </Button>
                  <Popconfirm title="丢弃后本地草稿将被删除，确认？" onOk={() => mergeStore.removeFailedWriteRow(failed.id)}>
                    <Button size="small" status="danger">
                      丢弃
                    </Button>
                  </Popconfirm>
                </Space>
              </Space>
            </Timeline.Item>
          ))}
        </Timeline>

        {total === 0 ? (
          <Empty description={resolvedMerges.length > 0 ? '待处理项均已处理完毕' : '暂无待合并 / 待恢复内容'} />
        ) : null}
      </Drawer>
    </>
  )
}
