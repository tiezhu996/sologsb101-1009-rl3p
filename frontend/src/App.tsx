/**
 * 应用外壳：顶部导航 + 当前站点上下文 + 页脚，页面通过 <Outlet> 渲染。
 */
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Badge, Button, Space, Tag, Typography } from '@arco-design/web-react'
import { ROUTES } from './router'
import { useStationStore } from './stores/stationStore'
import { usePatrolStore } from './stores/patrolStore'
import { useLeakStore } from './stores/leakStore'
import { usePatrolGap } from './hooks/usePatrolGap'

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const leakStore = useLeakStore()
  const gap = usePatrolGap(patrolStore.patrols)

  const currentStation = stationStore.currentStation()

  const navItems = [
    { path: ROUTES.stations, label: '调压站台账', count: stationStore.stations.length },
    { path: ROUTES.points, label: '点位配置', count: stationStore.points.length },
    { path: ROUTES.patrols, label: '巡检录入', count: patrolStore.patrols.length },
    { path: ROUTES.abnormal, label: '异常分级', count: patrolStore.abnormalRows().length },
    { path: ROUTES.leaks, label: '泄漏处置', count: leakStore.counts()['待处置'] },
    { path: ROUTES.plans, label: '巡检计划', count: gap.overdueCount }
  ]

  const activePath = navItems.find((item) => location.pathname.startsWith(item.path))?.path ?? ROUTES.stations

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__mark">燃</span>
          <div>
            <h1 className="app-header__title">燃气调压站巡检与泄漏处置台</h1>
            <p className="app-header__sub">调压站 · 设备 · 点位标准值 · 巡检读数 · 异常分级 · 泄漏闭环</p>
          </div>
        </div>
        <nav className="app-nav">
          {navItems.map((item) => (
            <button
              key={item.path}
              type="button"
              className={`app-nav__item${activePath === item.path ? ' is-active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span>{item.label}</span>
              {item.count > 0 ? <em className="app-nav__badge">{item.count}</em> : null}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 12
          }}
        >
          <Space size={8} wrap>
            <Typography.Text bold>当前调压站：</Typography.Text>
            {currentStation ? (
              <>
                <Tag color="arcoblue">{currentStation.name}</Tag>
                <Tag>{currentStation.grade}</Tag>
                <Tag color="orange">{currentStation.location}</Tag>
              </>
            ) : (
              <Tag>未选择调压站</Tag>
            )}
          </Space>
          <Space size={8} wrap>
            <Badge count={leakStore.counts()['待处置']} dotStyle={{ background: '#f53f3f' }} />
            <Button size="small" onClick={() => navigate(ROUTES.stations)}>
              调压站台账
            </Button>
            <Button size="small" type="primary" onClick={() => navigate(ROUTES.leaks)}>
              泄漏处置
            </Button>
          </Space>
        </div>
        <Outlet />
      </main>

      <footer className="app-footer">
        <span>数据仅保存于本机浏览器（IndexedDB / localStorage），不上传任何服务器。</span>
        <span>
          调压站 {stationStore.stations.length} 座 · 设备 {stationStore.devices.length} 台 · 点位 {stationStore.points.length} 个 ·
          巡检 {patrolStore.patrols.length} 次 · 读数 {patrolStore.readings.length} 条 · 超期未检 {gap.overdueCount} 次
        </span>
      </footer>
    </div>
  )
}
