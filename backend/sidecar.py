"""
SyncTrayzor Custom GUI - Sidecar Service
轻量扩展服务，处理 Syncthing REST API 无法覆盖的功能：
- 备注读写（.stfolder/syncthing-folder-*.txt）
- 文件夹排序持久化
- 全局忽略规则管理（.stglobalignore）
- 无感改路径编排
- 拖拽添加文件夹（创建 .stfolder）
"""

import json
import os
import glob
import shutil
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs
from pathlib import Path
import urllib.request


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ===== 配置 =====
SIDECAR_PORT = 8385
SYNCTHING_API = "http://127.0.0.1:8384"
SYNCTHING_API_KEY = ""  # 运行时从 Syncthing config 读取或命令行传入
CONFIG_DIR = Path.home() / ".config" / "syncthing-custom-gui"
ORDER_FILE = CONFIG_DIR / "folder-order.json"
GLOBAL_IGNORE_FILE = CONFIG_DIR / ".stglobalignore"

# NAS 远程配置（通过 SSH 调 NAS 上的 Syncthing API）
NAS_SSH = os.environ.get("NAS_SSH", "")
NAS_API_KEY = os.environ.get("NAS_API_KEY", "")
NAS_SYNCTHING_DATA_PREFIX = "/var/syncthing"  # 容器内挂载路径前缀
NAS_SSH_OK = False  # 运行时检测，SSH 不可用时自动降级

# NAS 状态缓存（后台线程定期刷新，前端直接读取）
_nas_status_cache = {}  # {folder_id: {globalFiles, globalBytes, state, lastUpdate}}
_nas_status_lock = threading.Lock()
NAS_CACHE_FILE = CONFIG_DIR / "nas-status-cache.json"


def load_nas_cache():
    """启动时从磁盘加载缓存"""
    global _nas_status_cache
    if NAS_CACHE_FILE.exists():
        try:
            _nas_status_cache = json.loads(NAS_CACHE_FILE.read_text(encoding="utf-8"))
            print(f"[sidecar] NAS 缓存已加载: {len(_nas_status_cache)} 条")
        except Exception:
            _nas_status_cache = {}


