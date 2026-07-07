FROM python:3.12-slim

LABEL maintainer="webword"
LABEL description="打字记单词 - 小学英语单词练习"

WORKDIR /app

# 复制应用文件
COPY index.html admin.html style.css server.py ./
COPY js/ ./js/

# 数据存储目录（挂载到宿主机实现持久化）
VOLUME /app/data

# 设置环境变量：数据文件放在挂载目录
ENV DB_PATH=/app/data/webword.db
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "server.py"]
