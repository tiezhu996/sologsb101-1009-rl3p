import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { ConfigProvider } from '@arco-design/web-react'
import zhCN from '@arco-design/web-react/es/locale/zh-CN'
import '@arco-design/web-react/dist/css/arco.css'
import './styles/main.css'
import { appRoutes } from './router'
import { initDatabase, stampDbVersion } from './utils/db'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载节点')
}

const router = createBrowserRouter(appRoutes)

stampDbVersion()

// 首屏先完成 IndexedDB 打开与演示数据播种，再渲染应用，避免列表页空窗
void initDatabase()
  .catch((error: unknown) => {
    console.error('本地数据库初始化失败', error)
  })
  .finally(() => {
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        <ConfigProvider locale={zhCN}>
          <RouterProvider router={router} />
        </ConfigProvider>
      </React.StrictMode>
    )
  })
