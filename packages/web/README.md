# @datasentry/web — 最小 WebUI

PRD §10 M3 交付范围：任务列表、Session 状态、事件轨迹查看页。

```bash
npm run dev          # 另开终端，先起后端（默认 127.0.0.1:3000）
npm run dev:web      # http://localhost:5173
```

`vite.config.ts` 把 `/api` 代理到 `DATASENTRY_BASE_URL`（默认 `http://127.0.0.1:3000`）。
前端代码里不出现主机名——生产部署时把 `/api` 指到反向代理即可，不需要改代码。

## 页面

| 页面 | 路由 | 内容 |
|---|---|---|
| 任务 | `#/sessions` | 全部任务、状态、步骤数、需人工介入的数量 |
| 任务详情 | `#/sessions/<id>` | 状态与标识、报表指标、审批、检查点、工具调用、事件轨迹 |
| 审批 | `#/approvals` | 待审批队列，展示绑定参数/工具版本/草稿版本/接收人摘要，可批准或拒绝 |
| 恢复 | `#/recovery` | 重启恢复扫描，可「仅收敛状态」或「收敛并继续执行」 |
| 数据源 | `#/sources` | Source 与工具清单，含敏感级别与副作用 |

## 设计取舍

- **不引路由库与数据请求库。** 五个只读视图加三个动作，一个 hash 路由 + 一个 `useAsync` 就够；
  引 react-router + react-query 只会让「看懂这个界面」的成本变高。
- **事件轨迹页把 payload 翻译成一句话。** 轨迹是给人看审计过程的，
  直接铺 JSON 等于把「读日志」的活儿又交回给人。原始 payload 仍在
  `GET /sessions/:id/events.jsonl` 与 JSONL 文件里可取。
- **恢复页先扫描、后执行。** 一启动就自动重放带副作用的调用，比停下来等一句指令危险得多。
- **样式只用 CSS 变量，不引 UI 框架。** 亮/暗色跟随 `prefers-color-scheme`。

## 构建

```bash
npm run build        # 产物在 packages/web/dist
```

`dist/` 未接入后端静态托管——M3 只要求「能看的查看页」，部署方式留给实际环境决定。