def save_nas_cache():
    """保存缓存到磁盘"""
    try:
        NAS_CACHE_FILE.write_text(json.dumps(_nas_status_cache, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def refresh_nas_status_cache():
    """后台线程：每 30 秒用单次 SSH 批量获取所有文件夹状态"""
    global _nas_status_cache, NAS_SSH_OK
    import subprocess
    if not NAS_SSH or not NAS_API_KEY:
        print("[sidecar] NAS SSH 未配置，跳过远程缓存刷新（纯本地模式）")
        return
    # 首次检测 SSH 连通性
    try:
        test = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_SSH, "echo ok"],
            capture_output=True, text=True, timeout=10
        )
        if test.returncode == 0 and "ok" in test.stdout:
            NAS_SSH_OK = True
            print(f"[sidecar] NAS SSH 连通: {NAS_SSH}")
        else:
            print(f"[sidecar] NAS SSH 不可达: {NAS_SSH}，降级为纯本地模式")
            return
    except Exception as e:
        print(f"[sidecar] NAS SSH 检测失败: {e}，降级为纯本地模式")
        return
    while True:
        try:
            batch_cmd = (
                f"ids=$(curl -s -H 'X-API-Key: {NAS_API_KEY}' 'http://127.0.0.1:8384/rest/config/folders' "
                f"| python3 -c \"import sys,json; [print(f['id']) for f in json.load(sys.stdin)]\" 2>/dev/null); "
                f"for id in $ids; do "
                f"echo -n \"$id:\"; "
                f"curl -s -H 'X-API-Key: {NAS_API_KEY}' \"http://127.0.0.1:8384/rest/db/status?folder=$id\" "
                f"| python3 -c \"import sys,json; d=json.load(sys.stdin); print(f\\\"{{d.get('globalFiles',0)}}|{{d.get('globalBytes',0)}}|{{d.get('state','')}}\\\")\"; "
                f"done"
            )
            result = subprocess.run(
                ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", NAS_SSH, batch_cmd],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0 and result.stdout.strip():
                new_cache = {}
                for line in result.stdout.strip().split('\n'):
                    if ':' in line:
                        parts = line.split(':', 1)
                        fid = parts[0]
                        vals = parts[1].split('|')
                        if len(vals) == 3:
                            new_cache[fid] = {
                                "globalFiles": int(vals[0]) if vals[0].isdigit() else 0,
                                "globalBytes": int(vals[1]) if vals[1].isdigit() else 0,
                                "state": vals[2],
                                "lastUpdate": time.time(),
                            }
                if new_cache:
                    with _nas_status_lock:
                        _nas_status_cache = new_cache
                    save_nas_cache()
                    print(f"[sidecar] NAS 缓存已刷新: {len(new_cache)} 条")
        except Exception as e:
            print(f"[sidecar] NAS 缓存刷新失败: {e}")
        time.sleep(30)


# ===== NAS 文件夹自动共享给所有设备 =====
def nas_auto_share():
    """后台线程：每 60 秒检查 NAS 文件夹，确保每个文件夹共享给所有已知设备"""
    # 等待 NAS SSH 检测完成（最多 30 秒）
    for _ in range(30):
        if NAS_SSH_OK:
            break
        time.sleep(1)
    if not NAS_SSH_OK:
        print("[auto-share] NAS SSH not available, thread exiting")
        return
    time.sleep(5)
    print("[auto-share] thread started, checking every 15s")
    while True:
        try:
            nas_folders = nas_api("GET", "/rest/config/folders")
            nas_devices = nas_api("GET", "/rest/config/devices")
            if not nas_folders or not nas_devices:
                time.sleep(15)
                continue

            # NAS 的 /rest/config/devices 不包含自己，全是远端设备
            all_device_ids = [d["deviceID"] for d in nas_devices]

            # 检查每个文件夹是否共享给了所有设备
            need_update = False
            for f in nas_folders:
                current_devs = set(d["deviceID"] for d in f.get("devices", []))
                missing = [did for did in all_device_ids if did not in current_devs]
                if missing:
                    for did in missing:
                        f["devices"].append({"deviceID": did, "introducedBy": ""})
                    need_update = True
                    print(f"[auto-share] {f['id']}: added {len(missing)} device(s)")

            if need_update:
                # PUT 更新 NAS 配置（只更新 folders 部分）
                nas_config = nas_api("GET", "/rest/config")
                if nas_config:
                    nas_config["folders"] = nas_folders
                    nas_api("PUT", "/rest/config", nas_config)
                    print("[auto-share] NAS config updated")
        except Exception as e:
            print(f"[auto-share] error: {e}")
        time.sleep(15)


# ===== 文件变化快速检测 =====
_folder_mtime_cache = {}  # {folder_id: last_known_max_mtime}


def file_change_watcher():
    """后台线程：每 3 秒检测同步文件夹中是否有新文件，主动触发 rescan"""
    global _folder_mtime_cache
    import urllib.parse
    while True:
        try:
            config = syncthing_api("GET", "/rest/config")
            if config and config.get("folders"):
                for f in config["folders"]:
                    if f.get("paused"):
                        continue
                    fpath = f.get("path", "")
                    fid = f.get("id", "")
                    if not fpath or not fid or not os.path.isdir(fpath):
                        continue
                    # 快速检测：扫描文件夹及其子目录的 mtime（目录 mtime 在其中有文件变化时更新）
                    try:
                        max_mtime = 0
                        # 检查文件夹本身的 mtime
                        try:
                            dir_mt = os.path.getmtime(fpath)
                            if dir_mt > max_mtime:
                                max_mtime = dir_mt
                        except OSError:
                            pass
                        # 检查顶层文件和子目录的 mtime
                        for entry in os.scandir(fpath):
                            if entry.name.startswith('.'):
                                continue
                            try:
                                mt = entry.stat(follow_symlinks=False).st_mtime
                                if mt > max_mtime:
                                    max_mtime = mt
                                # 如果是子目录，也检查它的 mtime（文件被添加到子目录时其 mtime 会更新）
                                if entry.is_dir(follow_symlinks=False):
                                    for sub in os.scandir(entry.path):
                                        if sub.name.startswith('.'):
                                            continue
                                        try:
                                            smt = sub.stat(follow_symlinks=False).st_mtime
                                            if smt > max_mtime:
                                                max_mtime = smt
                                        except OSError:
                                            pass
                            except OSError:
                                pass
                        # 如果有文件在最近 5 秒内被修改，且比上次记录的 mtime 更新
                        prev_mtime = _folder_mtime_cache.get(fid, 0)
                        now = time.time()
                        if max_mtime > prev_mtime and (now - max_mtime) < 5:
                            print(f"[file-watcher] {fid}: new file detected (age={now - max_mtime:.1f}s), triggering scan")
                            _folder_mtime_cache[fid] = max_mtime
                            encoded_id = urllib.parse.quote(fid, safe='')
                            syncthing_api("POST", f"/rest/db/scan?folder={encoded_id}")
                        elif max_mtime > prev_mtime:
                            _folder_mtime_cache[fid] = max_mtime
                    except OSError:
                        pass
        except Exception as e:
            print(f"[file-watcher] error: {e}")
        time.sleep(3)




# ===== 文件传输日志系统 =====
_transfer_log = []  # [{file, folder, events: [{time, event, detail}]}]
_transfer_log_lock = threading.Lock()
MAX_TRANSFER_LOG = 200  # 最多保留 200 条记录

# 追踪进行中的下载：{(folder, item): {start_time, conn_snapshot: {deviceID: outBytes}}}
_active_downloads = {}
_active_downloads_lock = threading.Lock()

def _snapshot_connections():
    """获取当前各设备的 inBytesTotal 快照（本机是接收端，看 inBytes）"""
    try:
        conns = syncthing_api("GET", "/rest/system/connections")
        if conns and "connections" in conns:
            return {did: v.get("inBytesTotal", 0) for did, v in conns["connections"].items()}
    except Exception:
        pass
    return {}


def transfer_event_watcher():
    """后台线程：监听 Syncthing Events，记录文件级传输时间线"""
    import urllib.parse
    time.sleep(5)  # 等 Syncthing 启动
    since = 0
    # 获取当前最新 event ID（跳过历史）
    try:
        evs = syncthing_api("GET", "/rest/events?since=0&limit=1&timeout=1")
        if evs and len(evs) > 0:
            since = evs[-1]["id"]
    except Exception:
        pass
    print("[transfer-log] event watcher started")

    # 缓存设备名称映射
    _device_names = {}
    def _get_device_name(device_id):
        if not device_id:
            return ""
        short = device_id[:7]
        if short not in _device_names:
            config = syncthing_api("GET", "/rest/config/devices")
            if config:
                for d in config:
                    _device_names[d["deviceID"][:7]] = d.get("name", d["deviceID"][:7])
        return _device_names.get(short, short)

    while True:
        try:
            evs = syncthing_api("GET", f"/rest/events?since={since}&limit=100&timeout=10")
            if not evs:
                time.sleep(2)
                continue
            since = evs[-1]["id"]
            now_str = time.strftime("%H:%M:%S")

            for ev in evs:
                etype = ev.get("type", "")
                data = ev.get("data", {})
                folder = data.get("folder", "")
                item = data.get("item", "")
                ev_time = ev.get("time", "")[:19]  # ISO format truncated

                if etype == "LocalIndexUpdated" and folder:
                    _log_transfer_event(folder, "(index)", ev_time, "LocalIndexUpdated",
                                        f"items={data.get('items', 0)}")

                elif etype == "ItemStarted" and item:
                    action = data.get('action', '')
                    ftype = data.get('type', '')
                    _log_transfer_event(folder, item, ev_time, "Started",
                                        f"action={action} type={ftype}")
                    if action == "update" and ftype == "file":
                        snap = _snapshot_connections()
                        with _active_downloads_lock:
                            _active_downloads[(folder, item)] = {
                                "start_time": time.time(),
                                "conn_start": snap,
                            }

                elif etype == "ItemFinished" and item:
                    err = data.get("error", "")
                    action = data.get('action', '')
                    speed_info = ""
                    with _active_downloads_lock:
                        key = (folder, item)
                        dl = _active_downloads.pop(key, None)
                    if dl and action == "update":
                        elapsed = max(time.time() - dl["start_time"], 0.1)
                        snap_end = _snapshot_connections()
                        snap_start = dl["conn_start"]
                        # 计算每个设备在此期间传入的字节数差值
                        src_parts = []
                        total_delta = 0
                        for did, end_bytes in snap_end.items():
                            start_bytes = snap_start.get(did, end_bytes)
                            delta = end_bytes - start_bytes
                            if delta > 0:
                                dev_name = _get_device_name(did)
                                mb = delta / 1024 / 1024
                                src_parts.append(f"{dev_name}={mb:.1f}MB")
                                total_delta += delta
                        total_mb = total_delta / 1024 / 1024
                        speed_mbs = total_mb / elapsed if total_mb > 0 else 0
                        sources_str = " + ".join(src_parts) if src_parts else "local/cached"
                        speed_info = f" | {total_mb:.1f}MB in {elapsed:.1f}s ({speed_mbs:.2f}MB/s) from [{sources_str}]"
                    detail = f"action={action}"
                    if err:
                        detail += f" error={err}"
                    detail += speed_info
                    _log_transfer_event(folder, item, ev_time, "Finished", detail)

                elif etype == "FolderCompletion" and folder:
                    comp = data.get("completion", 0)
                    need = data.get("needBytes", 0)
                    device = data.get("device", "")
                    dev_name = _get_device_name(device)
                    _log_transfer_event(folder, "(completion)", ev_time, "Completion",
                                        f"→{dev_name} comp={comp:.1f}% needBytes={need}")

                elif etype == "StateChanged" and folder:
                    _log_transfer_event(folder, "(state)", ev_time, "StateChanged",
                                        f"{data.get('from','')} -> {data.get('to','')}")

                elif etype == "FolderScanProgress" and folder:
                    cur = data.get("current", 0)
                    tot = data.get("total", 0)
                    rate = data.get("rate", 0)
                    if tot > 0:
                        pct = round(cur / tot * 100)
                        _log_transfer_event(folder, "(scan)", ev_time, "ScanProgress",
                                            f"{pct}% rate={rate}")

        except Exception as e:
            if "timed out" not in str(e).lower():
                pass  # 安静处理超时
        time.sleep(1)


def _log_transfer_event(folder, item, ev_time, event_type, detail=""):
    """记录一条传输事件"""
    with _transfer_log_lock:
        entry = {
            "time": ev_time,
            "folder": folder,
            "item": item,
            "event": event_type,
            "detail": detail,
        }
        _transfer_log.append(entry)
        # 限制大小
        if len(_transfer_log) > MAX_TRANSFER_LOG:
            _transfer_log[:] = _transfer_log[-MAX_TRANSFER_LOG:]


def nas_api(method, endpoint, data=None):
    """通过 SSH 调用 NAS 上的 Syncthing API"""
    if not NAS_SSH_OK:
        return None
    import subprocess
    import base64

    if data:
        json_bytes = json.dumps(data).encode('utf-8')
        b64 = base64.b64encode(json_bytes).decode()
        # 用 base64 解码避免 shell 转义问题
        cmd = f"echo {b64} | base64 -d | curl -s -X {method} -H 'X-API-Key: {NAS_API_KEY}' -H 'Content-Type: application/json' -d @- 'http://127.0.0.1:8384{endpoint}'"
    else:
        cmd = f"curl -s -X {method} -H 'X-API-Key: {NAS_API_KEY}' 'http://127.0.0.1:8384{endpoint}'"
    ssh_cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_SSH, cmd]
    try:
        result = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception as e:
        print(f"[sidecar] NAS API error: {e}")
    return None


