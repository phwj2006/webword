#!/usr/bin/env python3
"""
打字记单词 - 后端服务
零依赖，仅需 Python 3（标准库 http.server + sqlite3）
用于飞牛OS (fnOS) / Linux 部署

启动: python3 server.py
默认端口: 8000
数据文件: webword.db (SQLite)
"""

import os
import sys
import json
import time
import hashlib
import sqlite3
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# ==================== 配置 ====================
PORT = int(os.environ.get('PORT', 8000))
# 数据库路径：优先用环境变量，否则放在程序目录
DB_PATH = os.environ.get('DB_PATH', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'webword.db'))
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

# ==================== 数据库 ====================
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS user_data (
        username TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )''')
    # 清理过期会话
    c.execute('DELETE FROM sessions WHERE expires_at < ?', (time.time(),))
    conn.commit()
    conn.close()

def hash_password(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def gen_token(username):
    raw = f"{username}:{time.time()}:{os.urandom(8).hex()}"
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()

# ==================== API 逻辑 ====================
def api_register(body):
    username = body.get('username', '').strip()
    password = body.get('password', '')
    if not username or len(username) < 2:
        return {'ok': False, 'msg': '用户名至少 2 个字符'}
    if len(username) > 20:
        return {'ok': False, 'msg': '用户名最多 20 个字符'}
    if not password or len(password) < 4:
        return {'ok': False, 'msg': '密码至少 4 个字符'}
    conn = get_db()
    try:
        conn.execute('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
                     (username, hash_password(password), time.strftime('%Y-%m-%d %H:%M:%S')))
        # 初始化空数据
        conn.execute('INSERT INTO user_data (username, data_json, updated_at) VALUES (?, ?, ?)',
                     (username, json.dumps({}), time.strftime('%Y-%m-%d %H:%M:%S')))
        conn.commit()
        return {'ok': True}
    except sqlite3.IntegrityError:
        return {'ok': False, 'msg': '用户名已存在'}
    finally:
        conn.close()

def api_login(body):
    username = body.get('username', '').strip()
    password = body.get('password', '')
    conn = get_db()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
    if not row:
        return {'ok': False, 'msg': '用户不存在'}
    if row['password_hash'] != hash_password(password):
        return {'ok': False, 'msg': '密码错误'}
    token = gen_token(username)
    conn = get_db()
    conn.execute('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)',
                 (token, username, time.time(), time.time() + 7 * 86400))
    conn.commit()
    conn.close()
    return {'ok': True, 'token': token, 'username': username}

def api_logout(token):
    conn = get_db()
    conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
    conn.commit()
    conn.close()
    return {'ok': True}

def get_user_from_token(token):
    if not token:
        return None
    conn = get_db()
    row = conn.execute('SELECT * FROM sessions WHERE token = ? AND expires_at > ?',
                       (token, time.time())).fetchone()
    conn.close()
    if not row:
        return None
    return row['username']

def api_get_data(token):
    username = get_user_from_token(token)
    if not username:
        return {'ok': False, 'msg': '未登录或登录已过期'}
    conn = get_db()
    row = conn.execute('SELECT * FROM user_data WHERE username = ?', (username,)).fetchone()
    conn.close()
    data = json.loads(row['data_json']) if row and row['data_json'] else {}
    return {'ok': True, 'data': data, 'username': username}

def api_save_data(token, body):
    username = get_user_from_token(token)
    if not username:
        return {'ok': False, 'msg': '未登录或登录已过期'}
    data = body.get('data', {})
    data_str = json.dumps(data, ensure_ascii=False)
    conn = get_db()
    conn.execute('''INSERT INTO user_data (username, data_json, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET data_json = ?, updated_at = ?''',
                 (username, data_str, time.strftime('%Y-%m-%d %H:%M:%S'),
                  data_str, time.strftime('%Y-%m-%d %H:%M:%S')))
    conn.commit()
    conn.close()
    return {'ok': True}

# ==================== 管理员 ====================
ADMIN_USER = 'admin'
ADMIN_PASS_HASH = hash_password('wangjian')
admin_tokens = {}  # token -> expires_at

def api_admin_login(body):
    username = body.get('username', '').strip()
    password = body.get('password', '')
    if username != ADMIN_USER or hash_password(password) != ADMIN_PASS_HASH:
        return {'ok': False, 'msg': '管理员账号或密码错误'}
    token = gen_token('admin')
    admin_tokens[token] = time.time() + 7 * 86400
    return {'ok': True, 'token': token}

def check_admin(token):
    if not token or token not in admin_tokens:
        return False
    if admin_tokens[token] < time.time():
        admin_tokens.pop(token, None)
        return False
    return True

def api_admin_users():
    conn = get_db()
    users = conn.execute('SELECT username, created_at FROM users ORDER BY created_at DESC').fetchall()
    result = []
    for u in users:
        row = conn.execute('SELECT data_json, updated_at FROM user_data WHERE username = ?', (u['username'],)).fetchone()
        data = json.loads(row['data_json']) if row and row['data_json'] else {}
        learned = data.get('learned', {})
        wrong = data.get('wrong', {})
        daily = data.get('daily', {})
        result.append({
            'username': u['username'],
            'created_at': u['created_at'],
            'updated_at': row['updated_at'] if row else '',
            'learned_count': len(learned),
            'wrong_count': len(wrong),
            'streak': data.get('streak', 0),
            'last_checkin': data.get('lastCheckIn', ''),
            'daily_count': len(daily),
        })
    conn.close()
    return {'ok': True, 'users': result}

def api_admin_user_detail(username):
    conn = get_db()
    u = conn.execute('SELECT username, created_at FROM users WHERE username = ?', (username,)).fetchone()
    if not u:
        conn.close()
        return {'ok': False, 'msg': '用户不存在'}
    row = conn.execute('SELECT data_json, updated_at FROM user_data WHERE username = ?', (username,)).fetchone()
    conn.close()
    data = json.loads(row['data_json']) if row and row['data_json'] else {}
    return {'ok': True, 'username': u['username'], 'created_at': u['created_at'],
            'updated_at': row['updated_at'] if row else '', 'data': data}

# ==================== HTTP 服务 ====================
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # 简化日志
        sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {format % args}\n")
        sys.stdout.flush()

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(data))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, filepath, content_type):
        try:
            with open(filepath, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(data))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    def _get_token(self):
        # 优先从 Authorization header 获取，其次从 query 参数获取（sendBeacon 用）
        token = self.headers.get('Authorization', '').replace('Bearer ', '')
        if token:
            return token
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if 'token' in query:
            return query['token'][0]
        return ''

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        # API 路由
        if path == '/api/data':
            self._send_json(api_get_data(self._get_token()))
            return
        # 管理员路由
        if path == '/api/admin/users':
            if not check_admin(self._get_token()):
                self._send_json({'ok': False, 'msg': '未授权'}, 401)
            else:
                self._send_json(api_admin_users())
            return
        if path.startswith('/api/admin/user/'):
            username = path.split('/')[-1]
            if not check_admin(self._get_token()):
                self._send_json({'ok': False, 'msg': '未授权'}, 401)
            else:
                self._send_json(api_admin_user_detail(username))
            return

        # 静态文件
        if path == '/' or path == '':
            self._send_file(os.path.join(STATIC_DIR, 'index.html'), 'text/html; charset=utf-8')
            return
        # 安全：禁止访问 db 和 py 文件
        if path.endswith('.db') or path.endswith('.py'):
            self.send_error(403)
            return
        filepath = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip('/')))
        if not filepath.startswith(STATIC_DIR):
            self.send_error(403)
            return
        ext = os.path.splitext(filepath)[1].lower()
        types = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
            '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        }
        if ext in types:
            self._send_file(filepath, types[ext])
        else:
            self.send_error(403)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()
        except Exception:
            self._send_json({'ok': False, 'msg': '请求格式错误'}, 400)
            return

        if path == '/api/register':
            self._send_json(api_register(body))
        elif path == '/api/login':
            self._send_json(api_login(body))
        elif path == '/api/logout':
            self._send_json(api_logout(self._get_token()))
        elif path == '/api/data':
            self._send_json(api_save_data(self._get_token(), body))
        elif path == '/api/admin/login':
            self._send_json(api_admin_login(body))
        elif path == '/api/admin/logout':
            admin_tokens.pop(self._get_token(), None)
            self._send_json({'ok': True})
        else:
            self._send_json({'ok': False, 'msg': '未知接口'}, 404)


def main():
    init_db()
    print(f"╔══════════════════════════════════════════╗")
    print(f"║  打字记单词 - 后端服务已启动              ║")
    print(f"║  访问地址: http://0.0.0.0:{PORT}          ║")
    print(f"║  数据文件: {DB_PATH}")
    print(f"║  按 Ctrl+C 停止                            ║")
    print(f"╚══════════════════════════════════════════╝")
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.server_close()

if __name__ == '__main__':
    main()
