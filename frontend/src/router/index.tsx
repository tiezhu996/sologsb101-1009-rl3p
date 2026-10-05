/**
 * 路由表：/stations、/points、/patrols、/abnormal、/leaks、/plans
 * 页面按路由懒加载，构建时自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, type RouteObject } from 'react-router-dom'
import { Skeleton } from '@arco-design/web-react'
import App from '../App'

const StationList = lazy(() => import('../pages/StationList'))
const PointConfig = lazy(() => import('../pages/PointConfig'))
const PatrolEntry = lazy(() => import('../pages/PatrolEntry'))
const AbnormalBoard = lazy(() => import('../pages/AbnormalBoard'))
const LeakBoard = lazy(() => import('../pages/LeakBoard'))
const PlanList = lazy(() => import('../pages/PlanList'))

export const ROUTES = {
  stations: '/stations',
  points: '/points',
  patrols: '/patrols',
  abnormal: '/abnormal',
  leaks: '/leaks',
  plans: '/plans'
} as const

function RouteFallback() {
  return <Skeleton animation text={{ rows: 6 }} style={{ background: '#ffffff', padding: 16, borderRadius: 10 }} />
}

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.stations} replace /> },
      { path: 'stations', element: withSuspense(<StationList />) },
      { path: 'points', element: withSuspense(<PointConfig />) },
      { path: 'patrols', element: withSuspense(<PatrolEntry />) },
      { path: 'abnormal', element: withSuspense(<AbnormalBoard />) },
      { path: 'leaks', element: withSuspense(<LeakBoard />) },
      { path: 'plans', element: withSuspense(<PlanList />) },
      { path: '*', element: <Navigate to={ROUTES.stations} replace /> }
    ]
  }
]

export default appRoutes