def fix_nas_folder_path(folder_id):
    """确保 NAS 端新文件夹路径在持久化卷下"""
    if not NAS_SSH_OK:
        return
    import urllib.parse
    encoded_id = urllib.parse.quote(folder_id, safe='')

    # 等 NAS 接收到文件夹配置
    time.sleep(3)
    nas_config = nas_api("GET", "/rest/config/folders/" + encoded_id)
    if not nas_config:
        print(f"[sidecar] NAS 尚未接受文件夹 {folder_id}，稍后重试")
        time.sleep(5)
        nas_config = nas_api("GET", "/rest/config/folders/" + encoded_id)
    if not nas_config:
        print(f"[sidecar] NAS 未找到文件夹 {folder_id}")
        return

    current_path = nas_config.get("path", "")
    expected_path = f"{NAS_SYNCTHING_DATA_PREFIX}/{folder_id}"

    if current_path == expected_path:
        print(f"[sidecar] NAS 文件夹 {folder_id} 路径已正确: {expected_path}")
        return

    print(f"[sidecar] 修正 NAS 文件夹路径: {current_path} -> {expected_path}")

    # 如果旧路径有数据，先移动
    import subprocess
    mv_cmd = f"docker exec syncthing sh -c 'if [ -d \"{current_path}\" ]; then mkdir -p \"{expected_path}\" && cp -a \"{current_path}\"/. \"{expected_path}\"/ && rm -rf \"{current_path}\"; else mkdir -p \"{expected_path}\"; fi'"
    subprocess.run(["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_SSH, mv_cmd],
                   capture_output=True, timeout=30)

    # 更新路径
    nas_api("PATCH", f"/rest/config/folders/{encoded_id}", {"path": expected_path})


def ensure_config_dir():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not GLOBAL_IGNORE_FILE.exists():
        GLOBAL_IGNORE_FILE.write_text(
            "// 全局忽略规则 - 所有同步文件夹生效\n"
            "**/cache\n"
            "**/Cache\n"
            "**/*.tmp\n"
            "**/node_modules\n"
            "**/.git\n"
            "**/Thumbs.db\n"
            "**/$RECYCLE.BIN\n"
            "**/desktop.ini\n"
            "**/.sync-conflict-*\n",
            encoding="utf-8"
        )


def syncthing_api(method, endpoint, data=None, timeout=10):
    """调用 Syncthing REST API"""
    url = f"{SYNCTHING_API}{endpoint}"
    headers = {"X-API-Key": SYNCTHING_API_KEY}
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode()
    else:
        body = None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                raw = resp.read().decode()
                return json.loads(raw) if raw.strip() else {}
            return None
    except Exception as e:
        print(f"[sidecar] API error ({endpoint}): {e}")
        return None


# ===== 备注管理 =====

def find_stfolder_txt(folder_path):
    """找到 .stfolder/syncthing-folder-*.txt"""
    stfolder = Path(folder_path) / ".stfolder"
    if not stfolder.exists():
        return None
    matches = list(stfolder.glob("syncthing-folder-*.txt"))
    return matches[0] if matches else None


def read_note(folder_path):
    """读取备注（从 .stfolder/syncthing-folder-*.txt 的自定义部分）"""
    txt_file = find_stfolder_txt(folder_path)
    if not txt_file:
        return ""
    content = txt_file.read_text(encoding="utf-8", errors="ignore")
    # 备注存在 --- NOTE --- 标记之后
    marker = "--- NOTE ---"
    if marker in content:
        return content.split(marker, 1)[1].strip()
    return ""


def write_note(folder_path, note):
    """写入备注到 .stfolder/syncthing-folder-*.txt"""
    txt_file = find_stfolder_txt(folder_path)
    if not txt_file:
        # 创建默认的
        stfolder = Path(folder_path) / ".stfolder"
        stfolder.mkdir(exist_ok=True)
        txt_file = stfolder / "syncthing-folder-note.txt"
        txt_file.write_text("", encoding="utf-8")

    content = txt_file.read_text(encoding="utf-8", errors="ignore")
    marker = "--- NOTE ---"
    if marker in content:
        base = content.split(marker, 1)[0]
    else:
        base = content
    new_content = base.rstrip() + f"\n{marker}\n{note}\n"
    txt_file.write_text(new_content, encoding="utf-8")
    return True


# ===== 文件夹排序 =====

def get_folder_order():
    if ORDER_FILE.exists():
        return json.loads(ORDER_FILE.read_text(encoding="utf-8"))
    return []


def set_folder_order(order):
    ORDER_FILE.write_text(json.dumps(order, ensure_ascii=False, indent=2), encoding="utf-8")


# ===== 全局忽略规则管理 =====

SHARED_GLOBAL_IGNORE = Path(__file__).parent.parent / "config" / "global-ignore.txt"


def get_global_ignore():
    if SHARED_GLOBAL_IGNORE.exists():
        lines = SHARED_GLOBAL_IGNORE.read_text(encoding="utf-8").splitlines()
        rules = [l for l in lines if l.strip() and not l.strip().startswith("//")]
        if rules:
            return rules
    if GLOBAL_IGNORE_FILE.exists():
        lines = GLOBAL_IGNORE_FILE.read_text(encoding="utf-8").splitlines()
        return [l for l in lines if l.strip() and not l.strip().startswith("//")]
    return []


def set_global_ignore(rules):
    content = "// 全局忽略规则\n" + "\n".join(rules) + "\n"
    GLOBAL_IGNORE_FILE.write_text(content, encoding="utf-8")
    SHARED_GLOBAL_IGNORE.parent.mkdir(parents=True, exist_ok=True)
    SHARED_GLOBAL_IGNORE.write_text(content, encoding="utf-8")


def sync_global_ignore_to_folders():
    """将全局忽略规则同步到所有文件夹的 .stignore"""
    global_rules = get_global_ignore()
    if not global_rules:
        return
    config = syncthing_api("GET", "/rest/config")
    if not config:
        return
    for folder in config.get("folders", []):
        fid = folder.get("id", "")
        folder_path = folder.get("path", "")
        if not folder_path or not os.path.isdir(folder_path):
            continue
        stignore_path = Path(folder_path) / ".stignore"
        stignore_lines = ["// --- GLOBAL IGNORE START ---"]
        for r in global_rules:
            stignore_lines.append(r)
        stignore_lines.append("// --- GLOBAL IGNORE END ---")
        if (Path(folder_path) / ".sync-ignore").exists():
            stignore_lines.append("#include .sync-ignore")
        if stignore_path.exists():
            existing = stignore_path.read_text(encoding="utf-8").splitlines()
            in_managed = False
            for line in existing:
                if "GLOBAL IGNORE START" in line:
                    in_managed = True
                    continue
                if "GLOBAL IGNORE END" in line:
                    in_managed = False
                    continue
                if in_managed:
                    continue
                if line.strip() == "#include .sync-ignore":
                    continue
                if line.strip():
                    stignore_lines.append(line)
        try:
            import urllib.parse
            encoded_id = urllib.parse.quote(fid, safe='')
            syncthing_api("POST", f"/rest/db/ignores?folder={encoded_id}",
                          {"ignore": stignore_lines})
        except Exception as e:
            print(f"[global-ignore] Failed to write {fid}/.stignore: {e}")
    print(f"[global-ignore] Applied to {len(config.get('folders', []))} folders")


# ===== 路径搜索 =====

def find_folder_path(name):
    """在本地磁盘上搜索文件夹名，返回匹配的完整路径列表"""
    import string
    results = []
    # 获取所有盘符
    drives = []
    for letter in string.ascii_uppercase:
        drive = f"{letter}:\\"
        if os.path.isdir(drive):
            drives.append(drive)

    # 在常见位置搜索（避免全盘扫描太慢）
    search_paths = []
    for d in drives:
        # 搜索盘符根目录下一级和二级
        try:
            for entry in os.scandir(d):
                if entry.is_dir() and entry.name == name:
                    results.append(entry.path)
                elif entry.is_dir() and not entry.name.startswith(('.', '$')):
                    search_paths.append(entry.path)
        except PermissionError:
            pass

    # 搜索二级目录
    for parent in search_paths:
        try:
            for entry in os.scandir(parent):
                if entry.is_dir() and entry.name == name:
                    results.append(entry.path)
        except PermissionError:
            pass

    return results[:10]  # 最多返回 10 个


# ===== 无感改路径 =====

def migrate_folder_path(folder_id, new_path):
    """无感迁移文件夹路径"""
    config = syncthing_api("GET", "/rest/config")
    if not config:
        return {"error": "无法获取 Syncthing 配置"}

    folder = None
    for f in config.get("folders", []):
        if f["id"] == folder_id:
            folder = f
            break
    if not folder:
        return {"error": f"文件夹 {folder_id} 不存在"}

    old_path = folder["path"]
    if old_path == new_path:
        return {"error": "新旧路径相同"}

    steps = []

    # 1. 暂停文件夹
    folder["paused"] = True
    syncthing_api("PUT", "/rest/config", config)
    steps.append("已暂停同步")
    time.sleep(1)

    # 2. 移动文件
    try:
        new_path_obj = Path(new_path)
        new_path_obj.mkdir(parents=True, exist_ok=True)
        # 使用 robocopy 移动（Windows），保留属性
        os.system(f'robocopy "{old_path}" "{new_path}" /E /MOVE /NFL /NDL /NJH /NJS')
        steps.append(f"已移动文件: {old_path} → {new_path}")
    except Exception as e:
        # 回滚：恢复暂停状态
        folder["paused"] = False
        syncthing_api("PUT", "/rest/config", config)
        return {"error": f"文件移动失败: {e}", "steps": steps}

    # 3. 更新配置
    folder["path"] = new_path
    folder["paused"] = False
    syncthing_api("PUT", "/rest/config", config)
    steps.append("已更新配置并恢复同步")

    return {"success": True, "steps": steps}


def ensure_sync_ignore_include(folder_path, folder_id):
    """当 .sync-ignore 存在时，确保 .stignore 有 #include .sync-ignore"""
    sync_ignore = Path(folder_path) / ".sync-ignore"
    if not sync_ignore.exists():
        return False
    import urllib.parse
    encoded_id = urllib.parse.quote(folder_id, safe='')
    ignores_data = syncthing_api("GET", f"/rest/db/ignores?folder={encoded_id}")
    if not ignores_data:
        return False
    current_ignores = ignores_data.get("ignore", []) or []
    if "#include .sync-ignore" in current_ignores:
        return True
    current_ignores.append("#include .sync-ignore")
    syncthing_api("POST", f"/rest/db/ignores?folder={encoded_id}", {"ignore": current_ignores})
    print(f"[ensure-include] Added #include to {folder_id}/.stignore")
    return True


# ===== 添加文件夹 =====

def add_folder(path, label=None, paused=True):
    """添加新的同步文件夹，默认暂停（让用户先配置忽略规则）"""
    path_obj = Path(path)
    if not path_obj.is_dir():
        return {"error": "路径不存在或不是目录"}

    # 获取当前配置
    config = syncthing_api("GET", "/rest/config")
    if not config:
        return {"error": "无法获取 Syncthing 配置"}

    # 检查路径是否已存在
    norm_path = str(path_obj).replace("\\", "/").rstrip("/").lower()
    for f in config.get("folders", []):
        existing = f.get("path", "").replace("\\", "/").rstrip("/").lower()
        if existing == norm_path:
            return {"error": f"该路径已添加为同步文件夹（ID: {f['id']}）"}

    # 创建 .stfolder
    stfolder = path_obj / ".stfolder"
    stfolder.mkdir(exist_ok=True)

    # 创建 .stignore（含全局规则 + #include .sync-ignore）
    stignore = path_obj / ".stignore"
    if not stignore.exists():
        global_rules = get_global_ignore()
        lines = ["// --- GLOBAL IGNORE START ---"]
        lines.extend(global_rules)
        lines.append("// --- GLOBAL IGNORE END ---")
        lines.append("#include .sync-ignore")
        stignore.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[add-folder] Created .stignore with #include .sync-ignore")

    # 创建 .sync-ignore（本地新建，没有远端版本，需要直接创建）
    sync_ignore = path_obj / ".sync-ignore"
    if not sync_ignore.exists():
        sync_ignore.write_text("// 同步忽略规则 - mode: blacklist\n", encoding="utf-8")

    # 生成文件夹 ID（保留原始大小写）
    folder_id = path_obj.name.replace(" ", "-")[:32]

    # 检查 ID 冲突
    existing_ids = [f["id"] for f in config.get("folders", [])]
    if folder_id in existing_ids:
        folder_id = f"{folder_id}-{int(time.time()) % 10000}"

    # 自动共享给所有已知设备（排除自己）
    my_device_id = ""
    status = syncthing_api("GET", "/rest/system/status")
    if status:
        my_device_id = status.get("myID", "")
    all_devices = [
        {"deviceID": d["deviceID"], "introducedBy": ""}
        for d in config.get("devices", [])
        if d["deviceID"] != my_device_id
    ]

    # 构建文件夹配置
    new_folder = {
        "id": folder_id,
        "label": label or path_obj.name,
        "path": str(path_obj),
        "type": "sendreceive",
        "rescanIntervalS": 60,
        "fsWatcherEnabled": True,
        "fsWatcherDelayS": 10,
        "devices": all_devices,
        "paused": paused,
    }

    config["folders"].append(new_folder)
    syncthing_api("PUT", "/rest/config", config)

    # 异步同步全局忽略规则（不阻塞响应）
    threading.Thread(target=sync_global_ignore_to_folders, daemon=True).start()

    return {"success": True, "folderId": folder_id}


# ===== HTTP Handler =====

class SidecarHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 静默日志

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_json({})

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self.send_json({"status": "ok", "port": SIDECAR_PORT})

        elif path == "/api/folder-order":
            self.send_json({"order": get_folder_order()})

        elif path == "/api/global-ignore":
            self.send_json({"rules": get_global_ignore()})

        elif path == "/api/note":
            params = parse_qs(parsed.query)
            folder_path = params.get("path", [""])[0]
            if folder_path:
                self.send_json({"note": read_note(folder_path)})
            else:
                self.send_json({"error": "需要 path 参数"}, 400)

        elif path == "/api/notes":
            # 批量获取所有文件夹备注
            config = syncthing_api("GET", "/rest/config")
            notes = {}
            if config:
                for f in config.get("folders", []):
                    notes[f["id"]] = read_note(f.get("path", ""))
            self.send_json({"notes": notes})

        elif path == "/api/find-path":
            params = parse_qs(parsed.query)
            name = params.get("name", [""])[0]
            if name:
                paths = find_folder_path(name)
                self.send_json({"paths": paths})
            else:
                self.send_json({"error": "需要 name 参数"}, 400)

        elif path == "/api/nas-status-cache":
            # 直接返回 NAS 状态缓存（毫秒级响应）
            with _nas_status_lock:
                self.send_json(_nas_status_cache)

        elif path == "/api/transfer-log":
            # 返回文件传输时间线日志
            params = parse_qs(parsed.query)
            folder_filter = params.get("folder", [""])[0]
            limit = int(params.get("limit", ["50"])[0])
            with _transfer_log_lock:
                logs = list(_transfer_log)
            if folder_filter:
                logs = [l for l in logs if l["folder"] == folder_filter]
            self.send_json({"logs": logs[-limit:], "total": len(logs)})

        elif path == "/api/local-folder-status":
            # 轻量级：检查本地所有文件夹路径是否存在（不走 SSH）
            config = syncthing_api("GET", "/rest/config")
            result = {}
            if config:
                for f in config.get("folders", []):
                    fpath = f.get("path", "")
                    exists = os.path.isdir(fpath) if fpath else False
                    if not exists and fpath:
                        print(f"[local-folder-status] {f['id']}: path={fpath}, exists=False")
                    result[f["id"]] = {
                        "path": fpath,
                        "exists": exists,
                        "paused": f.get("paused", False),
                    }
            self.send_json(result)

        elif path == "/api/nas-folder-status":
            # 从 NAS 端获取文件夹的 db/status
            params = parse_qs(parsed.query)
            folder_id = params.get("folder", [""])[0]
            if not folder_id:
                self.send_json({"error": "需要 folder 参数"}, 400)
                return
            import urllib.parse
            encoded_id = urllib.parse.quote(folder_id, safe='')
            result = nas_api("GET", f"/rest/db/status?folder={encoded_id}")
            if result:
                self.send_json(result)
            else:
                self.send_json({"error": "NAS 不可达"}, 502)

        elif path == "/api/nas-folders":
            # 核心接口：返回 NAS 全部文件夹 + 本地同步状态
            local_config = syncthing_api("GET", "/rest/config")
            local_ids = {}
            if local_config:
                for f in local_config.get("folders", []):
                    local_ids[f["id"]] = f

            result = []

            if NAS_SSH_OK:
                # SSH 模式：从 NAS 获取完整文件夹列表
                nas_folders = nas_api("GET", "/rest/config/folders")
                with _nas_status_lock:
                    nas_statuses = dict(_nas_status_cache)

                if nas_folders:
                    for nf in nas_folders:
                        fid = nf.get("id", "")
                        local_folder = local_ids.get(fid)
                        local_path = local_folder["path"] if local_folder else ""
                        local_exists = os.path.isdir(local_path) if local_path else False
                        st = nas_statuses.get(fid, {})
                        result.append({
                            "id": fid,
                            "label": nf.get("label", "") or fid,
                            "nasPath": nf.get("path", ""),
                            "localPath": local_path if local_exists else "",
                            "synced": local_folder is not None,
                            "paused": local_folder["paused"] if local_folder else False,
                            "type": nf.get("type", "sendreceive"),
                            "localMissing": bool(local_path and not local_exists),
                            "globalFiles": st.get("globalFiles", 0),
                            "globalBytes": st.get("globalBytes", 0),
                        })
                    # 添加仅本地存在的文件夹
                    nas_ids = {nf["id"] for nf in nas_folders}
                    for fid, lf in local_ids.items():
                        if fid not in nas_ids:
                            lp = lf.get("path", "")
                            result.append({
                                "id": fid,
                                "label": lf.get("label", "") or fid,
                                "nasPath": "",
                                "localPath": lp if os.path.isdir(lp) else "",
                                "synced": True,
                                "paused": lf.get("paused", False),
                                "type": lf.get("type", "sendreceive"),
                                "localOnly": True,
                                "localMissing": bool(lp and not os.path.isdir(lp)),
                            })
            else:
                # 纯本地模式：从本地 Syncthing 获取已配置的文件夹
                # 加上远端设备提议的待接受文件夹（pending folders）
                for fid, lf in local_ids.items():
                    lp = lf.get("path", "")
                    local_exists = os.path.isdir(lp) if lp else False
                    # 查 db/status 获取文件统计（即使 paused 也能返回）
                    gf, gb = 0, 0
                    import urllib.parse as _up
                    st = syncthing_api("GET", f"/rest/db/status?folder={_up.quote(fid, safe='')}")
                    if st:
                        gf = st.get("globalFiles", 0)
                        gb = st.get("globalBytes", 0)
                    result.append({
                        "id": fid,
                        "label": lf.get("label", "") or fid,
                        "nasPath": "",
                        "localPath": lp if local_exists else "",
                        "synced": True,
                        "paused": lf.get("paused", False),
                        "type": lf.get("type", "sendreceive"),
                        "localMissing": bool(lp and not local_exists),
                        "globalFiles": gf,
                        "globalBytes": gb,
                    })
                # 获取远端设备提议但还没接受的文件夹
                pending = syncthing_api("GET", "/rest/cluster/pending/folders")
                if pending:
                    for fid, info in pending.items():
                        if fid not in local_ids:
                            # info 格式: {deviceID: {time, label, ...}, ...}
                            label = fid
                            for dev_info in info.values():
                                if dev_info.get("label"):
                                    label = dev_info["label"]
                                    break
                            result.append({
                                "id": fid,
                                "label": label,
                                "nasPath": "",
                                "localPath": "",
                                "synced": False,
                                "paused": False,
                                "type": "sendreceive",
                                "localMissing": False,
                                "pending": True,
                            })

            self.send_json({"folders": result})

        elif path == "/api/browse-dir":
            # 目录浏览：返回指定路径下的子目录列表
            params = parse_qs(parsed.query)
            browse_path = params.get("path", [""])[0]

        elif path == "/api/read-file":
            params = parse_qs(parsed.query)
            file_path = params.get("path", [""])[0]
            if file_path and os.path.isfile(file_path):
                try:
                    content = Path(file_path).read_text(encoding="utf-8")
                    self.send_json({"content": content})
                except Exception as e:
                    self.send_json({"error": str(e)}, 400)
            else:
                self.send_json({"content": ""})
            return

        elif path == "/api/list-dir":
            # 列出目录下的所有文件和子目录（忽略规则浏览器用）
            params = parse_qs(parsed.query)
            dir_path = params.get("path", [""])[0]
            if dir_path and os.path.isdir(dir_path):
                try:
                    p = Path(dir_path)
                    items = []
                    for entry in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                        if entry.name.startswith('.'):
                            continue
                        items.append({"name": entry.name, "isDir": entry.is_dir()})
                    self.send_json({"items": items[:200]})
                except Exception as e:
                    self.send_json({"error": str(e)}, 400)
            else:
                self.send_json({"error": "路径不存在"}, 400)
            return
            if not browse_path or not os.path.isabs(browse_path):
                # 返回驱动器列表（Windows）
                import string
                drives = []
                for letter in string.ascii_uppercase:
                    drive = f"{letter}:\\"
                    if os.path.exists(drive):
                        drives.append(drive)
                self.send_json({"path": "", "dirs": drives, "parent": ""})
            else:
                try:
                    p = Path(browse_path)
                    if not p.exists():
                        # 路径不存在，返回父级
                        parent = str(p.parent) if p.parent.exists() else ""
                        self.send_json({"path": str(p), "dirs": [], "parent": parent})
                    else:
                        dirs = sorted([d.name for d in p.iterdir() if d.is_dir() and not d.name.startswith('.')])
                        parent = str(p.parent) if p.parent != p else ""
                        self.send_json({"path": str(p), "dirs": dirs, "parent": parent})
                except Exception as e:
                    self.send_json({"error": str(e)}, 400)

        elif path.startswith("/rest/"):
            # 代理 Syncthing REST API
            # connections/stats/db 端点可能超时（NAS 离线时），用短超时
            t = 3 if ("connections" in path or "stats" in path or "/db/" in path) else 10
            result = syncthing_api("GET", self.path, timeout=t)
            if result is not None:
                self.send_json(result)
            else:
                self.send_json({"error": "Syncthing API unavailable"}, 502)

        else:
            self.send_json({"error": "not found"}, 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/rest/"):
            body = self.read_body()
            result = syncthing_api("PUT", self.path, body)
            if result is not None:
                self.send_json(result)
            else:
                self.send_json({"success": True})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/rest/"):
            body = self.read_body()
            result = syncthing_api("PATCH", self.path, body)
            if result is not None:
                self.send_json(result)
            else:
                self.send_json({"success": True})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        if path == "/api/folder-order":
            set_folder_order(body.get("order", []))
            self.send_json({"success": True})

        elif path == "/api/global-ignore":
            rules = body.get("rules", [])
            set_global_ignore(rules)
            # 异步同步到各文件夹
            threading.Thread(target=sync_global_ignore_to_folders, daemon=True).start()
            self.send_json({"success": True})

        elif path == "/api/note":
            folder_path = body.get("path", "")
            note = body.get("note", "")
            if folder_path:
                write_note(folder_path, note)
                self.send_json({"success": True})
            else:
                self.send_json({"error": "需要 path"}, 400)

        elif path == "/api/ensure-folder-path":
            # 安全更改本地路径：防止空目录反向删除 NAS 数据
            folder_id = body.get("folderId", "")
            local_path = body.get("localPath", "")
            auto_resume = body.get("autoResume", False)
            if not folder_id or not local_path:
                self.send_json({"error": "需要 folderId 和 localPath"}, 400)
                return
            try:
                import urllib.parse

                # 创建目录 + .stfolder（快速，同步执行）
                path_obj = Path(local_path)
                path_obj.mkdir(parents=True, exist_ok=True)
                (path_obj / ".stfolder").mkdir(exist_ok=True)

                # 立即返回成功
                self.send_json({"success": True})

                # 所有 Syncthing 操作异步执行
                def do_ensure():
                    encoded_id = urllib.parse.quote(folder_id, safe='')
                    local_config = syncthing_api("GET", "/rest/config")
                    if not local_config:
                        print(f"[sidecar] ensure-folder-path: 无法获取 config")
                        return

                    local_folder = next((f for f in local_config.get("folders", []) if f["id"] == folder_id), None)

                    if local_folder:
                        # 暂停 + 删除
                        syncthing_api("PATCH", f"/rest/config/folders/{encoded_id}", {"paused": True})
                        time.sleep(1)
                        devices = local_folder.get("devices", [])
                        label = local_folder.get("label", "") or folder_id
                        syncthing_api("DELETE", f"/rest/config/folders/{encoded_id}")
                        time.sleep(2)
                    else:
                        nas_folder_cfg = nas_api("GET", f"/rest/config/folders/{encoded_id}")
                        label = (nas_folder_cfg.get("label", "") if nas_folder_cfg else "") or folder_id
                        devices = []
                        status = syncthing_api("GET", "/rest/system/status")
                        my_id = status.get("myID", "") if status else ""
                        for d in local_config.get("devices", []):
                            if d["deviceID"] != my_id:
                                devices.append({"deviceID": d["deviceID"], "introducedBy": ""})

                    # 重新添加（receiveonly 防止空目录删除 NAS 数据）
                    new_folder = {
                        "id": folder_id,
                        "label": label,
                        "path": local_path,
                        "type": "receiveonly",
                        "rescanIntervalS": 60,
                        "fsWatcherEnabled": True,
                        "fsWatcherDelayS": 10,
                        "devices": devices,
                        "paused": not auto_resume,
                    }
                    syncthing_api("POST", "/rest/config/folders", new_folder)
                    time.sleep(1)
                    # POST 可能忽略 type，确保 receiveonly
                    syncthing_api("PATCH", f"/rest/config/folders/{encoded_id}", {"type": "receiveonly"})

                    # 异步：确保 NAS 目录存在
                    def post_ensure():
                        import subprocess
                        nas_fc = nas_api("GET", f"/rest/config/folders/{encoded_id}")
                        nas_path = nas_fc.get("path", "") if nas_fc else f"{NAS_SYNCTHING_DATA_PREFIX}/{folder_id}"
                        if nas_path:
                            mkdir_cmd = f"docker exec syncthing mkdir -p '{nas_path}/.stfolder'"
                            subprocess.run(
                                ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_SSH, mkdir_cmd],
                                capture_output=True, timeout=10
                            )
                    threading.Thread(target=post_ensure, daemon=True).start()

                threading.Thread(target=do_ensure, daemon=True).start()

            except Exception as e:
                self.send_json({"error": str(e)}, 500)

                # 异步：确保 NAS 端目录存在 + 等同步完成后改回 sendreceive
                def post_sync_restore():
                    import subprocess
                    # 确保 NAS 端目录存在
                    nas_fc = nas_api("GET", f"/rest/config/folders/{encoded_id}")
                    nas_path = nas_fc.get("path", "") if nas_fc else f"{NAS_SYNCTHING_DATA_PREFIX}/{folder_id}"
                    if nas_path:
                        mkdir_cmd = f"docker exec syncthing mkdir -p '{nas_path}/.stfolder'"
                        subprocess.run(
                            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_SSH, mkdir_cmd],
                            capture_output=True, timeout=10
                        )
                    # 等同步完成，最多 5 分钟
                    for _ in range(60):
                        time.sleep(5)
                        st = syncthing_api("GET", f"/rest/db/status?folder={encoded_id}", timeout=5)
                        if st and st.get("needFiles", 1) == 0 and st.get("state") == "idle":
                            break
                    # 改回 sendreceive
                    syncthing_api("PATCH", f"/rest/config/folders/{encoded_id}", {"type": "sendreceive"})
                    print(f"[sidecar] {folder_id}: 同步完成，已恢复为 sendreceive")

                threading.Thread(target=post_sync_restore, daemon=True).start()

            except Exception as e:
                self.send_json({"error": str(e)}, 500)

            except Exception as e:
                self.send_json({"error": str(e)}, 500)

        elif path == "/api/add-folder":
            auto_resume = body.get("autoResume", False)
            result = add_folder(body.get("path", ""), body.get("label"), paused=not auto_resume)
            self.send_json(result)

        elif path == "/api/edit-sync-ignore":
            # 直接操作 .sync-ignore 文件（不碰 .stignore）
            folder_id = body.get("folderId", "")
            folder_path = body.get("path", "")
            action = body.get("action", "")  # add / remove
            rule = body.get("rule", "")
            index = body.get("index", -1)
            whitelist = body.get("whitelist", False)

            if not folder_path:
                # 从 config 查找路径
                config = syncthing_api("GET", "/rest/config")
                if config:
                    for f in config.get("folders", []):
                        if f["id"] == folder_id:
                            folder_path = f.get("path", "")
                            break

            sync_ignore_path = Path(folder_path) / ".sync-ignore" if folder_path else None
            if not sync_ignore_path or not folder_path:
                self.send_json({"error": "文件夹路径未知"}, 400)
                return

            # 读取现有规则
            rules = []
            if sync_ignore_path.exists():
                lines = sync_ignore_path.read_text(encoding="utf-8").splitlines()
                for l in lines:
                    t = l.strip()
                    if not t or t.startswith("#include"):
                        continue
                    # 保留 //[black] 和 //[white] 备份标记，跳过其他注释
                    if t.startswith("//") and not t.startswith("//[black]") and not t.startswith("//[white]"):
                        continue
                    rules.append(t)
            else:
                if whitelist:
                    rules = ["*"]

            if action == "add":
                if whitelist:
                    new_rule = rule if rule.startswith("!") else f"!{rule}"
                    if new_rule in rules:
                        self.send_json({"success": True, "duplicate": True})
                        return
                    # 在 * 之前插入
                    if "*" in rules:
                        star_idx = rules.index("*")
                        rules.insert(star_idx, new_rule)
                    else:
                        rules.append(new_rule)
                        rules.append("*")
                else:
                    if rule in rules:
                        self.send_json({"success": True, "duplicate": True})
                        return
                    rules.append(rule)

            elif action == "set-all":
                # 直接替换所有规则（用于模式切换等批量操作）
                rules = body.get("rules", [])

            elif action == "remove":
                # 提取显示规则（和前端 loadFolderIgnores 一致的过滤逻辑）
                if whitelist:
                    display_rules = [r for r in rules if r.strip().startswith("!")]
                    if 0 <= index < len(display_rules):
                        rules.remove(display_rules[index])
                else:
                    display_rules = [r for r in rules if r.strip() != "*"]
                    if 0 <= index < len(display_rules):
                        rules.remove(display_rules[index])

            # 写回 .sync-ignore
            mode_str = "whitelist" if whitelist else "blacklist"
            # 白名单模式：确保 .sync-ignore 自身不被忽略（否则无法同步到其他设备）
            if whitelist and "!/.sync-ignore" not in rules:
                if "*" in rules:
                    star_idx = rules.index("*")
                    rules.insert(star_idx, "!/.sync-ignore")
                else:
                    rules.append("!/.sync-ignore")
            content = f"// 同步忽略规则 - mode: {mode_str}\n"
            content += "\n".join(rules) + "\n"
            sync_ignore_path.write_text(content, encoding="utf-8")

            # 确保 .stignore 有 #include .sync-ignore（首次编辑时可能还没有）
            ensure_sync_ignore_include(folder_path, folder_id)

            # 通知 Syncthing 重新扫描忽略规则
            import urllib.parse
            encoded_id = urllib.parse.quote(folder_id, safe='')
            syncthing_api("POST", f"/rest/db/scan?folder={encoded_id}")

            self.send_json({"success": True})
            return

        elif path == "/api/open-in-explorer":
            folder_path = body.get("path", "")
            if folder_path and os.path.exists(folder_path):
                import subprocess
                subprocess.Popen(f'start "" "{folder_path}"', shell=True)
                self.send_json({"success": True})
            else:
                self.send_json({"error": "路径不存在"}, 400)

        elif path == "/api/migrate-path":
            folder_id = body.get("folderId", "")
            new_path = body.get("newPath", "")
            if folder_id and new_path:
                result = migrate_folder_path(folder_id, new_path)
                self.send_json(result)
            else:
                self.send_json({"error": "需要 folderId 和 newPath"}, 400)

        elif path == "/api/transfer-log":
            # POST: 写入自定义日志（前端配置变更等）
            msg = body.get("message", "")
            detail = body.get("detail", "")
            if msg:
                _log_transfer_event("(system)", "(config)", time.strftime("%Y-%m-%dT%H:%M:%S"), msg, detail)
                self.send_json({"success": True})
            else:
                self.send_json({"error": "需要 message"}, 400)

        elif path == "/api/pause-folder":
            folder_id = body.get("folderId", "")
            paused = body.get("paused", True)
            auto_upgrade = body.get("autoUpgrade", False)
            config = syncthing_api("GET", "/rest/config")
            if config:
                folder_cfg = None
                for f in config.get("folders", []):
                    if f["id"] == folder_id:
                        f["paused"] = paused
                        folder_cfg = f
                        break
                syncthing_api("PUT", "/rest/config", config)
                self.send_json({"success": True})

                # 恢复 receiveonly 文件夹时，后台等同步完成后自动切回 sendreceive
                if not paused and auto_upgrade and folder_cfg and folder_cfg.get("type") == "receiveonly":
                    def auto_upgrade_to_sendreceive():
                        import urllib.parse
                        encoded_id = urllib.parse.quote(folder_id, safe='')
                        print(f"[auto-upgrade] {folder_id}: receiveonly resumed, waiting for sync to complete...")
                        for _ in range(600):  # 最多等 10 分钟
                            time.sleep(1)
                            st = syncthing_api("GET", f"/rest/db/status?folder={encoded_id}", timeout=5)
                            if st and st.get("needFiles", 1) == 0 and st.get("state") == "idle":
                                # .sync-ignore 应该已从 NAS 到达，补上 #include
                                ensure_sync_ignore_include(folder_cfg.get("path", ""), folder_id)
                                syncthing_api("PATCH", f"/rest/config/folders/{encoded_id}", {"type": "sendreceive"})
                                print(f"[auto-upgrade] {folder_id}: sync complete, upgraded to sendreceive")
                                return
                        print(f"[auto-upgrade] {folder_id}: timed out waiting for sync, staying receiveonly")
                    threading.Thread(target=auto_upgrade_to_sendreceive, daemon=True).start()
            else:
                self.send_json({"error": "API 不可用"}, 500)

        elif path == "/api/delete-folder":
            folder_id = body.get("folderId", "")
            delete_nas_files = body.get("deleteNasFiles", False)
            if folder_id:
                import subprocess
                import urllib.parse
                encoded_id = urllib.parse.quote(folder_id, safe='')
                if NAS_SSH_OK:
                    # 先查 NAS 端实际路径
                    nas_folder = nas_api("GET", f"/rest/config/folders/{encoded_id}")
                    nas_path = None
                    if nas_folder and nas_folder.get("path"):
                        nas_path = nas_folder["path"]
                    # 删除 NAS Syncthing 配置
                    nas_api("DELETE", f"/rest/config/folders/{encoded_id}")
                    # 仅在用户勾选时删除 NAS 端数据
                    if delete_nas_files and nas_path and nas_path.startswith("/var/syncthing/"):
                        print(f"[sidecar] delete-folder: removing NAS files at {nas_path}")
                        rm_cmd = f'docker exec syncthing rm -rf "{nas_path}"'
                        subprocess.run(
                            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_SSH, rm_cmd],
                            capture_output=True, timeout=15
                        )
                    else:
                        print(f"[sidecar] delete-folder: NAS files preserved (deleteNasFiles={delete_nas_files})")
                else:
                    print(f"[sidecar] delete-folder: no SSH, local-only removal")

                # 删除云服务器上的配置和数据
                cloud_api_key = "qzyo5HW5vx9vJkyQYegMDbbUJL9AZoeU"
                cloud_host = "42.192.65.73"
                try:
                    import urllib.request
                    # 删除云服务器文件夹配置
                    req = urllib.request.Request(
                        f"http://{cloud_host}:8384/rest/config/folders/{encoded_id}",
                        headers={"X-API-Key": cloud_api_key},
                        method="DELETE"
                    )
                    urllib.request.urlopen(req, timeout=10)
                    print(f"[sidecar] delete-folder: removed from cloud server config")
                    # 删除云服务器数据文件
                    if delete_nas_files:
                        cloud_path = f"/home/ubuntu/Sync/{folder_id}"
                        try:
                            rm_result = subprocess.run(
                                ["ssh", "-o", "ConnectTimeout=5", "-b", "192.168.3.35", "cloud", f"rm -rf '{cloud_path}'"],
                                capture_output=True, timeout=15
                            )
                            print(f"[sidecar] delete-folder: removed cloud files at {cloud_path}")
                        except Exception as e:
                            print(f"[sidecar] delete-folder: cloud file removal failed: {e}")
                except Exception as e:
                    print(f"[sidecar] delete-folder: cloud cleanup failed: {e}")

                # 删除本地配置
                local_config = syncthing_api("GET", "/rest/config")
                if local_config:
                    local_config["folders"] = [f for f in local_config.get("folders", []) if f["id"] != folder_id]
                    syncthing_api("PUT", "/rest/config", local_config)
                self.send_json({"success": True})
            else:
                self.send_json({"error": "需要 folderId"}, 400)

        elif path == "/api/sync-to-local":
            # 将 NAS 文件夹同步到本地
            folder_id = body.get("folderId", "")
            local_path = body.get("localPath", "")
            auto_resume = body.get("autoResume", False)
            if not folder_id or not local_path:
                self.send_json({"error": "需要 folderId 和 localPath"}, 400)
                return
            # 验证本地路径存在
            path_obj = Path(local_path)
            path_obj.mkdir(parents=True, exist_ok=True)
            # 创建 .stfolder
            (path_obj / ".stfolder").mkdir(exist_ok=True)
            # 创建 .stignore（全局规则，不加 #include）
            # .sync-ignore 会从 NAS 同步过来，到达后 auto-upgrade 补 #include
            stignore = path_obj / ".stignore"
            if not stignore.exists():
                global_rules = get_global_ignore()
                lines = ["// --- GLOBAL IGNORE START ---"]
                lines.extend(global_rules)
                lines.append("// --- GLOBAL IGNORE END ---")
                stignore.write_text("\n".join(lines) + "\n", encoding="utf-8")
            # 获取 NAS 端文件夹信息
            import urllib.parse
            encoded_id = urllib.parse.quote(folder_id, safe='')
            nas_folder = nas_api("GET", f"/rest/config/folders/{encoded_id}")
            label = ""
            if nas_folder:
                label = nas_folder.get("label", "") or folder_id
            # 添加到本地 config
            local_config = syncthing_api("GET", "/rest/config")
            if not local_config:
                self.send_json({"error": "本地 API 不可用"}, 500)
                return
            # 检查是否已存在
            if any(f["id"] == folder_id for f in local_config.get("folders", [])):
                self.send_json({"error": "本地已存在该文件夹"}, 400)
                return
            # 获取设备列表：share_all_devices=true 时添加所有远程设备，否则只加 NAS
            share_all = body.get("shareAllDevices", True)
            status = syncthing_api("GET", "/rest/system/status")
            my_id = status.get("myID", "") if status else ""
            devices = []
            if share_all:
                for d in local_config.get("devices", []):
                    if d["deviceID"] != my_id:
                        devices.append({"deviceID": d["deviceID"], "introducedBy": ""})
                print(f"[sync-to-local] {folder_id}: sharing with ALL {len(devices)} devices")
            else:
                nas_device_id = ""
                for d in local_config.get("devices", []):
                    if d.get("name", "").lower().startswith("nas"):
                        nas_device_id = d["deviceID"]
                        break
                if not nas_device_id:
                    for d in local_config.get("devices", []):
                        if d["deviceID"] != my_id:
                            nas_device_id = d["deviceID"]
                            break
                devices = [{"deviceID": nas_device_id, "introducedBy": ""}] if nas_device_id else []
                print(f"[sync-to-local] {folder_id}: sharing with NAS only")
            new_folder = {
                "id": folder_id,
                "label": label,
                "path": local_path,
                "type": "receiveonly",
                "rescanIntervalS": 60,
                "fsWatcherEnabled": True,
                "fsWatcherDelayS": 10,
                "devices": devices,
                "paused": True,  # 始终暂停创建，等 .stignore/.sync-ignore 就绪后用户手动恢复
            }
            local_config["folders"].append(new_folder)
            syncthing_api("PUT", "/rest/config", local_config)
            self.send_json({"success": True})

        elif path == "/api/unsync-local":
            # 仅从本地移除同步（NAS 保留）
            folder_id = body.get("folderId", "")
            if not folder_id:
                self.send_json({"error": "需要 folderId"}, 400)
                return
            local_config = syncthing_api("GET", "/rest/config")
            if local_config:
                local_config["folders"] = [f for f in local_config.get("folders", []) if f["id"] != folder_id]
                syncthing_api("PUT", "/rest/config", local_config)
            self.send_json({"success": True})

        elif path.startswith("/rest/"):
            # 代理 Syncthing REST API (POST)
            result = syncthing_api("POST", self.path, body if body else None)
            if result is not None:
                self.send_json(result)
            else:
                self.send_json({"success": True})

        else:
            self.send_json({"error": "not found"}, 404)


