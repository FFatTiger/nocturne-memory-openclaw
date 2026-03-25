FROM python:3.12-slim

# 安装系统依赖（libpq-dev 供 asyncpg/psycopg2 编译，build-essential 供 C 扩展和标准库头文件，postgresql-client 供 pg_dump 备份）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libc6-dev \
        libpq-dev \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先复制 requirements.txt 以利用 Docker 层缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制剩余源码
COPY . .

# 创建非 root 用户以提升安全性
RUN adduser --disabled-password --gecos '' appuser \
    && chown -R appuser:appuser /app

# 预创建运行时目录，避免挂载卷后首次写入遇到权限问题
RUN mkdir -p /app/snapshots /app/backups \
    && chown appuser:appuser /app/snapshots /app/backups

USER appuser
