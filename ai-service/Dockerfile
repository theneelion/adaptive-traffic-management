FROM python:3.12-slim
WORKDIR /app
RUN pip install uv
# Build context is the repo root (see infra/docker-compose.yml), not ai-service/ — `COPY . .` was
# copying the whole monorepo into /app, landing pyproject.toml at /app/ai-service/pyproject.toml
# instead of /app/pyproject.toml, so `uv sync --frozen` (which looks in the current directory)
# couldn't find it. Copy only this service's own subtree, matching sim-server/Dockerfile's same
# repo-root-context pattern.
COPY ai-service/ .
RUN uv sync --frozen
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
