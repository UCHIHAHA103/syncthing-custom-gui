# Syncthing Custom GUI - 项目上下文

## 核心诉求

把 Syncthing + NAS + 云服务器打造成一个**私有网盘平台**，替代百度网盘/OneDrive，实现：

### 搭建目的

- 家里电脑和公司电脑之间无缝同步文件，不受公司防火墙限制
- NAS 作为数据中心（全量存储），云服务器作为中转加速节点
- 不依赖第三方云盘，数据完全自己掌控

### 想实现的功能

1. **网盘浏览** — 在任意一台电脑上能看到 NAS/云服务器上所有文件夹（含未同步的），类似网盘目录树
2. **选择性同步** — 不自动全量同步，用户选择需要的文件夹才下载到本地（类似 OneDrive 按需下载）
3. **白名单/黑名单** — 同一个文件夹内，只同步指定的子文件夹/文件，忽略不需要的（如 cache、临时文件）
4. **忽略规则跨设备同步** — 一端设置了忽略规则，另一端自动生效（通过 .sync-ignore 文件同步）
5. **多源加速** — 利用云服务器 tcp 直连 + NAS relay + 家里电脑 relay 三源并行，最大化传输速度
6. **新文件夹自动全设备可见** — 任意电脑上传新文件夹后，所有设备立即能看到并选择是否同步
7. **传输监控** — 实时显示各设备传输速度、来源占比、文件完成进度
8. **一键打开本地文件夹** — 点击路径直接用默认文件管理器打开
9. **拖拽操作** — 拖拽添加同步文件夹、拖拽添加忽略规则
10. **简洁 UI** — 比 Syncthing 原生 8384 界面更简洁直观，隐藏技术细节

### 当前架构定位

| 角色 | 设备 | 功能 |
|------|------|------|
| 数据中心 | NAS | 全量存储所有文件夹，7x24 在线 |
| 中转加速 | 云服务器 | tcp 直连公司电脑，补充带宽 |
| 客户端 | 家里电脑 | 上传/下载，开发 |
| 客户端 | 公司电脑 | 选择性下载，工作使用 |
| 管理界面 | 8080 Web UI | 替代 Syncthing 原生界面 |

### 与传统网盘的对比

| 维度 | 百度网盘 | 本方案 |
|------|---------|--------|
| 数据所有权 | 平台方 | 完全自有 |
| 隐私 | 被扫描 | 端到端加密传输 |
| 速度 | 限速 | 受限于自家带宽（上行 64Mbps） |
| 容量 | 付费 | NAS 14TB+ |
| 选择性同步 | 支持 | 支持（白名单/黑名单） |
| 多端 | 支持 | 支持（任意设备） |
| 费用 | 年费 | 仅 NAS 硬件 + 云服务器（可选） |

---

## 项目路径

```
d:\TRAE\github\syncthing-custom-gui\
├── frontend/          # 前端 (纯 HTML/JS/CSS, 端口 8080)
│   ├── index.html
│   ├── js/app.js      # 主逻辑
│   ├── js/api.js      # API 层
│   └── css/style.css
├── backend/
│   └── sidecar.py     # Python sidecar 服务 (端口 8385)
├── config/
│   └── global-ignore.txt    # 全局忽略规则
└── start.ps1          # 启动脚本
```

## 启动命令

### 家里电脑

```powershell
# Syncthing
Start-Process -FilePath "C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\syncthing.exe" -ArgumentList "--no-browser" -WindowStyle Hidden

# Sidecar (API Key: uNNidDtL3C3t2mcLDKzMEs9xxhhmd9P6)
Start-Process -FilePath python -ArgumentList "d:\TRAE\github\syncthing-custom-gui\backend\sidecar.py","uNNidDtL3C3t2mcLDKzMEs9xxhhmd9P6" -WindowStyle Hidden -RedirectStandardOutput "d:\TRAE\github\syncthing-custom-gui\.tmp\sidecar.log" -RedirectStandardError "d:\TRAE\github\syncthing-custom-gui\.tmp\sidecar_err.log"

# 重启 sidecar (先杀后启)
Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*sidecar*' } | Stop-Process -Force; Start-Sleep 1; Start-Process -FilePath python -ArgumentList "d:\TRAE\github\syncthing-custom-gui\backend\sidecar.py","uNNidDtL3C3t2mcLDKzMEs9xxhhmd9P6" -WindowStyle Hidden -RedirectStandardOutput "d:\TRAE\github\syncthing-custom-gui\.tmp\sidecar.log" -RedirectStandardError "d:\TRAE\github\syncthing-custom-gui\.tmp\sidecar_err.log"

# 重启 Syncthing (通过 API)
Invoke-RestMethod -Uri "http://127.0.0.1:8384/rest/system/restart" -Method POST -Headers @{"X-API-Key"="uNNidDtL3C3t2mcLDKzMEs9xxhhmd9P6"}
```

### 公司电脑

```powershell
# Sidecar (API Key: pz2KmasLCQRdZYZFkxiWFmTQ7bgXJ3HY)
cd D:\TRAE\github\syncthing-custom-gui
Start-Process -FilePath python -ArgumentList "backend\sidecar.py","pz2KmasLCQRdZYZFkxiWFmTQ7bgXJ3HY" -WindowStyle Hidden -RedirectStandardOutput ".tmp\sidecar.log" -RedirectStandardError ".tmp\sidecar_err.log"
```

