FROM python:3.12-slim

# 安装系统依赖（libpq-dev 供 asyncpg 编译，postgresql-client 供 pg_dump 备份）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libc6-dev \
        libpq-dev \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 优先复制 requirements.txt 以利用 Docker 层缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制剩余源码
COPY . .

# 创建非 root 用户以提升安全性
RUN adduser --disabled-password --gecos '' appuser \
    && mkdir -p /app/snapshots /app/backups \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 18901

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "18901", "--app-dir", "/app"]
