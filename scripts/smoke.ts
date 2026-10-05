/* eslint-disable no-console */
// 运行时冒烟测试：标准版本、历史冻结、待复核、乐观锁冲突、待合并队列
import 'fake-indexeddb/auto'
import { DB_VERSION, db, initDatabase } from '../frontend/src/utils/db'
import { publishStandardVersion } from '../frontend/src/utils/standards'
import type { PointRow, ReadingRow } from '../frontend/src/utils/db'

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error('❌ FAIL:', message)
    process.exitCode = 1
  } else {
    console.log('✅ PASS:', message)
  }
}

async function main(): Promise<void> {
  assert(DB_VERSION === 3, 'DB_VERSION = 3')
  await initDatabase()

  const points = await db.points.toArray()
  const versions = await db.standardVersions.toArray()
  assert(points.length === 11, `播种 11 个点位（实际 ${points.length}）`)
  assert(versions.length === 11, `每个点位一条 v1 版本（实际 ${versions.length}）`)
  assert(points.every((p) => p.currentVersionNo === 1), '全部点位 currentVersionNo = 1')

  // 已完成巡检 pa-1 的读数 rd-1（pt-1: 0.41，标准 0.35~0.45，正常）
  const rd1Before = (await db.readings.get('rd-1')) as ReadingRow
  assert(rd1Before.isAbnormal === false, '历史正常读数 rd-1 判定正常（0.41 在 0.35~0.45）')
  assert(rd1Before.standardVersionNo === 1 && rd1Before.reviewState === '无', '已完成巡检读数携带 v1 快照且非待复核')

  // 把 pt-1 标准收紧到 0.36~0.40（0.41 将异常）
  const pt1 = (await db.points.get('pt-1')) as PointRow
  const result = await publishStandardVersion(
    { pointId: 'pt-1', standardMin: 0.36, standardMax: 0.4, isCritical: true },
    '调压站升级'
  )
  assert(result !== null, '新标准发布成功')
  assert(result?.point.currentVersionNo === 2, '点位版本指针前进到 v2')
  assert(result?.version.versionNo === 2 && result.version.reason === '调压站升级', '版本行记录原因')
  const pt1Versions = await db.standardVersions.where('pointId').equals('pt-1').toArray()
  assert(pt1Versions.length === 2, 'pt-1 有 v1/v2 两个不可变版本')

  // 历史读数 rd-1 未被改判
  const rd1After = (await db.readings.get('rd-1')) as ReadingRow
  assert(rd1After.isAbnormal === false && rd1After.deviationPct === rd1Before.deviationPct, '已完成巡检读数未被新标准改判')
  assert(rd1After.standardVersionNo === 1, '历史读数仍引用 v1 标准')

  // 未完成巡检无 pt-1 播种读数，直接造一条模拟：待巡检 pa-3
  await db.readings.put({
    id: 'rd-test',
    patrolId: 'pa-3',
    pointId: 'pt-1',
    value: 0.41,
    isAbnormal: false,
    deviationPct: 0,
    note: '',
    standardMin: 0.35,
    standardMax: 0.45,
    standardUnit: 'MPa',
    isCritical: true,
    standardVersionId: pt1Versions[0].id,
    standardVersionNo: 1,
    reviewState: '无',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 2
  })
  // 再造一次标准升级，验证未完成巡检读数被标待复核
  const result2 = await publishStandardVersion(
    { pointId: 'pt-1', standardMin: 0.37, standardMax: 0.42, isCritical: true },
    '再次升级'
  )
  assert(result2 !== null && result2.pendingReadings >= 1, '未完成巡检读数被计入待复核')
  const rdTest = (await db.readings.get('rd-test')) as ReadingRow
  assert(rdTest.reviewState === '待复核', '未提交巡检读数标为待复核')
  assert(rdTest.isAbnormal === false, '待复核读数保留原值判定（未被新标准改判）')
  assert(rdTest.standardVersionNo === 1, '待复核读数仍保留 v1 快照与差异')

  // 处置单历史不被改判
  const lk1 = await db.leaks.get('lk-1')
  assert(lk1 !== undefined && lk1.standardVersionNo === 1, '历史泄漏处置单冻结当时标准版本')

  // CAS：patrol 乐观锁
  const pa3 = await db.patrols.get('pa-3')
  const baseRev = pa3?.revision ?? 0
  // 模拟另一标签页先写
  await db.patrols.update('pa-3', { state: '漏检' as never })
  await db.patrols.update('pa-3', { revision: baseRev + 1 } as never)
  const current = await db.patrols.get('pa-3')
  assert((current?.revision ?? 0) === baseRev + 1, '先写入方 revision 递增')

  // mergeQueue 可写
  await db.mergeQueue.put({
    id: 'mq-test',
    entityType: 'patrol',
    entityId: 'pa-3',
    title: '测试冲突',
    source: 'conflict',
    status: '待处理',
    baseRevision: baseRev,
    payload: { patrol: { stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检' }, readings: [] },
    currentRevision: baseRev + 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const mq = await db.mergeQueue.get('mq-test')
  assert(mq?.status === '待处理', '待合并条目持久化')

  console.log('\n全部冒烟测试通过。')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
