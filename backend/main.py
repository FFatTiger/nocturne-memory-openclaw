from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from api import review_router, browse_router, maintenance_router
from auth import BearerTokenAuthMiddleware
from db import get_db_manager, close_db
from health import router as health_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时
    print("Memory API starting...")

    # Initialize Database
    try:
        db_manager = get_db_manager()
        await db_manager.init_db()
        print("Database initialized.")
    except Exception as e:
        print(f"Failed to initialize database: {e}")

    yield

    # 关闭时
    print("Closing database connections...")
    await close_db()


app = FastAPI(
    title="Knowledge Graph API",
    description="AI长期记忆知识图谱后端",
    version="1.5.0",
    lifespan=lifespan,
)

app.add_middleware(
    BearerTokenAuthMiddleware,
    excluded_paths=["/health"],
)

# CORS设置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 开发环境，生产环境需要限制
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(health_router)
app.include_router(review_router)
app.include_router(browse_router)
app.include_router(maintenance_router)


@app.get("/")
async def root():
    """根路径"""
    return {"message": "Knowledge Graph API", "version": "1.5.0", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
