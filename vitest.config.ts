import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // 锁死模型后端：开发者本机 .env 里可能配了真实模型，
    // 单元测试绝不能因此去调用 API。
    env: {
      DATASENTRY_MODEL_PROVIDER: 'mock',
      // 邮件只组装报文并落盘，不连 SMTP：单元测试不该依赖外部服务。
      DATASENTRY_SMTP_MODE: 'stream',
    },
    // 涉及 MCP 子进程与 HTTP 服务的用例需要更宽的窗口
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 每个用例自己管临时数据目录，不共享状态
    fileParallelism: true,
  },
})
