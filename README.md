# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22809**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Arco Design 2.66 | 表格、表单、Modal、Tag、Badge、Progress |
| 状态管理 | Zustand 4.5 | `stationStore` / `patrolStore` / `leakStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1009/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbgaspress
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts standard.ts merge.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts mergeStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx StandardHistoryModal.tsx MergePanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx PlanList.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts standards.ts conflict.ts localDraft.ts export.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、PointStandardVersion、Device | 维护上下限/单位/关键点（草稿 → 逐条/批量发布不可变新版本）；查看标准版本履历；按模板批量复制标准值 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point | 逐点录入读数，实时偏差率与异常级别；标准更新后未提交草稿/已存读数先标待复核（保留原值与差异）；完成巡检走乐观锁，并发败方载荷进待合并面板 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按读数冻结的当时标准与关键点权重降序；勾选批量确认；浓度类读数派单时携带当时标准快照 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 措施/处置人（乐观锁）→ 复检判合格闭环；历史单据按当时标准展示不被改判；并发败方载荷待合并；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`standardVersions`（标准版本，不可变追加）、`mergeQueue`（并发冲突败方 / 写入失败找回的待合并队列）
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的升级迁移：v2 补齐 `revision`、回填 `stationId` 冗余列；v3 为读数/处置单补「当时标准」快照（版本号、上下限、关键点）、为点位补当前版本指针、为未完成巡检读数标 `reviewState=待复核`，并播种每点位 v1 初始版本
- **标准可追溯 / 历史不改判**：每次标准更新在 `standardVersions` 追加不可变版本并前移点位指针；已完成巡检的读数与泄漏处置单始终按自身留存的快照标记异常；新标准只作用于尚未提交的巡检（其读数/草稿先标待复核，人工选择按新标准重判或维持原判定）
- **并发提交（两个标签页）**：完成巡检、处置单推进/复检/编辑均以 `revision` 乐观锁提交（CAS）——先写入者生效；败方完整载荷入 `mergeQueue`，在对应页面「待合并 / 待找回」面板可重开后继续处理；提交前先写 localStorage 草稿，写入失败可从本地找回
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位（各含 v1 标准版本）→ 6 次巡检 → 11 条读数（按当时标准冻结）→ 3 张泄漏处置单的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`、`gbgaspress:recovery-drafts`（提交前本地找回草稿）、`gbgaspress:reading-drafts`（逐点录入草稿持久化）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 偏差率：读数落在其「当时标准区间」内为 `0`；越限时按越限幅度相对边界值计算百分比；历史读数的区间来自保存时冻结的标准版本快照，不随点位现行标准变化
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」（关键点标记同样以读数/单据快照为准）
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 标准更新生效范围：已发布的新标准只作用于「尚未提交（巡检未完成）」的录入；这些读数/草稿进入「待复核」，原值与差异保留，人工确认后要么按新标准重判、要么维持原判定；已完成巡检与已派泄漏处置单永不改判
- 并发提交：同一巡检 / 处置单被两个标签页同时提交时，按 `revision` 乐观锁判定——先写入生效，后写入完整留作「待合并」；任意写入失败先从 localStorage 本地草稿找回
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空
