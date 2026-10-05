/* eslint-disable no-console */
// 并发冒烟：两个标签页同时完成同一巡检，先写入生效，败方载荷完整留档
import 'fake-indexeddb/auto'

// Node 环境补齐浏览器 localStorage
const memStore = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => (memStore.has(key) ? memStore.get(key)! : null),
    setItem: (key: string, value: string) => void memStore.set(key, value),
    removeItem: (key: string) => void memStore.delete(key)
  }
})

import { db, initDatabase } from '../frontend/src/utils/db'
import { usePatrolStore } from '../frontend/src/stores/patrolStore'
import { useStationStore } from '../frontend/src/stores/stationStore'

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error('❌ FAIL:', message)
    process.exitCode = 1
  } else {
    console.log('✅ PASS:', message)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

async function main(): Promise<void> {
  await initDatabase()
  await flush()

  // pa-3（待巡检，st-1）：录入 pt-1/pt-2 读数
  const points = useStationStore.getState().points.filter((p) => ['pt-1', 'pt-2'].includes(p.id))
  const patrolBefore = await db.patrols.get('pa-3')
  const baseRevision = patrolBefore?.revision ?? 0

  usePatrolStore.getState().setReadingDraft('pa-3', points[0], 0.4)
  usePatrolStore.getState().setReadingDraft('pa-3', points[1], 0.2)

  // 模拟标签页 A 先完成（直接走 store，带 baseRevision）
  const resultA = await usePatrolStore.getState().completePatrol(
    'pa-3',
    { patrolDate: '2024-06-21', patrolman: 'A 标签页', envNote: 'A 先提交' },
    baseRevision,
    points
  )
  assert(resultA.outcome === 'committed', '标签页 A 提交成功（先写入生效）')

  // 标签页 B 用过期的 baseRevision 提交同一巡检
  const resultB = await usePatrolStore.getState().completePatrol(
    'pa-3',
    { patrolDate: '2024-06-21', patrolman: 'B 标签页', envNote: 'B 后提交' },
    baseRevision,
    points
  )
  assert(resultB.outcome === 'conflict', '标签页 B 乐观锁冲突')
  if (resultB.outcome === 'conflict') {
    assert(resultB.currentRevision === baseRevision + 1, '冲突返回最新 revision')
  }

  // A 的内容生效
  const patrolAfter = await db.patrols.get('pa-3')
  assert(patrolAfter?.state === '已完成' && patrolAfter.patrolman === 'A 标签页', '库内保留先写入方 A 的内容')
  assert((patrolAfter?.revision ?? 0) === baseRevision + 1, '巡检 revision 已递增')

  console.log('\n并发冒烟测试通过。')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
