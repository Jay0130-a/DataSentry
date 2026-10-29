# DataSentry 容器镜像。
#
# 这个项目没有构建步骤（内部包直接指向 src，由 tsx 运行），所以镜像只分两段：
#   deps —— 装依赖。better-sqlite3 是原生模块，缺预编译包时要现场编译，
#           因此这里带上 python3 / make / g++，避免在不同架构上随机失败。
#   runtime —— 只拷 node_modules 与源码，保持镜像里没有编译工具链。
#
# 不设 NODE_ENV=production：那会让服务要求显式初始口令并拒绝默认值，
# 而这是一个可以 `docker compose up` 直接看的演示镜像。生产部署请自行设置。

# 基础镜像可覆盖：网络受限的环境用镜像站（见 README「一条命令跑起来」）
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 先只拷清单，锁文件不变时这一层可以复用缓存
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/backend/package.json packages/backend/
COPY packages/mcp-sources/package.json packages/mcp-sources/
COPY packages/web/package.json packages/web/
RUN npm ci

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# 拷整个 /app 而不是只拷 node_modules：npm workspaces 会把版本冲突的依赖
# 装在 packages/*/node_modules 下，只拷根目录会让子包跑成根里的旧版本。
COPY --from=deps /app ./
COPY . .

ENV HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# entrypoint 只在数据卷为空时播种，已有数据不会覆盖
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
CMD ["npm", "run", "dev"]
