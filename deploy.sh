#!/bin/bash
# 飞牛OS Docker 部署脚本
# 用法：在飞牛OS上执行 bash deploy.sh

set -e

echo "=========================================="
echo "  打字记单词 - Docker 部署脚本"
echo "=========================================="

# 配置
APP_DIR="/vol1/1000/docker/webword"
PORT=8000

# 创建目录
mkdir -p "$APP_DIR/data"
cd "$APP_DIR"

# 检查文件是否齐全
if [ ! -f "Dockerfile" ]; then
  echo "❌ Dockerfile 不存在，请确保所有文件已上传到 $APP_DIR"
  echo "   需要的文件：Dockerfile, docker-compose.yml, server.py, index.html, style.css, js/"
  exit 1
fi

echo "📁 工作目录: $APP_DIR"
echo ""

# 停止旧容器（如果存在）
echo "🔄 停止旧容器..."
docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true

# 构建镜像
echo "🔨 构建 Docker 镜像..."
docker compose build 2>/dev/null || docker-compose build

# 启动容器
echo "🚀 启动容器..."
docker compose up -d 2>/dev/null || docker-compose up -d

# 等待启动
sleep 2

# 检查状态
echo ""
echo "📊 容器状态:"
docker compose ps 2>/dev/null || docker-compose ps

echo ""
echo "=========================================="
echo "  ✅ 部署完成！"
echo ""
echo "  访问地址: http://$(hostname -I | awk '{print $1}'):${PORT}"
echo "  数据目录: $APP_DIR/data/"
echo ""
echo "  管理命令:"
echo "    查看日志: docker compose logs -f"
echo "    停止:     docker compose down"
echo "    重启:     docker compose restart"
echo "=========================================="
