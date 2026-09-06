FROM node:20-slim
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
EXPOSE 5173
CMD ["pnpm", "--filter", "frontend", "exec", "vite", "--host"]
