# ═══════════════════════════════════════════════════════════════════
# Phase 10.4 #14 — 多阶段 Docker 构建
# ═══════════════════════════════════════════════════════════════════
#
# 为什么要用 Docker:
#   开发时用 `npm run dev`(ts-node 直接跑 .ts 文件)很方便,
#   但部署到服务器时,不想装 ts-node / 不想暴露源码 / 不想环境不一致。
#   Docker 把"编译 + 运行环境"打成一个镜像,在哪都能跑。
#
# 多阶段构建(multi-stage build)的思路:
#   阶段 1  builder — 装依赖 + 编译 TypeScript → 产出 dist/ 目录
#   阶段 2  runner  — 只装生产依赖 + 复制 dist/ → 最终镜像
#
#   好处: builder 阶段的 devDependencies(typescript / ts-node 等)
#         不会出现在最终镜像里,镜像体积小一半。
#
# Android 类比:
#   就像 Gradle 的 assembleRelease — 编译产物打进 APK,
#   但编译器(kotlinc)不会跟着打包进去。
#
# ─── 阶段 1: 编译 ───────────────────────────────────────────────

FROM node:20-slim AS builder

# 设置工作目录(容器内路径,不是宿主机)
WORKDIR /app

# 先复制 package*.json 和 prisma/schema.prisma——
# 利用 Docker 层缓存: 只要这些文件没变,npm ci 这层就不用重跑。
# 这是 Docker 性能优化的经典技巧。
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/

# npm ci 比 npm install 更严格:
#   - 完全按 package-lock.json 装,不会偷偷升版本
#   - lock 和 package.json 不一致时直接报错
#   - CI/Docker 环境必用 ci,保证可复现性
RUN npm ci

# Prisma generate: 根据 schema.prisma 生成 @prisma/client 的 TypeScript 类型。
# 不跑这步,后面 tsc 编译时 import @prisma/client 会报错。
RUN npx prisma generate

# 复制剩余源码(node_modules 已经装好,不会被覆盖——
# 因为 .dockerignore 里排除了 node_modules)
COPY . .

# TypeScript 编译: src/ → dist/
# tsc 读 tsconfig.json 的 outDir(dist/),产出 .js 文件
RUN npm run build

# ─── 阶段 2: 运行 ───────────────────────────────────────────────

FROM node:20-slim AS runner

WORKDIR /app

# 只复制生产需要的东西:
#   - package*.json: npm ci --omit=dev 要用
#   - prisma/: schema + migrations,运行时 migrate deploy 要用
#   - dist/: 编译好的 JS
#   - knowledge/: RAG 知识库 markdown 文件
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY --from=builder /app/dist ./dist
COPY knowledge ./knowledge/

# 只装生产依赖(不装 devDependencies 如 typescript / ts-node)
# 这是 runner 阶段镜像小的关键
RUN npm ci --omit=dev

# Prisma generate: runner 阶段也要跑,因为 @prisma/client 是 postinstall 生成的,
# npm ci --omit=dev 不会跑 devDependencies 的 postinstall。
RUN npx prisma generate

# 暴露端口(文档作用,docker-compose 里的 ports 才是真正的端口映射)
EXPOSE 8000

# 容器启动时先跑 prisma migrate deploy(应用所有 migration),
# 再 node dist/server.js 启动服务。
#
# migrate deploy vs migrate dev:
#   - dev: 交互式,会提示确认,适合开发
#   - deploy: 非交互式,直接应用,适合 CI/Docker
#
# 用 sh -c 是为了把两条命令串起来;
# 也可以写一个 entrypoint.sh 脚本,但两条命令用 && 足够。
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
