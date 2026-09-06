FROM node:20-slim AS build
WORKDIR /app
# Deliberately NOT `COPY . .` — ai-service is a separate Python project (not a pnpm workspace
# member; see pnpm-workspace.yaml), and this is a pure-Node build stage with no `uv`/`uvx`
# installed. Copying it in anyway used to make shared-contracts' generate.mjs think it should run
# (and copy into) the Python codegen step purely because the directory existed, crashing on a
# missing `uvx`. Only copy what this image's build actually needs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sim-server ./sim-server
COPY frontend ./frontend
COPY shared-contracts ./shared-contracts
COPY maps ./maps
# Pin pnpm@9 (matches ci.yml's pnpm/action-setup and scripts/setup.sh's corepack prepare) — bare
# `corepack enable` grabs whatever pnpm is currently latest (11.x), which requires Node >= 22.13
# (it imports the Node 22+ builtin `node:sqlite`) and crashes immediately on this node:20-slim base.
RUN corepack enable && corepack prepare pnpm@9 --activate && pnpm install --frozen-lockfile
RUN pnpm --filter shared-contracts generate
RUN pnpm --filter frontend build
RUN pnpm --filter sim-server build

FROM node:20-slim
WORKDIR /app
# pnpm workspaces hoist shared dependencies into a workspace-root node_modules/.pnpm store —
# sim-server/node_modules/ws (and most other deps) is just a symlink to
# ../../node_modules/.pnpm/ws@.../node_modules/ws, not a real copy. Without also copying the
# workspace root's node_modules here, those symlinks point at a directory that doesn't exist in
# this final image at all, and the process crashes at startup with ERR_MODULE_NOT_FOUND for the
# first such dependency it imports — found directly: sim-server's container exited immediately
# with "Cannot find package 'ws'", confirmed via `docker compose logs`.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/sim-server/dist ./sim-server/dist
COPY --from=build /app/sim-server/node_modules ./sim-server/node_modules
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/maps ./maps
CMD ["node", "sim-server/dist/server.js"]