### 云服务器

```bash
# SSH 连接 (家里电脑)
ssh cloud   # 已配 ~/.ssh/config, BindAddress 192.168.3.35

# Syncthing 服务
sudo systemctl restart syncthing@ubuntu

# 设备自动补全服务
sudo systemctl restart sync-device-sync
```

## API Keys

| 设备 | Syncthing API Key | 设备 ID (前7位) |
|------|-------------------|---------------|
| 家里电脑 (WIN-NLRSSNSDFR2) | `uNNidDtL3C3t2mcLDKzMEs9xxhhmd9P6` | ZZMKTPJ |
| 公司电脑 (DESKTOP-TK7ARKE) | `pz2KmasLCQRdZYZFkxiWFmTQ7bgXJ3HY` | X26EYMU |
| NAS (NAS-Syncthing) | `Lt7QpTj39nxT5GER4jKWa2ZothXdJLFL` | SFPWG3A |
| 云服务器 (VM-0-7-ubuntu) | `qzyo5HW5vx9vJkyQYegMDbbUJL9AZoeU` | 33U5P74 |

## 网络拓扑

```
家里电脑 (192.168.3.35) ──── tcp ────► 云服务器 (42.192.65.73:22000) ◄── tcp ── 公司电脑
        │                                         ▲
        │ LAN                                     │ tcp
        ▼                                         │
      NAS (192.168.3.20) ─────────── tcp ─────────┘
        │
        └── relay ──► 公司电脑 (只能 relay, 无法 tcp 直连 NAS)
```

- 家里电脑有 NGNClient 虚拟网卡, 到云服务器需要静态路由: `route -p add 42.192.65.73 mask 255.255.255.255 192.168.3.1 metric 1 if 5`
- 公司电脑也有 NGNClient, 同样需要: `route -p add 42.192.65.73 mask 255.255.255.255 10.97.85.1 metric 1 if 11`
- 公司无法 SSH/tcp 直连 NAS (非腾讯云 IP 被 DPI 拦截)

## 当前未解决的 Bug

### 忽略规则系统

1. **从 8080 界面添加忽略规则后, .sync-ignore 文件有时不更新**
   - 后端 API `/api/edit-sync-ignore` 直接调用时正常工作
   - 问题可能在前端传参: `this.selectedFolder.path` 可能为空
   - 需要检查前端 `addIgnoreFromBrowser` 和浏览器 `+` 按钮传的参数

2. **loadFolderIgnores 有时 fallback 到 Syncthing API 显示全局规则**
   - 当 `/api/read-file` 读取 `.sync-ignore` 失败时会 fallback
   - Syncthing 的 `/rest/db/ignores` 返回合并后的所有规则 (含全局)
   - 需要确保 fallback 时也正确过滤

3. **toggleWhitelistMode 仍使用 Syncthing API (setIgnores)**
   - 应该也改为操作 `.sync-ignore`
   - 当前切换白名单/黑名单模式会导致全局规则混入

### 忽略规则架构

```
.stignore (不同步, sidecar 管理):
  // --- GLOBAL IGNORE START ---
  **/cache
  **/Cache
  ...
  // --- GLOBAL IGNORE END ---
  #include .sync-ignore

.sync-ignore (Syncthing 同步, 8080 UI 管理):
  // 同步忽略规则 - mode: blacklist
  /010.jpg
  /011.jpg
```

- 8080 UI 的增删改 → 只操作 .sync-ignore (通过 /api/edit-sync-ignore)
- UI 显示 → 优先读 .sync-ignore (通过 /api/read-file), fallback 到 Syncthing API
- 创建文件夹时 → 自动创建 .stignore (含全局规则 + #include .sync-ignore)
- sidecar 启动时 → ensure_stignore_includes() 补全已有文件夹

## 云服务器信息

| 项目 | 值 |
|------|-----|
| 实例 ID | ins-li7spbvv |
| 公网 IP | 42.192.65.73 |
| SSH | `ssh cloud` (别名, BindAddress 192.168.3.35) |
| 到期 | 2026-06-10 |
| 带宽 | 3Mbps |
| 自动补全服务 | `sync-device-sync.service` (systemd) |
| 脚本路径 | `/home/ubuntu/sync-device-sync.py` |
| Syncthing 数据 | `/home/ubuntu/Sync/` |

## NAS 信息

| 项目 | 值 |
|------|-----|
| SSH | `ssh 13123379707@192.168.3.20` |
| Syncthing 容器 | `syncthing` (--network host) |
| 数据路径 | `/volume1/docker/syncthing/` |
| 设备补全脚本 | `/volume1/docker/syncthing/sync-device-sync.py nas` (nohup) |

## 开发规范

- **禁止使用 Emoji** (除非用户主动要求)
- 修改后必须 `git push` (公司电脑通过 GitHub 更新)
- sidecar 修改后需重启才能生效
- 前端修改只需刷新浏览器 (Ctrl+Shift+R 清缓存)

## Git 信息

- 仓库: `https://github.com/UCHIHAHA103/syncthing-custom-gui.git`
- 分支: `main`
- 最新 commit: `6c7d95b` (fix: filter #include when reading/writing .sync-ignore)
