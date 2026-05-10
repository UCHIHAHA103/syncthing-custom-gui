/**
 * SyncTrayzor Custom GUI - Main App
 */
const app = {
  config: null,
  folders: [],
  devices: [],
  connections: null,
  folderOrder: [],
  notes: {},
  globalIgnore: [],
  selectedFolder: null,
  sidecarOk: false,
  pollTimer: null,
  _statsCache: {},
  _badgeCache: {}, // {fid: {text, cls}}
  _localBytesCache: {}, // {fid: localBytes} — 检测本地文件变化
  _scanTriggered: {}, // {fid: timestamp} — 防止重复触发 scan

  setStats(fid, text) {
    this._statsCache[fid] = text;
    const el = document.getElementById(`stats-${fid}`);
    if (el && el.textContent !== text) el.textContent = text;
  },

  setBadge(fid, text, cls) {
    this._badgeCache[fid] = { text, cls };
    const el = document.getElementById(`badge-${fid}`);
    if (el) {
      if (el.textContent !== text) el.textContent = text;
      if (el.className !== cls) el.className = cls;
    }
  },

  async init() {
    console.log('[init] starting...');
    // API Key 不再必须（sidecar 代理所有请求）
    const params = new URLSearchParams(location.search);
    const key = params.get('key') || localStorage.getItem('syncthing_api_key') || '';
    if (key) {
      API.init(key);
      localStorage.setItem('syncthing_api_key', key);
    }

    // 初始化
    this.bindEvents();
    console.log('[init] calling initSidecar...');
    await this.initSidecar();
    console.log('[init] sidecarOk:', this.sidecarOk);
    console.log('[init] calling refresh...');
    await this.refresh();
    console.log('[init] refresh done, starting polling');
    // 自动优化：降低 fsWatcher 延迟以加快文件变化检测
    this.optimizeFsWatcher();
    this.startPolling();
  },

  async optimizeFsWatcher() {
    try {
      const config = await API.getConfig();
      if (!config || !config.folders) return;
      let needSave = false;
      for (const f of config.folders) {
        if (f.fsWatcherDelayS > 2) {
          console.log(`[init] optimizing fsWatcherDelayS: ${f.id} ${f.fsWatcherDelayS}s → 2s`);
          f.fsWatcherDelayS = 2;
          needSave = true;
        }
      }
      if (needSave) {
        await API.setConfig(config);
        console.log('[init] fsWatcherDelayS optimized for all folders');
      }
    } catch (e) {
      console.warn('[init] optimizeFsWatcher failed:', e);
    }
  },

  promptApiKey() {
    const key = prompt('请输入 Syncthing API Key：');
    if (key) {
      API.init(key);
      localStorage.setItem('syncthing_api_key', key);
      this.init();
    }
  },

  bindEvents() {
    // 顶部导航
    document.querySelectorAll('.titlebar-nav button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.titlebar-nav button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (view === 'log') {
          this.showTransferLog();
        }
      };
    });

    // 面板 Tab
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`).classList.add('active');
      };
    });

    // 拖拽添加
    const dz = document.getElementById('dropZone');
    ['dragenter', 'dragover'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('active'); }));
    ['dragleave', 'drop'].forEach(e => dz.addEventListener(e, ev => {
      ev.preventDefault(); dz.classList.remove('active');
      if (e === 'drop' && ev.dataTransfer.items) {
        for (const item of ev.dataTransfer.items) {
          if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
            if (entry && entry.isDirectory) {
              this.handleDropFolder(entry.fullPath || entry.name);
            }
          }
        }
      }
    }));

    // 忽略列表拖拽
    const idz = document.getElementById('ignoreDropZone');
    let idzCounter = 0;
    idz.addEventListener('dragenter', ev => { ev.preventDefault(); ev.stopPropagation(); idzCounter++; idz.classList.add('active'); });
    idz.addEventListener('dragover', ev => { ev.preventDefault(); ev.stopPropagation(); });
    idz.addEventListener('dragleave', ev => { ev.preventDefault(); ev.stopPropagation(); idzCounter--; if (idzCounter <= 0) { idzCounter = 0; idz.classList.remove('active'); } });
    idz.addEventListener('drop', ev => {
      ev.preventDefault(); ev.stopPropagation(); idzCounter = 0; idz.classList.remove('active');
      const items = ev.dataTransfer.items || [];
      const files = ev.dataTransfer.files || [];
      for (let i = 0; i < (items.length || files.length); i++) {
        let name = '';
        if (items[i]?.webkitGetAsEntry) {
          const entry = items[i].webkitGetAsEntry();
          name = entry ? entry.name : '';
        } else if (files[i]) {
          name = files[i].name;
        }
        if (name && this.selectedFolder) {
          const path = name.replace(/^\//, '');
          console.log(`[ignoreDrop] adding: ${path}, whitelist: ${this._folderWhitelistMode}`);
          this.addIgnoreFromBrowser(path);
        }
      }
    });
  },

  async refresh() {
    try {
      console.log('[refresh] starting...');
      const [config, status, version] = await Promise.all([
        API.getConfig(),
        API.getSystemStatus(),
        API.getSystemVersion(),
      ]);
      console.log(`[refresh] config: ${config.folders?.length} folders, ${config.devices?.length} devices`);

      this.config = config;
      this.systemStatus = status;
      this.folders = config.folders || [];
      this.devices = config.devices || [];

      this.updateStatus(status, version);
      this.updateDevices(null);
      await this.renderFolders();
      this.updateFooter();

      // NAS folders 异步加载（不阻塞首次渲染）
      if (this.sidecarOk) {
        API.getNasFolders().then(nasData => {
          this.nasFolders = nasData.folders || [];
          console.log(`[NAS callback] received ${this.nasFolders.length} folders:`, this.nasFolders.map(f => `${f.id}(missing=${f.localMissing},path=${f.localPath})`).join(', '));
          this.renderFolders();
          // 更新文件数/大小
          for (const f of this.nasFolders) {
            const stats = document.getElementById(`stats-${f.id}`);
            if (stats && (f.globalFiles || f.globalBytes)) {
              this.setStats(f.id, `${(f.globalFiles || 0).toLocaleString()} 文件 · ${this.formatBytes(f.globalBytes || 0)}`);
            }
          }
        }).catch(e => console.error('[NAS callback] error:', e));
      }

      // connections 异步加载
      API.getConnections().then(conn => {
        this.connections = conn;
        this.updateDevices(conn);
        this.updateFooter();
      }).catch(() => {});

    } catch (e) {
      console.error('[refresh] error:', e);
      document.getElementById('statusDot').className = 'status-dot off';
      document.getElementById('statusText').textContent = '连接失败: ' + e.message;
    }
  },

  async initSidecar() {
    try {
      console.log('[initSidecar] checking health...');
      const health = await API.getHealth();
      this.sidecarOk = health.status === 'ok';
      console.log('[initSidecar] sidecarOk:', this.sidecarOk);
      if (this.sidecarOk) {
        const [orderRes, ignoreRes, notesRes] = await Promise.all([
          API.getFolderOrder(),
          API.getGlobalIgnore(),
          API.getAllNotes(),
        ]);
        this.folderOrder = orderRes.order || [];
        this.globalIgnore = ignoreRes.rules || [];
        this.notes = notesRes.notes || {};
        console.log(`[initSidecar] order: ${this.folderOrder.length} items, globalIgnore: ${this.globalIgnore.length} rules, notes: ${Object.keys(this.notes).length}`);
        this.renderGlobalIgnore();
      }
    } catch (e) {
      console.error('[initSidecar] error:', e);
      this.sidecarOk = false;
    }
  },

  startPolling() {
    this.pollTimer = setInterval(() => this.refresh(), 5000);
    this.startEventListener();
  },

  // Events API 长轮询 —— 实时捕获同步活动（不依赖定时轮询）
  _eventSince: 0,
  _eventActive: false,

  async startEventListener() {
    if (this._eventActive) return;
    this._eventActive = true;
    console.log('[events] starting event listener');
    // 先获取当前最新 event ID（跳过历史）
    try {
      const initial = await API.getEvents(0);
      if (initial && initial.length > 0) {
        this._eventSince = initial[initial.length - 1].id;
      }
    } catch (e) {
      console.warn('[events] init failed:', e);
    }
    this._pollEvents();
  },

  async _pollEvents() {
    while (this._eventActive) {
      try {
        const events = await API.getEvents(this._eventSince);
        if (!events || events.length === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        this._eventSince = events[events.length - 1].id;

        let needRefresh = false;
        for (const ev of events) {
          const t = ev.type;
          // 捕获所有同步相关事件
          if (t === 'FolderCompletion' || t === 'StateChanged' ||
              t === 'ItemStarted' || t === 'ItemFinished' ||
              t === 'FolderSummary' || t === 'LocalIndexUpdated' ||
              t === 'RemoteIndexUpdated' || t === 'FolderScanProgress') {
            needRefresh = true;
            const fid = ev.data?.folder || '';
            if (t === 'FolderScanProgress' && fid) {
              // 大文件扫描中（计算 hash），显示扫描进度
              const current = ev.data?.current || 0;
              const total = ev.data?.total || 0;
              if (total > 0) {
                const scanPct = Math.round((current / total) * 100);
                console.log(`[events] ${fid}: scanning ${scanPct}% (${current}/${total})`);
                this.setBadge(fid, `扫描${scanPct}%`, 'folder-badge syncing');
              } else {
                this.setBadge(fid, '扫描中', 'folder-badge syncing');
              }
            } else if (t === 'LocalIndexUpdated' && fid) {
              // 本地索引更新 = 新文件被扫描到，即将上传到 NAS
              console.log(`[events] ${fid}: local index updated (items=${ev.data?.items || 0})`);
              this.setBadge(fid, '↑传输中', 'folder-badge syncing');
            } else if (t === 'FolderCompletion' && ev.data) {
              const pct = Math.round(ev.data.completion || 0);
              if (pct < 100 && fid) {
                const needBytes = ev.data.needBytes || 0;
                console.log(`[events] ${fid}: uploading ↑${pct}% (need ${this.formatBytes(needBytes)})`);
                this.setBadge(fid, `↑${pct}%`, 'folder-badge syncing');
              } else if (pct === 100 && fid) {
                console.log(`[events] ${fid}: sync complete`);
                this.setBadge(fid, '已完成', 'folder-badge idle');
                // 3 秒后恢复空闲显示
                setTimeout(() => {
                  const cached = this._badgeCache[fid];
                  if (cached && cached.text === '已完成') {
                    this.setBadge(fid, '空闲', 'folder-badge idle');
                  }
                }, 3000);
              }
            } else if (t === 'StateChanged' && fid) {
              console.log(`[events] ${fid}: state ${ev.data?.from} → ${ev.data?.to}`);
              if (ev.data?.to === 'scanning') {
                // 只有当前没有更高优先级的 badge 时才显示扫描
                const cached = this._badgeCache[fid];
                if (!cached || cached.text === '空闲' || !cached.text) {
                  this.setBadge(fid, '扫描中', 'folder-badge syncing');
                }
              } else if (ev.data?.to === 'syncing') {
                this.setBadge(fid, '↓同步中', 'folder-badge syncing');
              }
            }
          }
        }
        if (needRefresh) {
          // 不调用完整的 refresh()（会重建DOM导致闪烁）
          // badge 已通过 setBadge 实时更新，只需更新 stats
          this._eventRefreshPending = true;
        }
      } catch (e) {
        // 网络错误时等待后重试
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  },

  // ===== UI 更新 =====

  updateStatus(status, version) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const ver = document.getElementById('statusVersion');
    dot.className = 'status-dot on';
    text.textContent = '运行中';
    ver.textContent = version ? `v${version.version}` : '';

    const conn = this.connections;
    if (conn && conn.total) {
      const up = this.formatBytes(conn.total.inBytesTotal);
      const down = this.formatBytes(conn.total.outBytesTotal);
      document.getElementById('speedText').textContent = `上行 ${this.formatRate(conn.total.outBytesPerSec || 0)} / 下行 ${this.formatRate(conn.total.inBytesPerSec || 0)}`;
    }
  },

  updateDevices(connections) {
    const list = document.getElementById('deviceList');
    const myId = this.systemStatus?.myID || '';

    // 构建新的设备数据
    const cloudDeviceId = localStorage.getItem('cloudServerDeviceId') || '';
    const cloudEnabled = localStorage.getItem('cloudServerEnabled') === 'true';
    const newDeviceData = [];
    for (const dev of this.devices) {
      if (dev.deviceID === myId) continue;
      const conn = connections?.connections?.[dev.deviceID];
      const connected = conn?.connected;
      const name = dev.name || dev.deviceID.substring(0, 7);
      const type = conn?.type || '';
      const isCloud = cloudEnabled && dev.deviceID === cloudDeviceId;
      const meta = connections ? (connected ? (type.includes('relay') ? 'Relay' : type.replace('-', ' ')) : '离线') : '--';
      const dotColor = connected ? (type.includes('relay') ? 'orange' : 'green') : 'text-dim';
      newDeviceData.push({ id: dev.deviceID, name, meta, dotColor, isCloud });
    }

    // 局部更新：只在结构变化时重建 DOM，否则只更新变化的属性
    const structSig = newDeviceData.map(d => d.id).join(',');
    if (this._deviceStructSig !== structSig) {
      // 设备列表结构变化，重建 DOM
      this._deviceStructSig = structSig;
      let html = '';
      for (const d of newDeviceData) {
        html += `<div class="device-item" data-device="${d.id}">
          <span class="device-dot" style="background:var(--${d.dotColor})"></span>
          <span class="device-name">${d.name}</span>
          <span class="device-meta">${d.meta}</span>
        </div>`;
      }
      list.innerHTML = html || '<div style="font-size:10px;color:var(--text-dim);padding:6px 10px">无设备</div>';
    } else {
      // 结构没变，局部更新状态
      for (const d of newDeviceData) {
        const el = list.querySelector(`[data-device="${d.id}"]`);
        if (!el) continue;
        const dot = el.querySelector('.device-dot');
        const meta = el.querySelector('.device-meta');
        if (dot) dot.style.background = `var(--${d.dotColor})`;
        if (meta && meta.textContent !== d.meta) meta.textContent = d.meta;
      }
    }
  },

  async renderFolders() {
    const list = document.getElementById('folderList');
    const source = (this.nasFolders && this.nasFolders.length > 0) ? 'NAS' : 'local';
    console.log(`[renderFolders] source=${source}, nasFolders=${this.nasFolders?.length || 0}, localFolders=${this.folders.length}, pending=${JSON.stringify(this._pendingPathChange || {})}`);

    // 数据源：优先用 NAS 全集，否则用本地
    let displayFolders = [];
    if (this.nasFolders && this.nasFolders.length > 0) {
      displayFolders = this.nasFolders.map(f => ({...f}));
    } else {
      displayFolders = this.folders.map(f => ({
        id: f.id, label: f.label || f.id, localPath: f.path,
        nasPath: '', synced: true, paused: f.paused, type: f.type
      }));
    }

    // 按保存的顺序排序
    if (this.folderOrder.length > 0) {
      displayFolders.sort((a, b) => {
        const ia = this.folderOrder.indexOf(a.id);
        const ib = this.folderOrder.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }

    // 对有 pending 路径变更的文件夹覆盖显示（除非路径确认不存在）
    if (this._pendingPathChange) {
      for (const folder of displayFolders) {
        const pendingPath = this._pendingPathChange[folder.id];
        if (pendingPath) {
          if (folder.localMissing) {
            // 后端确认路径不存在，清除 pending
            delete this._pendingPathChange[folder.id];
          } else {
            folder.localPath = pendingPath;
            folder.paused = true;
          }
        }
      }
    }

    // 先渲染列表（不等 status），后面异步更新
    let html = '';
    for (const folder of displayFolders) {
      const synced = folder.synced;
      const paused = folder.paused;
      const selected = this.selectedFolder?.id === folder.id;

      let statusClass = synced ? (paused ? 'paused' : 'idle') : 'unsynced';
      let badgeClass = statusClass;
      let badgeText = synced ? (paused ? '已暂停' : '空闲') : '未同步';

      // 本地路径缺失
      if (folder.localMissing) {
        console.warn(`[renderFolders] ${folder.id}: localMissing=true, localPath="${folder.localPath}", source=${this.nasFolders ? 'NAS' : 'local'}`);
        statusClass = 'error';
        badgeClass = 'error';
        badgeText = '路径缺失';
      }

      // 路径显示
      const pathDisplay = synced && folder.localPath ? folder.localPath : (folder.localMissing ? '' : '');

      // 操作按钮
      let actionsHtml = '';
      if (!synced) {
        actionsHtml = `<button class="btn-sm btn-sync" onclick="app.showSyncToLocal('${folder.id}')" title="同步到本地">同步</button>`;
      } else {
        actionsHtml = `
          <button class="btn-sm" onclick="app.togglePause('${folder.id}', ${!paused})" title="${paused ? '恢复' : '暂停'}">
            ${paused ? '|>' : '||'}
          </button>
          <button class="btn-sm" onclick="app.showFolderSettings('${folder.id}')" title="设置">...</button>
        `;
      }

      html += `<div class="folder-card ${!synced ? 'unsynced' : ''} ${paused ? 'paused' : ''} ${selected ? 'selected' : ''}"
                    draggable="true" data-id="${folder.id}"
                    onclick="app.selectFolder('${folder.id}')">
        <div class="folder-drag"><span></span><span></span><span></span></div>
        <div class="folder-status ${statusClass}"></div>
        <div class="folder-info">
          <div class="folder-name">${folder.label || folder.id}</div>
          ${pathDisplay ? `<div class="folder-path" onclick="event.stopPropagation();app.openInExplorer('${pathDisplay.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" title="点击打开文件夹">${pathDisplay}</div>` : ''}
        </div>
        <div class="folder-stats" id="stats-${folder.id}">${this._statsCache?.[folder.id] || ''}</div>
        <span class="folder-badge ${this._badgeCache?.[folder.id]?.cls || badgeClass}" id="badge-${folder.id}">${this._badgeCache?.[folder.id]?.text || badgeText}</span>
        <div class="folder-actions" onclick="event.stopPropagation()">
          ${actionsHtml}
        </div>
      </div>`;
    }
    // 生成结构签名（不含 badge/stats/selected 因为这些单独更新）
    const folderSig = displayFolders.map(f => `${f.id}|${f.label}|${f.synced}|${f.paused}|${f.localPath}|${f.localMissing}`).join(';');

    if (this._folderListSig !== folderSig) {
      this._folderListSig = folderSig;
      console.log('[renderFolders] DOM rebuild (structure changed)');
      list.innerHTML = html;
      document.getElementById('folderCount').textContent = displayFolders.length;
      // 绑定拖拽排序
      this.bindDragSort();
    }

    // 异步检查本地路径存在性（快速，不走 NAS SSH）
    if (this.sidecarOk) {
      API.getLocalFolderStatus().then(status => {
        if (!status) return;
        for (const [fid, info] of Object.entries(status)) {
          if (!info.path) continue;
          const badge = document.getElementById(`badge-${fid}`);
          const card = document.querySelector(`.folder-card[data-id="${fid}"]`);
          if (!badge || !card) continue;
          // 有 pending 变更的不覆盖
          if (this._pendingPathChange && this._pendingPathChange[fid]) continue;
          if (!info.exists) {
            console.warn(`[localStatus] ${fid}: path="${info.path}" NOT exists, marking as 路径缺失`);
            badge.textContent = '路径缺失';
            badge.className = 'folder-badge error';
            const dot = card.querySelector('.folder-status');
            if (dot) dot.className = 'folder-status error';
          }
        }
      }).catch(() => {});
    }

    // 从本地 Syncthing 获取文件数/大小 + 同步进度（含推送到 NAS 的进度）
    if (this.sidecarOk) {
      // 先快速从 NAS 缓存获取（确保有数据显示）
      API.getNasStatusCache().then(cache => {
        if (!cache) return;
        for (const [fid, info] of Object.entries(cache)) {
          const stats = document.getElementById(`stats-${fid}`);
          if (stats && !stats.textContent && (info.globalFiles || info.globalBytes)) {
            this.setStats(fid, `${(info.globalFiles || 0).toLocaleString()} 文件 · ${this.formatBytes(info.globalBytes || 0)}`);
          }
        }
      }).catch(() => {});

      // 获取 NAS 设备 ID（用于 completion 查询）
      const myId = this.systemStatus?.myID || '';
      const nasDevice = this.devices.find(d => d.deviceID !== myId);
      const nasDeviceId = nasDevice?.deviceID || '';

      let hasSyncing = false;

      // 对每个已同步文件夹查询状态 + 远端 completion
      for (const folder of displayFolders) {
        if (!folder.synced || folder.paused) continue;
        const fid = folder.id;

        // 本地 db/status（下载进度：NAS→本地）+ 变化检测
        API.getFolderStatus(fid).then(st => {
          if (!st || st.error) return;

          const globalFiles = st.globalFiles || 0;
          const globalBytes = st.globalBytes || 0;
          const localBytes = st.localBytes || 0;
          if (globalFiles || globalBytes) {
            this.setStats(fid, `${globalFiles.toLocaleString()} 文件 · ${this.formatBytes(globalBytes)}`);
          }

          // 检测本地文件变化：localBytes 增长说明有新文件写入
          const prevLocal = this._localBytesCache[fid] || 0;
          if (localBytes > prevLocal && prevLocal > 0 && st.state === 'idle') {
            const now = Date.now();
            const lastScan = this._scanTriggered[fid] || 0;
            // 每个文件夹至少间隔 5 秒才触发一次 scan，避免频繁调用
            if (now - lastScan > 5000) {
              console.log(`[sync] ${fid}: localBytes grew ${this.formatBytes(prevLocal)} → ${this.formatBytes(localBytes)}, triggering rescan`);
              this._scanTriggered[fid] = now;
              API.rescanFolder(fid).catch(() => {});
            }
          }
          this._localBytesCache[fid] = localBytes;

          // 下载进度（NAS→本地）
          if (st.state === 'syncing' || (st.needFiles || 0) > 0) {
            const pct = globalBytes > 0 ? Math.round(((globalBytes - (st.needBytes || 0)) / globalBytes) * 100) : 0;
            console.log(`[sync] ${fid}: downloading ↓${pct}% (need ${st.needFiles} files)`);
            this.setBadge(fid, `↓${pct}%`, 'folder-badge syncing');
            hasSyncing = true;
          } else if (st.state === 'idle' && (st.needFiles || 0) === 0) {
            // 本地空闲无需求，如果 badge 缓存是下载进度则清除
            const cached = this._badgeCache[fid];
            if (cached && cached.text.startsWith('↓')) {
              delete this._badgeCache[fid];
            }
          }
        }).catch(() => {});

        // 远端 completion（上传进度：本地→NAS）— 始终查询
        if (nasDeviceId) {
          API.getCompletion(nasDeviceId, fid).then(comp => {
            if (!comp) return;
            const pct = Math.round(comp.completion || 0);
            const needItems = comp.needItems || 0;
            const needBytes = comp.needBytes || 0;

            if (pct < 100 && needItems > 0) {
              console.log(`[sync] ${fid}: uploading ↑${pct}% (need ${needItems} items, ${this.formatBytes(needBytes)})`);
              this.setBadge(fid, `↑${pct}%`, 'folder-badge syncing');
              hasSyncing = true;
            } else if (pct === 100) {
              // 上传完成，清除缓存让 badge 回到默认状态
              const cached = this._badgeCache[fid];
              if (cached && cached.text.startsWith('↑')) {
                delete this._badgeCache[fid];
                this.setBadge(fid, '空闲', 'folder-badge idle');
              }
            }
          }).catch(() => {});
        }
      }

      // 检测到有同步活动时加快轮询（2秒），否则恢复（5秒）
      setTimeout(() => {
        if (hasSyncing && this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = setInterval(() => this.refresh(), 2000);
        } else if (!hasSyncing && this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = setInterval(() => this.refresh(), 5000);
        }
      }, 500);
    }
  },

  bindDragSort() {
    const list = document.getElementById('folderList');
    let dragEl = null;

    list.querySelectorAll('.folder-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragEl = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        list.querySelectorAll('.folder-card').forEach(c => c.classList.remove('drag-over'));
        dragEl = null;
        // 保存新顺序
        const newOrder = [...list.querySelectorAll('.folder-card')].map(c => c.dataset.id);
        this.folderOrder = newOrder;
        if (this.sidecarOk) API.setFolderOrder(newOrder);
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        if (card !== dragEl && dragEl) card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (dragEl && card !== dragEl) {
          const cards = [...list.querySelectorAll('.folder-card')];
          const from = cards.indexOf(dragEl), to = cards.indexOf(card);
          if (from < to) card.after(dragEl); else card.before(dragEl);
        }
      });
    });
  },

  // ===== 文件夹选择 =====

  async selectFolder(id) {
    // 从 config folders 或 nasFolders 中查找
    let folder = this.folders.find(f => f.id === id);
    if (!folder) {
      // 尝试从 nasFolders（含 pending）中找
      const nf = (this.nasFolders || []).find(f => f.id === id);
      if (nf) folder = { id: nf.id, label: nf.label, path: nf.localPath || '', paused: nf.paused, type: nf.type || 'sendreceive' };
    }
    if (!folder) return;
    this.selectedFolder = folder;

    // 更新选中状态
    document.querySelectorAll('.folder-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.id === id);
    });

    // 面板标题
    document.getElementById('panelFolderName').textContent = folder.label || folder.id;
    document.getElementById('folderIgnoreTag').textContent = `${folder.id}/.stignore`;

    // 清空浏览器面板
    const browser = document.getElementById('ignoreBrowser');
    if (browser) { browser.style.display = 'none'; browser.innerHTML = ''; }

    // 加载忽略规则
    this.loadFolderIgnores(id);

    // 加载详情
    this.loadFolderDetail(id);

    // 加载备注
    document.getElementById('noteArea').value = this.notes[id] || '';
  },

  async loadFolderIgnores(id) {
    const block = document.getElementById('folderIgnoreBlock');
    try {
      console.log(`[loadFolderIgnores] ${id}: fetching...`);
      const data = await API.getIgnores(id);
      const ignores = data.ignore || [];
      console.log(`[loadFolderIgnores] ${id}: got ${ignores.length} raw rules`);
      // 过滤掉全局注入段和注释行
      let inGlobal = false;
      const filtered = [];
      for (const line of ignores) {
        if (line.includes('GLOBAL IGNORE START')) { inGlobal = true; continue; }
        if (line.includes('GLOBAL IGNORE END')) { inGlobal = false; continue; }
        if (inGlobal) continue;
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('//')) continue; // 跳过所有注释（包括 //[black] //[white]）
        filtered.push(line);
      }
      console.log(`[loadFolderIgnores] ${id}: ${filtered.length} filtered rules`);
      // 检测白名单模式：最后一条规则是 * （空白名单或有 ! 规则的白名单）
      const lastIsStar = filtered.length > 0 && filtered[filtered.length - 1].trim() === '*';
      const hasWhiteRules = filtered.some(r => r.trim().startsWith('!'));
      const isWhitelist = lastIsStar && (hasWhiteRules || filtered.length === 1);
      this._folderWhitelistMode = isWhitelist;
      // 白名单模式下，显示 ! 规则（去掉前缀），隐藏末尾的 *
      let displayRules = filtered;
      if (isWhitelist) {
        displayRules = filtered.filter(r => r.trim() !== '*' && r.trim().startsWith('!')).map(r => {
          return r.trim().slice(1);
        });
      }
      block.innerHTML = this.renderIgnoreBlock(displayRules, 'folder', isWhitelist);
    } catch (e) {
      console.error(`[loadFolderIgnores] ${id}: error:`, e);
      block.innerHTML = '<div class="ignore-empty">无法加载</div>';
    }
  },

  renderIgnoreBlock(rules, type, isWhitelist = false) {
    const headerLabel = type === 'global' ? '.stglobalignore' : '.stignore';
    const modeToggle = type === 'folder' ? `
      <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-dim);cursor:pointer;margin-left:auto">
        <input type="checkbox" ${isWhitelist ? 'checked' : ''} onchange="app.toggleWhitelistMode(this.checked)">
        白名单模式
      </label>
    ` : '';
    let body = '';
    if (rules.length === 0) {
      body = `<div class="ignore-empty">${isWhitelist ? '白名单为空，将忽略所有文件' : '暂无规则'}</div>`;
    } else {
      body = rules.map((r, i) => `
        <div class="ignore-line">
          <span class="ignore-icon" style="color:${isWhitelist ? 'var(--green)' : 'var(--red)'}; font-size:12px; min-width:16px; text-align:center">
            ${isWhitelist ? '✓' : '■'}
          </span>
          <span class="line-text">${r}</span>
          <span class="line-del" onclick="app.removeIgnoreRule('${type}', ${i})">x</span>
        </div>
      `).join('');
    }
    const placeholder = isWhitelist ? '添加要同步的路径...' : '添加规则...';
    const browseBtn = type === 'folder' ? `<button onclick="app.showIgnoreBrowser()" title="从文件夹内容中选择" style="font-size:11px">📂</button>` : '';
    return `
      <div class="ignore-block-header">
        <span>${headerLabel}</span>
        ${modeToggle}
        <span class="edit-link">编辑</span>
      </div>
      <div class="ignore-block-body">${body}</div>
      <div class="ignore-add-row">
        <input type="text" placeholder="${placeholder}" onkeydown="if(event.key==='Enter')app.addIgnoreRule('${type}',this)">
        <button onclick="app.addIgnoreRule('${type}',this.previousElementSibling)">+</button>
        ${browseBtn}
      </div>
    `;
  },

  renderGlobalIgnore() {
    const block = document.getElementById('globalIgnoreBlock');
    block.innerHTML = this.renderIgnoreBlock(this.globalIgnore, 'global');
  },

  async saveFolderRulesToJson(folderId) {
    // 从当前 .stignore 读取规则，保存到集中式 JSON
    try {
      const data = await API.getIgnores(folderId);
      const ignores = data.ignore || [];
      // 提取用户规则（过滤掉全局段和文件夹规则段）
      let inManaged = false;
      const userRules = [];
      for (const line of ignores) {
        if (line.includes('GLOBAL IGNORE START') || line.includes('FOLDER RULES START')) { inManaged = true; continue; }
        if (line.includes('GLOBAL IGNORE END') || line.includes('FOLDER RULES END')) { inManaged = false; continue; }
        if (inManaged) continue;
        const t = line.trim();
        if (!t || t.startsWith('//')) continue;
        userRules.push(t);
      }
      // 判断模式
      const lastIsStar = userRules.length > 0 && userRules[userRules.length - 1] === '*';
      const hasWhite = userRules.some(r => r.startsWith('!'));
      const isWhitelist = lastIsStar && (hasWhite || userRules.length === 1);
      let mode, rules;
      if (isWhitelist) {
        mode = 'whitelist';
        rules = userRules.filter(r => r.startsWith('!')).map(r => r.replace(/^!\//, '').replace(/^!/, ''));
      } else {
        mode = 'blacklist';
        rules = userRules.filter(r => r !== '*');
      }
      if (rules.length > 0 || isWhitelist) {
        await API.sideFetch('/api/folder-ignore-rules', 'POST', { folderId, mode, rules });
      }
      console.log(`[saveFolderRulesToJson] ${folderId}: mode=${mode}, rules=${rules.length}`);
    } catch (e) {
      console.error('[saveFolderRulesToJson] error:', e);
    }
  },

  async addIgnoreRule(type, input) {
    const rule = input.value.trim();
    if (!rule) return;
    input.value = '';

    if (type === 'global') {
      this.globalIgnore.push(rule);
      if (this.sidecarOk) await API.setGlobalIgnore(this.globalIgnore);
      this.renderGlobalIgnore();
    } else if (this.selectedFolder) {
      const data = await API.getIgnores(this.selectedFolder.id);
      const ignores = data.ignore || [];
      if (this._folderWhitelistMode) {
        // 白名单模式：在 * 之前插入 !rule
        const starIdx = ignores.lastIndexOf('*');
        const newRule = rule.startsWith('!') ? rule : `!${rule}`;
        if (starIdx >= 0) {
          ignores.splice(starIdx, 0, newRule);
        } else {
          ignores.push(newRule);
          ignores.push('*');
        }
      } else {
        ignores.push(rule);
      }
      await API.setIgnores(this.selectedFolder.id, { ignore: ignores, patterns: data.patterns || [] });
      this.loadFolderIgnores(this.selectedFolder.id);
      this.saveFolderRulesToJson(this.selectedFolder.id);
    }
  },

  async removeIgnoreRule(type, index) {
    if (type === 'global') {
      this.globalIgnore.splice(index, 1);
      if (this.sidecarOk) await API.setGlobalIgnore(this.globalIgnore);
      this.renderGlobalIgnore();
    } else if (this.selectedFolder) {
      const data = await API.getIgnores(this.selectedFolder.id);
      const ignores = data.ignore || [];
      // 过滤掉全局注入段
      const filtered = ignores.filter(l =>
        l.trim() && !l.startsWith('// --- GLOBAL')
      );
      if (this._folderWhitelistMode) {
        // 白名单模式下，index 对应的是 ! 规则（不含末尾 *）
        const whiteRules = filtered.filter(r => r.trim().startsWith('!'));
        if (index < whiteRules.length) {
          const ruleToRemove = whiteRules[index];
          const realIdx = filtered.indexOf(ruleToRemove);
          if (realIdx >= 0) filtered.splice(realIdx, 1);
        }
        // 保留白名单模式（不移除 *）
      } else {
        filtered.splice(index, 1);
      }
      await API.setIgnores(this.selectedFolder.id, { ignore: filtered, patterns: data.patterns || [] });
      this.loadFolderIgnores(this.selectedFolder.id);
      this.saveFolderRulesToJson(this.selectedFolder.id);
    }
  },

  async toggleWhitelistMode(enabled) {
    if (!this.selectedFolder) return;
    const fid = this.selectedFolder.id;
    const data = await API.getIgnores(fid);
    let ignores = data.ignore || [];
    // 分离全局注入段和用户规则
    let inGlobal = false;
    const userRules = [];
    const globalRules = [];
    for (const line of ignores) {
      if (line.includes('GLOBAL IGNORE START')) { inGlobal = true; globalRules.push(line); continue; }
      if (line.includes('GLOBAL IGNORE END')) { inGlobal = false; globalRules.push(line); continue; }
      if (inGlobal) { globalRules.push(line); continue; }
      userRules.push(line);
    }

    let newUserRules = [];
    if (enabled) {
      // 切换到白名单模式：把当前黑名单规则注释保存，恢复已保存的白名单规则
      const savedWhite = []; // 从注释中恢复白名单规则
      const blackRules = []; // 当前活跃的黑名单规则
      for (const r of userRules) {
        const t = r.trim();
        if (t.startsWith('//[white] ')) {
          // 之前保存的白名单规则，恢复
          savedWhite.push(t.slice('//[white] '.length));
        } else if (t.startsWith('//[black] ')) {
          // 已经注释的黑名单规则，保留
          newUserRules.push(r);
        } else if (t === '*' || t.startsWith('//')) {
          // 跳过
        } else {
          // 活跃的黑名单规则 → 注释保存
          blackRules.push(r);
        }
      }
      // 写入：注释的黑名单 + 恢复的白名单 + *
      for (const r of blackRules) {
        newUserRules.push(`//[black] ${r}`);
      }
      for (const r of savedWhite) {
        newUserRules.push(r);
      }
      newUserRules.push('*');
    } else {
      // 切换到黑名单模式：把当前白名单规则注释保存，恢复已保存的黑名单规则
      const savedBlack = []; // 从注释中恢复黑名单规则
      const whiteRules = []; // 当前活跃的白名单规则
      for (const r of userRules) {
        const t = r.trim();
        if (t.startsWith('//[black] ')) {
          // 之前保存的黑名单规则，恢复
          savedBlack.push(t.slice('//[black] '.length));
        } else if (t.startsWith('//[white] ')) {
          // 已经注释的白名单规则，保留
          newUserRules.push(r);
        } else if (t === '*' || t.startsWith('//')) {
          // 跳过 * 和普通注释
        } else if (t.startsWith('!')) {
          // 活跃的白名单规则 → 注释保存
          whiteRules.push(r);
        } else {
          // 其他活跃规则保留
          savedBlack.push(r);
        }
      }
      // 写入：注释的白名单 + 恢复的黑名单
      for (const r of whiteRules) {
        newUserRules.push(`//[white] ${r}`);
      }
      for (const r of savedBlack) {
        newUserRules.push(r);
      }
    }

    const finalIgnores = [...globalRules, ...newUserRules];
    await API.setIgnores(fid, { ignore: finalIgnores, patterns: data.patterns || [] });
    console.log(`[toggleWhitelistMode] ${fid}: whitelist=${enabled}, rules=${newUserRules.length}`);
    this.loadFolderIgnores(fid);
    this.saveFolderRulesToJson(fid);
  },

  async showIgnoreBrowser(subpath = '') {
    if (!this.selectedFolder) return;
    const fid = this.selectedFolder.id;
    const browser = document.getElementById('ignoreBrowser');
    if (!browser) return;
    // 无 subpath 时 toggle（点击📂按钮）；有 subpath 时始终展开（drill down）
    if (!subpath && browser.style.display === 'block' && browser.innerHTML) {
      browser.style.display = 'none';
      return;
    }
    browser.style.display = 'block';
    browser.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:6px">加载中...</div>';
    try {
      let items = [];
      const folderPath = this.selectedFolder.path;
      try {
        // 尝试 Syncthing db/browse API（文件夹必须未暂停）
        const prefix = subpath ? `&prefix=${encodeURIComponent(subpath)}` : '';
        const data = await API.stFetch(`/rest/db/browse?folder=${encodeURIComponent(fid)}&levels=1${prefix}`);
        items = this._parseBrowseData(data);
        items = this._parseBrowseData(data);
      } catch (e) {
        // Fallback：通过 sidecar 浏览本地文件系统
        if (folderPath) {
          const browsePath = subpath ? `${folderPath}\\${subpath.replace(/\//g, '\\\\')}` : folderPath;
          const fsData = await API.browseDir(browsePath);
          const dirs = fsData.dirs || [];
          items = dirs.map(name => ({ name: name.endsWith('/') ? name : name, isDir: true }));
          // 也获取文件（browseDir 只返回目录，需要新增文件列表）
          try {
            const filesData = await API.sideFetch(`/api/list-dir?path=${encodeURIComponent(browsePath)}`);
            if (filesData && filesData.items) {
              items = filesData.items.map(f => ({ name: f.name, isDir: f.isDir }));
            }
          } catch (e2) {
            // 只用目录列表
          }
        } else {
          throw e;
        }
      }
      // 排序：目录在前
      items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
      let html = `<div style="font-size:10px;color:var(--text-dim);padding:4px 6px;border-bottom:1px solid var(--surface-3)">
        ${subpath ? `<span style="cursor:pointer;color:var(--accent)" onclick="app.showIgnoreBrowser('')">⬅ 根目录</span> / ` : ''}
        <span>${subpath || fid}</span>
        <span style="float:right;cursor:pointer" onclick="document.getElementById('ignoreBrowser').style.display='none'">✕</span>
      </div>`;
      if (items.length === 0) {
        html += '<div style="color:var(--text-dim);font-size:11px;padding:6px">空文件夹</div>';
      } else {
        html += items.slice(0, 100).map(item => {
          const icon = item.isDir ? '📁' : '📄';
          const path = subpath ? `${subpath}${item.name}` : item.name;
          const displayName = item.name.replace(/\/$/, '');
          const drillDown = item.isDir ? `onclick="app.showIgnoreBrowser('${path.replace(/'/g, "\\'")}')"` : '';
          return `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;cursor:pointer;border-bottom:1px solid var(--surface-2)">
            <span ${drillDown} style="flex:1;display:flex;align-items:center;gap:4px;overflow:hidden;min-width:0">
              <span style="flex-shrink:0">${icon}</span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${displayName}</span>
            </span>
            <span style="flex-shrink:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:3px;font-size:14px;font-weight:bold;color:var(--green);cursor:pointer"
                  onclick="event.stopPropagation();app.addIgnoreFromBrowser('${path.replace(/'/g, "\\'")}')">+</span>
          </div>`;
        }).join('');
        if (items.length > 100) {
          html += `<div style="color:var(--text-dim);font-size:10px;padding:4px 6px">... 还有 ${items.length - 100} 项</div>`;
        }
      }
      browser.innerHTML = html;
    } catch (e) {
      console.error('[showIgnoreBrowser] error:', e);
      browser.innerHTML = `<div style="color:var(--red);font-size:11px;padding:6px">加载失败: ${e.message}</div>`;
    }
  },

  _parseBrowseData(data) {
    const items = [];
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (typeof entry === 'string') {
          items.push({ name: entry, isDir: entry.endsWith('/') });
        } else if (entry.name) {
          items.push({ name: entry.name, isDir: entry.type === 'FILE_INFO_TYPE_DIRECTORY' || entry.name.endsWith('/') });
        } else {
          for (const [key, val] of Object.entries(entry)) {
            items.push({ name: key, isDir: Array.isArray(val) });
          }
        }
      }
    } else if (typeof data === 'object' && data) {
      for (const [key, val] of Object.entries(data)) {
        items.push({ name: key, isDir: Array.isArray(val) || (typeof val === 'object' && val !== null) });
      }
    }
    return items;
  },

  async addIgnoreFromBrowser(path) {
    // 模拟输入并调用 addIgnoreRule
    const type = 'folder';
    const fakeInput = { value: path, trim: () => path };
    // 直接走 addIgnoreRule 的逻辑
    if (!this.selectedFolder) return;
    const data = await API.getIgnores(this.selectedFolder.id);
    const ignores = data.ignore || [];
    if (this._folderWhitelistMode) {
      const starIdx = ignores.lastIndexOf('*');
      const newRule = `!/${path}`;
      if (starIdx >= 0) {
        ignores.splice(starIdx, 0, newRule);
      } else {
        ignores.push(newRule);
        ignores.push('*');
      }
    } else {
      ignores.push(`/${path}`);
    }
    await API.setIgnores(this.selectedFolder.id, { ignore: ignores, patterns: data.patterns || [] });
    this.loadFolderIgnores(this.selectedFolder.id);
    this.saveFolderRulesToJson(this.selectedFolder.id);
    // 刷新浏览器标记已添加
    const items = document.querySelectorAll('.ignore-browser-item');
    items.forEach(el => {
      if (el.textContent.includes(path.split('/').pop())) {
        el.style.opacity = '0.4';
      }
    });
  },

  async loadFolderDetail(id) {
    const container = document.getElementById('detailContent');
    try {
      console.log(`[loadFolderDetail] ${id}: fetching status...`);
      const status = await API.getFolderStatus(id);
      const folder = this.folders.find(f => f.id === id);
      console.log(`[loadFolderDetail] ${id}: state=${status.state}, globalFiles=${status.globalFiles}, needFiles=${status.needFiles}`);
      container.innerHTML = `
        <div class="section-title">文件夹信息</div>
        <div class="detail-row"><span class="label">ID</span><span class="value">${id}</span></div>
        <div class="detail-row"><span class="label">路径</span><span class="value">${folder?.path || '--'}</span></div>
        <div class="detail-row"><span class="label">状态</span><span class="value">${status.state || '--'}</span></div>
        <div class="detail-row"><span class="label">全局文件数</span><span class="value">${status.globalFiles || 0}</span></div>
        <div class="detail-row"><span class="label">全局大小</span><span class="value">${this.formatBytes(status.globalBytes || 0)}</span></div>
        <div class="detail-row"><span class="label">本地文件数</span><span class="value">${status.localFiles || 0}</span></div>
        <div class="detail-row"><span class="label">待同步</span><span class="value">${status.needFiles || 0} 文件</span></div>
        <div class="detail-row"><span class="label">同步模式</span><span class="value">${folder?.type || 'sendreceive'}</span></div>
        <div class="detail-row"><span class="label">扫描间隔</span><span class="value">${folder?.rescanIntervalS || 60}s</span></div>
      `;
    } catch (e) {
      console.error(`[loadFolderDetail] ${id}: error:`, e);
      container.innerHTML = '<div style="color:var(--text-dim);font-size:11px">加载失败</div>';
    }
  },

  // ===== 操作 =====

  async togglePause(id, paused) {
    console.log(`[togglePause] ${id}: paused=${paused}, hasPending=${!!(this._pendingPathChange && this._pendingPathChange[id])}`);
    // 如果是恢复操作且有待执行的路径变更，先执行后端操作
    if (!paused && this._pendingPathChange && this._pendingPathChange[id]) {
      const newPath = this._pendingPathChange[id];
      delete this._pendingPathChange[id];
      console.log(`[togglePause] ${id}: executing ensure-folder-path to ${newPath}`);

      // 暂停轮询，防止中间状态闪烁
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }

      // 立即更新 DOM 为"同步中"
      const card = document.querySelector(`.folder-card[data-id="${id}"]`);
      if (card) {
        const badge = card.querySelector('.folder-badge');
        if (badge) { badge.textContent = '同步中...'; badge.className = 'folder-badge syncing'; }
        card.classList.remove('paused');
        const statusDot = card.querySelector('.folder-status');
        if (statusDot) statusDot.className = 'folder-status syncing';
      }

      if (this.sidecarOk) {
        const result = await API.sideFetch('/api/ensure-folder-path', 'POST', {
          folderId: id, localPath: newPath, autoResume: true
        });
        if (result.error) {
          alert(`操作失败: ${result.error}`);
          this.startPolling();
          return;
        }
        // 等待后端完成（path 更新 + 不暂停），最多 20 秒
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const cfg = await API.getConfig();
            const f = cfg.folders.find(f => f.id === id);
            if (f && f.path === newPath && !f.paused) break;
          } catch(e) {}
        }

        // 等 NAS 同步完成（needFiles=0），每秒检查一次，最多 60 秒
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const st = await API.getFolderStatus(id);
            if (st && st.needFiles === 0 && st.state === 'idle') break;
          } catch(e) {}
        }

        // 同步完成，改回 sendreceive
        try {
          const cfg = await API.getConfig();
          const f = cfg.folders.find(f => f.id === id);
          if (f && f.type === 'receiveonly') {
            f.type = 'sendreceive';
            await API.setConfig(cfg);
            console.log(`[togglePause] ${id}: 同步完成，已恢复为 sendreceive`);
          }
        } catch(e) {}
      }

      // 恢复轮询并刷新
      this.startPolling();
      await this.refresh();
    } else {
      await API.pauseFolder(id, paused);
      await this.refresh();
    }
  },

  async rescanAll() {
    await API.rescanAll();
  },

  async restart() {
    if (confirm('确认重启 Syncthing？')) {
      await API.restart();
      setTimeout(() => this.refresh(), 3000);
    }
  },

  toggleGlobalPause() {
    // 暂停/恢复所有文件夹
    const allPaused = this.folders.every(f => f.paused);
    this.folders.forEach(f => { f.paused = !allPaused; });
    API.setConfig(this.config);
    this.renderFolders();
  },

  async openInExplorer(path) {
    try {
      await API.sideFetch('/api/open-in-explorer', 'POST', { path });
    } catch (e) {
      console.error('[openInExplorer] error:', e);
    }
  },

  async saveNote() {
    if (!this.selectedFolder || !this.sidecarOk) return;
    const note = document.getElementById('noteArea').value;
    await API.setNote(this.selectedFolder.path, note);
    this.notes[this.selectedFolder.id] = note;
    this.renderFolders();
  },

  // ===== 文件夹设置弹窗 =====

  showFolderSettings(id) {
    let folder = this.folders.find(f => f.id === id);
    // 如果不在本地 config 中，从 nasFolders 构造一个虚拟 folder 对象
    if (!folder) {
      const nasF = (this.nasFolders || []).find(f => f.id === id);
      if (!nasF) return;
      folder = {
        id: nasF.id,
        label: nasF.label || nasF.id,
        path: nasF.localPath || '',
        type: nasF.type || 'sendreceive',
        rescanIntervalS: 60,
        devices: [],
        paused: nasF.paused || false,
      };
    }
    this._editingFolderId = id;

    // 获取设备列表，标记哪些已分享
    const folderDeviceIds = (folder.devices || []).map(d => d.deviceID);
    const myDeviceId = this.config?.defaults?.device?.deviceID || '';
    const devicesHtml = this.devices
      .filter(d => d.deviceID !== myDeviceId)
      .map(d => {
        const checked = folderDeviceIds.includes(d.deviceID) ? 'checked' : '';
        const name = d.name || d.deviceID.substring(0, 7);
        return `<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);cursor:pointer;padding:4px 0">
          <input type="checkbox" class="sett-device" value="${d.deviceID}" ${checked}> ${name} (${d.deviceID.substring(0,7)})
        </label>`;
      }).join('');

    document.getElementById('modalTitle').textContent = `文件夹设置 · ${folder.label || folder.id}`;
    // 优先显示待执行的路径变更
    const displayPath = (this._pendingPathChange && this._pendingPathChange[id]) || folder.path;
    document.getElementById('modalBody').innerHTML = `
      <div class="form-group">
        <label class="form-label">显示名称</label>
        <input class="form-input" id="settLabel" value="${folder.label || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">本地路径</label>
        <div class="path-row">
          <input class="form-input" id="settPath" value="${displayPath}">
          <button onclick="app.openDirBrowser('settPath')">浏览</button>
        </div>
        <div class="migrate-note">
          更改路径后自动执行无感迁移：暂停 → 移动文件 → 重建 .stfolder → 更新配置 → 恢复同步
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">文件夹 ID</label>
        <input class="form-input" value="${folder.id}" disabled>
      </div>
      <div class="form-group">
        <label class="form-label">备注</label>
        <textarea class="form-input" id="settNote" rows="2" style="resize:vertical">${this.notes[folder.id] || ''}</textarea>
        <div class="form-hint">保存在 .stfolder/syncthing-folder-*.txt</div>
      </div>
      <div class="form-group">
        <label class="form-label">共享设备</label>
        <div id="settDevices">${devicesHtml || '<span style="font-size:11px;color:var(--text-dim)">暂无其他设备</span>'}</div>
        <div class="form-hint">勾选后文件夹将同步到对应设备</div>
      </div>
      <div class="form-group">
        <label class="form-label">扫描间隔（秒）</label>
        <input class="form-input" id="settInterval" type="number" value="${folder.rescanIntervalS || 60}" style="width:100px">
      </div>
      <div class="form-group">
        <label class="form-label">同步模式</label>
        <select class="form-select" id="settType">
          <option value="sendreceive" ${folder.type === 'sendreceive' ? 'selected' : ''}>双向同步</option>
          <option value="sendonly" ${folder.type === 'sendonly' ? 'selected' : ''}>仅发送</option>
          <option value="receiveonly" ${folder.type === 'receiveonly' ? 'selected' : ''}>仅接收</option>
        </select>
      </div>
    `;
    document.getElementById('modalFooter').innerHTML = `
      <button class="toolbar-btn" onclick="app.closeModal('folderSettingsModal')">取消</button>
      <button class="toolbar-btn danger" onclick="app.confirmDeleteFolder()">删除</button>
      <button class="toolbar-btn primary" onclick="app.saveFolderSettings()">保存</button>
    `;
    document.getElementById('folderSettingsModal').style.display = 'flex';
  },

  async saveFolderSettings() {
    const id = this._editingFolderId;
    let folder = this.config.folders.find(f => f.id === id);

    const newLabel = document.getElementById('settLabel').value;
    const newPath = document.getElementById('settPath').value.trim();
    const newInterval = parseInt(document.getElementById('settInterval').value) || 60;
    const newType = document.getElementById('settType').value;
    const newNote = document.getElementById('settNote').value;

    console.log(`[saveFolderSettings] ${id}: newPath="${newPath}", folderInConfig=${!!folder}, currentPath="${folder?.path || 'N/A'}"`);

    if (!newPath) {
      alert('请填写本地路径');
      return;
    }

    // 收集选中的设备
    const checkedDevices = [...document.querySelectorAll('.sett-device:checked')].map(cb => ({
      deviceID: cb.value,
      introducedBy: '',
    }));

    // 检查当前文件夹是否 localMissing 或不在本地 config 中
    const nasFolder = (this.nasFolders || []).find(f => f.id === id);
    const isLocalMissing = nasFolder?.localMissing;
    const notInLocal = !folder;
    // 比较输入路径和多个来源判断是否变更
    const pendingPath = (this._pendingPathChange && this._pendingPathChange[id]) || '';
    const currentPath = pendingPath || folder?.path || nasFolder?.localPath || '';
    const pathChanged = newPath !== currentPath;

    console.log(`[saveFolderSettings] ${id}: notInLocal=${notInLocal}, isLocalMissing=${isLocalMissing}, pathChanged=${pathChanged}, currentPath="${currentPath}", pendingPath="${pendingPath}"`);

    // 先关闭弹窗（避免等待后端响应时卡住）
    this.closeModal('folderSettingsModal');

    // 路径变更 / 路径缺失 / 不在本地 → 记录 pending，UI 通过 renderFolders 自动处理
    if (notInLocal || isLocalMissing || pathChanged) {
      console.log(`[saveFolderSettings] ${id}: recording pending path change to "${newPath}"`);
      // 记录待执行的路径变更
      this._pendingPathChange = this._pendingPathChange || {};
      this._pendingPathChange[id] = newPath;
      await this.renderFolders();
    } else if (folder) {
      // 路径没变，只更新 label/interval/type/devices
      folder.label = newLabel;
      folder.rescanIntervalS = newInterval;
      folder.type = newType;
      folder.devices = checkedDevices;
      await API.setConfig(this.config);
    }

    // 保存备注
    if (this.sidecarOk && newNote) {
      await API.setNote(newPath, newNote);
      this.notes[id] = newNote;
    }

    await this.refresh();
  },

  confirmDeleteFolder() {
    const id = this._editingFolderId;
    const folder = this.folders.find(f => f.id === id);
    const displayName = folder?.label || id;
    // 替换 modal 内容为确认界面
    document.getElementById('modalTitle').textContent = '确认删除';
    document.getElementById('modalBody').innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);line-height:1.6">
        确定要删除文件夹 <strong>"${displayName}"</strong> 吗？<br>
        本地文件不会被删除，仅从 Syncthing 移除同步配置。
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:11px;color:var(--text-muted);cursor:pointer">
        <input type="checkbox" id="deleteNasFiles" style="accent-color:var(--red)">
        <span>同时删除服务器文件（不可恢复）</span>
      </label>
    `;
    document.getElementById('modalFooter').innerHTML = `
      <button class="toolbar-btn" onclick="app.showFolderSettings('${id}')">返回</button>
      <button class="toolbar-btn danger" onclick="app.doDeleteFolder('${id}')">确认删除</button>
    `;
  },

  async doDeleteFolder(id) {
    const deleteNasFiles = document.getElementById('deleteNasFiles')?.checked || false;
    if (this.sidecarOk) {
      try { await API.sideFetch('/api/delete-folder', 'POST', { folderId: id, deleteNasFiles }); } catch (e) {}
    }
    this.config.folders = this.config.folders.filter(f => f.id !== id);
    await API.setConfig(this.config);
    this.closeModal('folderSettingsModal');
    this.selectedFolder = null;
    await this.refresh();
  },

  showSyncToLocal(folderId) {
    this._editingFolderId = folderId;
    const folder = (this.nasFolders || []).find(f => f.id === folderId);
    const label = folder?.label || folderId;
    document.getElementById('modalTitle').textContent = `同步到本地 · ${label}`;
    document.getElementById('modalBody').innerHTML = `
      <div class="form-group">
        <label class="form-label">文件夹</label>
        <input class="form-input" value="${label}" disabled>
      </div>
      <div class="form-group">
        <label class="form-label">保存位置（文件夹将创建在此路径下）</label>
        <div class="path-row">
          <input class="form-input" id="syncLocalPath" placeholder="E:\\MMD" value="">
          <button onclick="app.openDirBrowser('syncLocalPath')">浏览</button>
        </div>
        <div class="form-hint" id="addPathError" style="color:var(--red);display:none"></div>
        <div class="form-hint">最终路径：<span id="syncFinalPath">选择位置后显示...</span></div>
      </div>
    `;
    document.getElementById('modalFooter').innerHTML = `
      <button class="toolbar-btn" onclick="app.closeModal('folderSettingsModal')">取消</button>
      <button class="toolbar-btn primary" onclick="app.doSyncToLocal('${folderId}')">开始同步</button>
    `;
    document.getElementById('folderSettingsModal').style.display = 'flex';
    setTimeout(() => document.getElementById('syncLocalPath')?.focus(), 100);
  },

  async doSyncToLocal(folderId) {
    const pathInput = document.getElementById('syncLocalPath');
    const localPath = pathInput.value.trim();
    const errEl = document.getElementById('addPathError');
    if (!localPath) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = '请输入本地路径'; }
      pathInput.style.borderColor = 'var(--red)';
      pathInput.focus();
      return;
    }
    try {
      const autoResume = localStorage.getItem('autoSyncOnAdd') === 'true';
      const shareAll = localStorage.getItem('shareAllDevices') !== 'false';
      const result = await API.syncToLocal(folderId, localPath, autoResume, shareAll);
      if (result.error) {
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = result.error; }
        return;
      }
    } catch (e) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = `失败: ${e.message}`; }
      return;
    }
    this.closeModal('folderSettingsModal');
    await this.refresh();
  },

  showAddFolder() {
    document.getElementById('modalTitle').textContent = '添加同步文件夹';
    document.getElementById('modalBody').innerHTML = `
      <div class="form-group">
        <label class="form-label">文件夹路径</label>
        <div class="path-row">
          <input class="form-input" id="addPath" placeholder="D:\\MyFolder">
          <button>浏览</button>
        </div>
        <div class="form-hint" id="addPathError" style="color:var(--red);display:none"></div>
        <div class="form-hint">将自动创建 .stfolder 标记文件</div>
      </div>
      <div class="form-group">
        <label class="form-label">显示名称（可选）</label>
        <input class="form-input" id="addLabel" placeholder="自动使用目录名">
      </div>
    `;
    document.getElementById('modalFooter').innerHTML = `
      <button class="toolbar-btn" onclick="app.closeModal('folderSettingsModal')">取消</button>
      <button class="toolbar-btn primary" onclick="app.doAddFolder()">添加</button>
    `;
    document.getElementById('folderSettingsModal').style.display = 'flex';
  },

  async doAddFolder() {
    const pathInput = document.getElementById('addPath');
    const path = pathInput.value.trim();
    const label = document.getElementById('addLabel').value.trim();
    const errEl = document.getElementById('addPathError');
    const showErr = (msg) => {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = msg; }
      pathInput.style.borderColor = 'var(--red)';
    };

    if (!path) {
      showErr('请输入完整路径（含盘符）');
      pathInput.focus();
      return;
    }

    // 检查路径是否已存在
    const normPath = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const config = await API.getConfig();
    const duplicate = config.folders.find(f =>
      f.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normPath
    );
    if (duplicate) {
      showErr(`该路径已存在（ID: ${duplicate.id}）`);
      return;
    }

    try {
      if (this.sidecarOk) {
        const autoResume = localStorage.getItem('autoSyncOnAdd') === 'true';
        const result = await API.addFolder(path, label || undefined, autoResume);
        if (result.error) {
          showErr(result.error);
          return;
        }
      } else {
        const folderName = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'folder';
        let folderId = label || folderName;
        const existingIds = config.folders.map(f => f.id);
        if (existingIds.includes(folderId)) {
          showErr(`文件夹 ID "${folderId}" 已存在`);
          return;
        }
        const myDeviceId = config?.defaults?.device?.deviceID || '';
        const allDevices = (config.devices || [])
          .filter(d => d.deviceID !== myDeviceId)
          .map(d => ({ deviceID: d.deviceID, introducedBy: '' }));
        config.folders.push({
          id: folderId,
          label: label || folderName,
          path: path,
          type: 'sendreceive',
          rescanIntervalS: 60,
          fsWatcherEnabled: true,
          fsWatcherDelayS: 2,
          devices: allDevices,
          paused: localStorage.getItem('autoSyncOnAdd') !== 'true',
        });
        await API.setConfig(config);
      }
    } catch (e) {
      const errEl2 = document.getElementById('addPathError');
      if (errEl2) { errEl2.style.display = 'block'; errEl2.textContent = `添加失败: ${e.message}`; }
      return;
    }
    this.closeModal('folderSettingsModal');
    await this.refresh();
  },

  async handleDropFolder(name) {
    // 去掉浏览器 FileSystem API 的前导斜杠
    const cleanName = name.replace(/^\/+/, '');

    // 先通过 sidecar 搜索完整路径
    let foundPath = '';
    if (this.sidecarOk) {
      try {
        const result = await API.findPath(cleanName);
        if (result.paths && result.paths.length === 1) {
          foundPath = result.paths[0];
        } else if (result.paths && result.paths.length > 1) {
          // 多个匹配，让用户选择
          foundPath = result.paths[0]; // 默认选第一个
        }
      } catch (e) {}
    }

    document.getElementById('modalTitle').textContent = '添加同步文件夹';
    const pathsHint = foundPath ? '' : '<div class="form-hint">未找到自动匹配，请手动输入完整路径（含盘符）</div>';
    document.getElementById('modalBody').innerHTML = `
      <div class="form-group">
        <label class="form-label">完整路径</label>
        <input class="form-input" id="addPath" value="${foundPath || cleanName}">
        <div class="form-hint" id="addPathError" style="color:var(--red);display:none"></div>
        ${pathsHint}
      </div>
      <div class="form-group">
        <label class="form-label">显示名称</label>
        <input class="form-input" id="addLabel" value="${cleanName}">
      </div>
    `;
    document.getElementById('modalFooter').innerHTML = `
      <button class="toolbar-btn" onclick="app.closeModal('folderSettingsModal')">取消</button>
      <button class="toolbar-btn primary" onclick="app.doAddFolder()">添加</button>
    `;
    document.getElementById('folderSettingsModal').style.display = 'flex';
  },

  showSettings() {
    const autoSyncOnModify = localStorage.getItem('autoSyncOnModify') === 'true';
    const autoSyncOnAdd = localStorage.getItem('autoSyncOnAdd') === 'true';
    const shareAllDevices = localStorage.getItem('shareAllDevices') !== 'false'; // 默认 true
    const cloudEnabled = localStorage.getItem('cloudServerEnabled') === 'true';
    const cloudDeviceId = localStorage.getItem('cloudServerDeviceId') || '';
    const cloudAddress = localStorage.getItem('cloudServerAddress') || '';
    const cloudName = localStorage.getItem('cloudServerName') || 'cloud-server';

    // 检查云服务器是否已在设备列表中
    const cloudDevice = cloudDeviceId ? this.devices.find(d => d.deviceID === cloudDeviceId) : null;
    const cloudConn = this.connections?.connections?.[cloudDeviceId];
    const cloudStatus = cloudDevice ? (cloudConn?.connected ? '已连接' : '离线') : '未添加';

    document.getElementById('modalTitle').textContent = '设置';
    document.getElementById('modalBody').innerHTML = `
      <div class="form-group">
        <label class="form-label">Sidecar 地址</label>
        <input class="form-input" id="settSidecarUrl" value="${API.sidecar}">
        <div class="form-hint">扩展服务状态：${this.sidecarOk ? '已连接' : '未连接'}</div>
      </div>
      <div class="form-group">
        <label class="form-label">同步行为</label>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer;padding:6px 0">
          <input type="checkbox" id="settAutoSyncModify" ${autoSyncOnModify ? 'checked' : ''}>
          修改文件夹路径后自动开始同步
        </label>
        <div class="form-hint">关闭时修改路径后文件夹暂停，需手动恢复</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer;padding:6px 0">
          <input type="checkbox" id="settAutoSyncAdd" ${autoSyncOnAdd ? 'checked' : ''}>
          添加文件夹后自动开始同步
        </label>
        <div class="form-hint">关闭时添加后文件夹暂停，可先配置忽略规则再手动恢复</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer;padding:6px 0">
          <input type="checkbox" id="settShareAllDevices" ${shareAllDevices ? 'checked' : ''}>
          同步时默认共享给所有已连接设备
        </label>
        <div class="form-hint">开启后点击"同步"会自动关联 NAS + 云服务器等所有设备，关闭则只关联 NAS</div>
      </div>
      <div class="form-group" style="border-top:1px solid var(--surface-3);padding-top:12px;margin-top:8px">
        <label class="form-label">云服务器中转</label>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer;padding:6px 0">
          <input type="checkbox" id="settCloudEnabled" ${cloudEnabled ? 'checked' : ''}
                 onchange="document.getElementById('cloudConfig').style.display=this.checked?'block':'none'">
          启用云服务器加速（关闭后自动回退到 NAS 直连/中继）
        </label>
        <div class="form-hint">开启后数据通过云服务器中转，提升公网同步速度。关闭或云服务器失效时自动回退。</div>
        <div id="cloudConfig" style="display:${cloudEnabled ? 'block' : 'none'};margin-top:8px">
          <div style="margin-bottom:6px">
            <label style="font-size:11px;color:var(--text-dim)">设备 ID</label>
            <input class="form-input" id="settCloudDeviceId" value="${cloudDeviceId}" placeholder="XXXXXXX-XXXXXXX-XXXXXXX-..." style="font-size:11px">
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:11px;color:var(--text-dim)">地址</label>
            <input class="form-input" id="settCloudAddress" value="${cloudAddress}" placeholder="tcp://42.192.65.73:22000" style="font-size:11px">
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:11px;color:var(--text-dim)">名称</label>
            <input class="form-input" id="settCloudName" value="${cloudName}" style="font-size:11px">
          </div>
          <div class="form-hint">状态：${cloudStatus}</div>
        </div>
      </div>
    `;
    document.getElementById('modalFooter').innerHTML = `
      <button class="toolbar-btn" onclick="app.closeModal('folderSettingsModal')">取消</button>
      <button class="toolbar-btn primary" onclick="app.saveSettings()">保存</button>
    `;
    document.getElementById('folderSettingsModal').style.display = 'flex';
  },

  async saveSettings() {
    const sidecar = document.getElementById('settSidecarUrl').value;
    API.sidecar = sidecar;
    localStorage.setItem('autoSyncOnModify', document.getElementById('settAutoSyncModify').checked);
    localStorage.setItem('autoSyncOnAdd', document.getElementById('settAutoSyncAdd').checked);
    localStorage.setItem('shareAllDevices', document.getElementById('settShareAllDevices').checked);

    // 云服务器设置
    const cloudEnabled = document.getElementById('settCloudEnabled').checked;
    const cloudDeviceId = (document.getElementById('settCloudDeviceId')?.value || '').trim();
    const cloudAddress = (document.getElementById('settCloudAddress')?.value || '').trim();
    const cloudName = (document.getElementById('settCloudName')?.value || 'cloud-server').trim();

    const prevEnabled = localStorage.getItem('cloudServerEnabled') === 'true';
    const prevDeviceId = localStorage.getItem('cloudServerDeviceId') || '';

    localStorage.setItem('cloudServerEnabled', cloudEnabled);
    localStorage.setItem('cloudServerDeviceId', cloudDeviceId);
    localStorage.setItem('cloudServerAddress', cloudAddress);
    localStorage.setItem('cloudServerName', cloudName);

    try {
      const config = await API.getConfig();
      if (cloudEnabled && cloudDeviceId) {
        // 记录开启日志
        if (!prevEnabled) {
          API.sideFetch('/api/transfer-log', 'POST', { message: '云服务器已开启', detail: `device=${cloudName} addr=${cloudAddress}` }).catch(() => {});
        }
        // 添加云服务器设备（如果不存在）
        const exists = config.devices.some(d => d.deviceID === cloudDeviceId);
        if (!exists) {
          config.devices.push({
            deviceID: cloudDeviceId,
            name: cloudName,
            addresses: [cloudAddress || 'dynamic'],
            autoAcceptFolders: false,
            paused: false,
          });
          console.log('[settings] cloud server device added');
        }
        // 确保所有文件夹共享给云服务器
        for (const f of config.folders) {
          const hasCloud = f.devices.some(d => d.deviceID === cloudDeviceId);
          if (!hasCloud) {
            f.devices.push({ deviceID: cloudDeviceId, introducedBy: '' });
          }
        }
      } else if (!cloudEnabled && prevEnabled && prevDeviceId) {
        // 关闭云服务器：从所有文件夹中移除，并删除设备
        for (const f of config.folders) {
          f.devices = f.devices.filter(d => d.deviceID !== prevDeviceId);
        }
        config.devices = config.devices.filter(d => d.deviceID !== prevDeviceId);
        console.log('[settings] cloud server device removed');
        API.sideFetch('/api/transfer-log', 'POST', { message: '云服务器已关闭', detail: '回退到 NAS 直连/中继' }).catch(() => {});
      }
      await API.setConfig(config);
    } catch (e) {
      console.error('[settings] cloud server config error:', e);
    }

    this.closeModal('folderSettingsModal');
    this.refresh();
    this.initSidecar();
  },

  resolveConflicts() {
    window.open('http://127.0.0.1:8384', '_blank');
  },

  async showTransferLog() {
    const list = document.getElementById('folderList');
    list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px">加载传输日志...</div>';
    try {
      const data = await API.getTransferLog(null, 100);
      const logs = data?.logs || [];
      if (logs.length === 0) {
        list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px">暂无传输记录（等待文件变化后自动记录）</div>';
        return;
      }
      let html = '<div style="padding:8px 12px;font-size:10px;font-family:monospace;line-height:1.8;overflow-y:auto;max-height:calc(100vh - 120px)">';
      html += `<div style="color:var(--text-dim);margin-bottom:8px">共 ${data.total} 条记录（显示最近 ${logs.length} 条）</div>`;
      for (const l of logs.reverse()) {
        const color = l.event === 'Finished' ? 'var(--green)' :
                      l.event === 'Started' ? 'var(--accent)' :
                      l.event === 'Completion' ? 'var(--orange)' :
                      l.event === 'StateChanged' ? 'var(--text-dim)' :
                      'var(--text-muted)';
        const itemDisplay = l.item && !l.item.startsWith('(') ? l.item.split('/').pop() : l.item;
        html += `<div style="border-bottom:1px solid var(--surface-2);padding:2px 0">`;
        html += `<span style="color:var(--text-dim)">${l.time}</span> `;
        html += `<span style="color:var(--accent)">[${l.folder}]</span> `;
        html += `<span style="color:${color};font-weight:500">${l.event}</span> `;
        html += `<span style="color:var(--text)">${itemDisplay}</span>`;
        if (l.detail) html += ` <span style="color:var(--text-dim)">${l.detail}</span>`;
        html += `</div>`;
      }
      html += '</div>';
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML = `<div style="padding:12px;color:var(--red);font-size:11px">加载失败: ${e.message}</div>`;
    }
  },

  dismissAlert() {
    document.getElementById('alertBar').style.display = 'none';
  },

  closeModal(id) {
    document.getElementById(id).style.display = 'none';
  },

  updateFooter() {
    const dot = document.getElementById('footerDot');
    dot.className = 'statusbar-dot';
    dot.style.background = 'var(--green)';
    document.getElementById('footerStatus').textContent = '运行中';

    const connected = this.connections?.connections
      ? Object.values(this.connections.connections).filter(c => c.connected).length : 0;
    document.getElementById('footerDevices').textContent = `${connected} 设备在线`;

    const active = this.folders.filter(f => !f.paused).length;
    const paused = this.folders.filter(f => f.paused).length;
    document.getElementById('footerFolders').textContent = `${this.folders.length} 文件夹 (${active} 活跃 / ${paused} 暂停)`;

    if (this.connections?.total) {
      document.getElementById('footerSpeed').textContent =
        `上行 ${this.formatRate(this.connections.total.outBytesPerSec || 0)} / 下行 ${this.formatRate(this.connections.total.inBytesPerSec || 0)}`;
    }
  },

  // ===== 工具函数 =====

  formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  },

  formatRate(bytesPerSec) {
    if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s';
  },

  // ===== 目录浏览器 =====
  _dirBrowserTarget: null,

  async openDirBrowser(targetInputId) {
    this._dirBrowserTarget = targetInputId;
    const currentPath = document.getElementById(targetInputId)?.value || '';
    // 只有绝对路径才从当前值开始浏览，否则从驱动器列表开始
    const startPath = (currentPath && /^[A-Z]:\\/i.test(currentPath)) ? currentPath : '';
    await this.loadDirBrowser(startPath);
  },

  async loadDirBrowser(browsePath) {
    try {
      const data = await API.browseDir(browsePath);
      const dirs = data.dirs || [];
      const parent = data.parent || '';
      const currentPath = data.path || '';

      let listHtml = '';
      if (parent || currentPath) {
        listHtml += `<div class="dir-item dir-parent" onclick="app.loadDirBrowser('${parent.replace(/\\/g, '\\\\')}')">..</div>`;
      }
      for (const d of dirs) {
        const full = currentPath ? (currentPath.replace(/\\$/, '') + '\\' + d) : d;
        listHtml += `<div class="dir-item" onclick="app.loadDirBrowser('${full.replace(/\\/g, '\\\\')}')">${d}</div>`;
      }

      document.getElementById('modalTitle').textContent = '选择目录';
      document.getElementById('modalBody').innerHTML = `
        <div class="form-group">
          <label class="form-label">当前路径</label>
          <input class="form-input" id="dirBrowserPath" value="${currentPath}" onkeydown="if(event.key==='Enter')app.loadDirBrowser(this.value)">
        </div>
        <div class="dir-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;margin-top:8px">
          ${listHtml || '<div style="padding:12px;color:var(--text-dim);font-size:11px">空目录</div>'}
        </div>
      `;
      document.getElementById('modalFooter').innerHTML = `
        <button class="toolbar-btn" onclick="app.closeDirBrowser()">取消</button>
        <button class="toolbar-btn primary" onclick="app.selectDir()">选择此目录</button>
      `;
      document.getElementById('folderSettingsModal').style.display = 'flex';
    } catch (e) {
      console.error('[dirBrowser]', e);
    }
  },

  selectDir() {
    const path = document.getElementById('dirBrowserPath')?.value || '';
    if (this._dirBrowserTarget && path) {
      const targetId = this._dirBrowserTarget;
      this._dirBrowserTarget = null;
      this.closeModal('folderSettingsModal');
      setTimeout(() => {
        if (targetId === 'settPath') {
          this.showFolderSettings(this._editingFolderId);
          setTimeout(() => { document.getElementById('settPath').value = path; }, 50);
        } else if (targetId === 'addPath' || targetId === 'syncLocalPath') {
          const el = document.getElementById(targetId);
          if (el) el.value = path;
        }
      }, 50);
    }
  },

  closeDirBrowser() {
    // 如果是从设置弹窗打开的，恢复设置弹窗
    if (this._dirBrowserTarget === 'settPath' && this._editingFolderId) {
      this.showFolderSettings(this._editingFolderId);
    } else {
      this.closeModal('folderSettingsModal');
    }
    this._dirBrowserTarget = null;
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => app.init());
