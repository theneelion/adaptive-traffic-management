from fastapi import FastAPI
from app.routes import router

app = FastAPI(title="ai-service")
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
