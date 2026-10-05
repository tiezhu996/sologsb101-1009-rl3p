/**
 * /stations 调压站与设备台账
 * 新建站点与设备、按压力等级与设备类型筛选；卡片回显设备数与待处置泄漏数。
 * 消费 Station、Device；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
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
import { useLeakStore } from '@/stores/leakStore'
import {
  DEVICE_STATES,
  DEVICE_TYPES,
  EMPTY_DEVICE_DRAFT,
  type Device,
  type DeviceDraft,
  type DeviceState,
  type DeviceType
} from '@/types/device'
import {
  EMPTY_STATION_DRAFT,
  STATION_GRADES,
  formatFlow,
  formatPressure,
  type Station,
  type StationDraft,
  type StationGrade
} from '@/types/station'

export default function StationList() {
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const leakStore = useLeakStore()

  const [stationForm] = Form.useForm<StationDraft>()
  const [deviceForm] = Form.useForm<DeviceDraft>()
  const [stationOpen, setStationOpen] = useState(false)
  const [deviceOpen, setDeviceOpen] = useState(false)
  const [editingStationId, setEditingStationId] = useState<string | null>(null)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)

  const filter = stationStore.filter
  const filtered = stationStore.filteredStations()
  const currentStation = stationStore.currentStation()
  const devices = currentStation ? stationStore.devicesOfStation(currentStation.id) : []

  const filterSelects = useMemo(
    () => [
      { key: 'grades', label: '压力等级', options: STATION_GRADES.map((item) => ({ label: item, value: item })) },
      { key: 'deviceTypes', label: '设备类型', options: DEVICE_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    []
  )

  const model: FilterModel = { keyword: filter.keyword, grades: filter.grades, deviceTypes: filter.deviceTypes }

  const onModelChange = (next: FilterModel): void => {
    stationStore.patchFilter({
      keyword: String(next.keyword ?? ''),
      grades: (Array.isArray(next.grades) ? next.grades : []) as StationGrade[],
      deviceTypes: (Array.isArray(next.deviceTypes) ? next.deviceTypes : []) as DeviceType[]
    })
  }

  const openLeakOf = (stationId: string): number =>
    leakStore.leaks.filter((leak) => leak.stationId === stationId && leak.state !== '已复检').length

  const missedOf = (stationId: string): number =>
    patrolStore.patrols.filter((patrol) => patrol.stationId === stationId && patrol.state === '漏检').length

  const openCreateStation = (): void => {
    setEditingStationId(null)
    stationForm.setFieldsValue({ ...EMPTY_STATION_DRAFT })
    setStationOpen(true)
  }

  const openEditStation = (station: Station): void => {
    setEditingStationId(station.id)
    stationForm.setFieldsValue({
      name: station.name,
      location: station.location,
      designFlowM3h: station.designFlowM3h,
      inletPressureMpa: station.inletPressureMpa,
      grade: station.grade,
      commissionDate: station.commissionDate
    })
    setStationOpen(true)
  }

  const submitStation = async (): Promise<void> => {
    const values = await stationForm.validate().catch(() => null)
    if (!values) return
    if (editingStationId) {
      await stationStore.updateStation(editingStationId, values)
      Message.success('调压站信息已更新')
    } else {
      await stationStore.createStation(values)
      Message.success('调压站已创建，可继续登记设备')
    }
    setStationOpen(false)
  }

  const removeStation = async (station: Station): Promise<void> => {
    await stationStore.removeStation(station.id)
    Message.success('调压站及其下游数据已删除')
  }

  const openCreateDevice = (): void => {
    if (!currentStation) {
      Message.warning('请先选择或新建一个调压站')
      return
    }
    setEditingDeviceId(null)
    deviceForm.setFieldsValue({ ...EMPTY_DEVICE_DRAFT, stationId: currentStation.id })
    setDeviceOpen(true)
  }

  const openEditDevice = (device: Device): void => {
    setEditingDeviceId(device.id)
    deviceForm.setFieldsValue({
      stationId: device.stationId,
      type: device.type,
      model: device.model,
      serialNo: device.serialNo,
      installDate: device.installDate,
      state: device.state
    })
    setDeviceOpen(true)
  }

  const submitDevice = async (): Promise<void> => {
    const values = await deviceForm.validate().catch(() => null)
    if (!values) return
    if (editingDeviceId) {
      await stationStore.updateDevice(editingDeviceId, values)
      Message.success('设备已更新')
    } else {
      await stationStore.createDevice(values)
      Message.success('设备已登记，可继续配置点位标准值')
    }
    setDeviceOpen(false)
  }

  const removeDevice = async (device: Device): Promise<void> => {
    await stationStore.removeDevice(device.id)
    Message.success('设备及其点位、处置单已删除')
  }

  const deviceColumns: TableColumnProps<Device>[] = [
    { title: '设备类型', dataIndex: 'type', width: 110, render: (value: DeviceType) => <Tag color="arcoblue">{value}</Tag> },
    { title: '型号', dataIndex: 'model', width: 150 },
    { title: '出厂编号', dataIndex: 'serialNo', width: 170 },
    { title: '投用日期', dataIndex: 'installDate', width: 120 },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (value: DeviceState) => (
        <Tag color={value === '运行' ? 'green' : value === '检修' ? 'orange' : 'gray'}>{value}</Tag>
      )
    },
    {
      title: '点位数',
      width: 90,
      render: (_value, record) => stationStore.pointsOfDevice(record.id).length
    },
    {
      title: '操作',
      width: 230,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEditDevice(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该设备将级联删除其点位与泄漏处置单" onOk={() => removeDevice(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
          <Button
            type="text"
            size="small"
            onClick={() => {
              stationStore.patchPointFilter({ stationId: record.stationId, keyword: '' })
              navigate('/points')
            }}
          >
            点位配置
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">调压站与设备台账</h2>
          <p className="page-head__desc">先建站点再登记设备；卡片回显设备数、待处置泄漏数与漏检次数。</p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={openCreateStation}>
            新建调压站
          </Button>
          <Button disabled={!currentStation} onClick={openCreateDevice}>
            登记设备
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="调压站" value={stationStore.stations.length} suffix="座" tone="primary" />
        <StatBadge label="设备" value={stationStore.devices.length} suffix="台" tone="info" />
        <StatBadge label="巡检点位" value={stationStore.pointStats().total} suffix="个" tone="default" />
        <StatBadge label="待处置泄漏" value={leakStore.counts()['待处置']} suffix="单" tone="danger" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索站名 / 位置" onModelChange={onModelChange} />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">调压站列表（{filtered.length}）</h3>
          {filtered.length === 0 ? (
            <EmptyPanel
              title="还没有调压站"
              description="新建调压站后即可登记设备与点位。"
              actionText="新建调压站"
              onAction={openCreateStation}
              compact
            />
          ) : (
            filtered.map((station) => (
              <div
                key={station.id}
                className={`card-list-item${station.id === stationStore.currentStationId ? ' is-active' : ''}`}
                onClick={() => stationStore.selectStation(station.id)}
              >
                <div className="card-list-item__head">
                  <span>{station.name}</span>
                  <Tag color="arcoblue">{station.grade}</Tag>
                </div>
                <div className="card-list-item__meta">
                  <span>{station.location}</span>
                  <span>· 设计 {formatFlow(station.designFlowM3h)}</span>
                  <span>· 进口 {formatPressure(station.inletPressureMpa)}</span>
                </div>
                <div className="card-list-item__meta">
                  <span>设备 {stationStore.devicesOfStation(station.id).length}</span>
                  <span>· 点位 {stationStore.points.filter((point) => point.stationId === station.id).length}</span>
                  <span style={{ color: openLeakOf(station.id) > 0 ? '#f53f3f' : undefined }}>
                    · 待处置泄漏 {openLeakOf(station.id)}
                  </span>
                  <span style={{ color: missedOf(station.id) > 0 ? '#ff7d00' : undefined }}>· 漏检 {missedOf(station.id)}</span>
                </div>
                <div className="card-list-item__meta" style={{ gap: 8 }}>
                  <Button
                    type="text"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation()
                      openEditStation(station)
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm title="删除站点会级联删除设备、点位、巡检与处置单" onOk={() => removeStation(station)}>
                    <Button type="text" size="small" status="danger" onClick={(event) => event.stopPropagation()}>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>
              设备明细{currentStation ? ` · ${currentStation.name}` : ''}
            </h3>
            <span className="muted">共 {devices.length} 台设备</span>
          </div>
          {devices.length === 0 ? (
            <EmptyPanel
              title="该站点暂无设备"
              description="登记调压器、过滤器、切断阀或放散阀后即可配置点位标准值。"
              actionText="登记设备"
              onAction={openCreateDevice}
              compact
            />
          ) : (
            <Table<Device> rowKey="id" size="small" border data={devices} columns={deviceColumns} pagination={false} />
          )}
        </div>
      </div>

      <Modal
        visible={stationOpen}
        title={editingStationId ? '编辑调压站' : '新建调压站'}
        onCancel={() => setStationOpen(false)}
        onOk={submitStation}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={stationForm} layout="vertical" initialValues={EMPTY_STATION_DRAFT}>
          <Form.Item field="name" label="调压站名称" rules={[{ required: true, message: '请填写调压站名称' }]}>
            <Input placeholder="如 城东高中压调压站" />
          </Form.Item>
          <Form.Item field="location" label="位置" rules={[{ required: true, message: '请填写位置' }]}>
            <Input placeholder="如 城东工业园区 A 区" />
          </Form.Item>
          <Form.Item field="grade" label="压力等级" rules={[{ required: true, message: '请选择压力等级' }]}>
            <Select options={STATION_GRADES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="designFlowM3h" label="设计流量(m³/h)" rules={[{ required: true, message: '请填写设计流量' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="inletPressureMpa" label="进口压力(MPa)" rules={[{ required: true, message: '请填写进口压力' }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="commissionDate" label="投运日期" rules={[{ required: true, message: '请填写投运日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={deviceOpen}
        title={editingDeviceId ? '编辑设备' : '登记设备'}
        onCancel={() => setDeviceOpen(false)}
        onOk={submitDevice}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={deviceForm} layout="vertical" initialValues={EMPTY_DEVICE_DRAFT}>
          <Form.Item label="所属调压站">
            <Input value={currentStation ? currentStation.name : ''} disabled />
          </Form.Item>
          <Form.Item field="type" label="设备类型" rules={[{ required: true, message: '请选择设备类型' }]}>
            <Select options={DEVICE_TYPES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如 RTZ-80/0.4" />
          </Form.Item>
          <Form.Item field="serialNo" label="出厂编号" rules={[{ required: true, message: '请填写出厂编号' }]}>
            <Input placeholder="如 SN20160520-01" />
          </Form.Item>
          <Form.Item field="installDate" label="投用日期" rules={[{ required: true, message: '请填写投用日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="state" label="设备状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={DEVICE_STATES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
