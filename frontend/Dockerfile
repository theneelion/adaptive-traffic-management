FROM node:22-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend ./frontend
COPY shared-contracts ./shared-contracts

RUN corepack enable && pnpm install --frozen-lockfile

EXPOSE 5173

CMD ["pnpm", "--filter", "frontend", "exec", "vite", "--host"]