def main():
    import sys
    global SYNCTHING_API_KEY

    # 从命令行或环境变量获取 API Key
    if len(sys.argv) > 1:
        SYNCTHING_API_KEY = sys.argv[1]
    else:
        SYNCTHING_API_KEY = os.environ.get("SYNCTHING_API_KEY", "")

    if not SYNCTHING_API_KEY:
        print("[sidecar] 警告: 未设置 SYNCTHING_API_KEY")
        print("[sidecar] 用法: python sidecar.py <api_key>")
        print("[sidecar]   或: set SYNCTHING_API_KEY=xxx && python sidecar.py")

    ensure_config_dir()
    load_nas_cache()

    # 启动 NAS 状态缓存后台刷新线程
    cache_thread = threading.Thread(target=refresh_nas_status_cache, daemon=True)
    cache_thread.start()

    # 启动文件变化快速检测线程
    watcher_thread = threading.Thread(target=file_change_watcher, daemon=True)
    watcher_thread.start()

    # 启动 NAS 文件夹自动共享线程（确保新文件夹共享给所有设备）
    share_thread = threading.Thread(target=nas_auto_share, daemon=True)
    share_thread.start()

    # 启动传输日志监控线程
    transfer_log_thread = threading.Thread(target=transfer_event_watcher, daemon=True)
    transfer_log_thread.start()

    # 启动时一次性同步全局忽略规则到 .stignore
    def init_global_ignore():
        time.sleep(10)
        sync_global_ignore_to_folders()
        print("[global-ignore] Initial sync complete")

    threading.Thread(target=init_global_ignore, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", SIDECAR_PORT), SidecarHandler)
    print(f"[sidecar] 扩展服务启动: http://127.0.0.1:{SIDECAR_PORT}")
    print(f"[sidecar] Syncthing API: {SYNCTHING_API}")
    print(f"[sidecar] 模式: {'NAS SSH' if NAS_SSH else '纯本地'}（NAS_SSH={'已配置' if NAS_SSH else '未配置'}）")
    print(f"[sidecar] 文件变化检测: 每 3 秒")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[sidecar] 已停止")
        server.server_close()


if __name__ == "__main__":
    main()
