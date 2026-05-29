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

# better-sqlite3 是 C++ 原生模块,npm ci 时需要用 node-gyp 编译它。
# node:20-slim 镜像太精简,缺编译工具链,所以要手动装:
#   python3  — node-gyp 用 Python 生成构建脚本
#   make     — 执行编译
#   g++      — C++ 编译器
#
# 这些只在 builder 阶段需要,runner 阶段用的是编译好的 .node 二进制,不用装。
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

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

# 单独跑一次"只保留生产依赖"的安装,给 runner 阶段用。
# 为什么不在 runner 里 npm ci --omit=dev?
# 因为 better-sqlite3 是 C++ 原生模块,编译需要 python3 / make / g++,
# 这些工具只在 builder 里装了。在 builder 里编译好,runner 直接复制就行。
#
# npm ci --omit=dev 会删掉 devDependencies(typescript 等),
# 只保留生产依赖 + 已编译好的 .node 原生模块。
RUN cp -r node_modules node_modules_full && \
    npm ci --omit=dev && \
    npx prisma generate

# ─── 阶段 2: 运行 ───────────────────────────────────────────────

FROM node:20-slim AS runner

# Prisma 的查询引擎是编译好的二进制文件,运行时依赖 OpenSSL。
# node:20-slim 太精简没有装,不加这行 Prisma 启动时会报 loadEngine 错误。
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只复制生产需要的东西:
#   - package*.json: 运行时 npx 命令需要
#   - prisma/: schema + migrations,运行时 migrate deploy 要用
#   - dist/: 编译好的 JS
#   - knowledge/: RAG 知识库 markdown 文件
#   - node_modules/: 从 builder 复制,已经编译好原生模块 + 只含生产依赖
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY knowledge ./knowledge/

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
