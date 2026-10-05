// 用 frontend 自带的 esbuild 把测试（含 @ 路径别名）打成临时 ESM 后执行：node run-smoke.cjs [smoke|concurrency]
const path = require('path')
const FRONTEND = path.resolve(__dirname, '../frontend')
const esbuild = require(path.join(FRONTEND, 'node_modules/esbuild'))
const { execFileSync } = require('child_process')

const which = process.argv[2] || 'smoke'

async function run() {
  const outfile = path.resolve(__dirname, `.${which}.mjs`)
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, `${which}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    alias: { '@': path.join(FRONTEND, 'src') },
    nodePaths: [path.join(FRONTEND, 'node_modules')],
    logLevel: 'warning'
  })
  execFileSync('node', [outfile], { stdio: 'inherit' })
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
