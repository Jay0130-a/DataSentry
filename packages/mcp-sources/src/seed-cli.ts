import { dataPaths } from '@datasentry/core'
import { seedAll } from './seed.ts'

/**
 * `npm run seed` 的入口。
 *
 * 之所以与 `seed.ts` 分开，是因为 `seed.ts` 会被 `index.ts` 导出给回归脚本使用，
 * 它必须保持无副作用；CLI 的打印与退出码放在这里。
 */
seedAll()
  .then((result) => {
    process.stdout.write(
      [
        '模拟数据源已就绪：',
        `  数仓 SQLite      ${dataPaths().warehouseDb}（${result.warehouseRows} 行聚合事实）`,
        `  手工调整 Excel    ${result.adjustmentsFile}（${result.adjustmentsRows} 行）`,
        `  开发凭据          ${result.credentialsFile}${result.credentialsCreated ? '（新建）' : '（已存在，未覆盖）'}`,
        '',
      ].join('\n'),
    )
  })
  .catch((err: unknown) => {
    process.stderr.write(`seed 失败：${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
