/**
 * API Layer - Syncthing REST + Sidecar
 * 所有请求都通过 sidecar (:8385) 代理，无需前端管理 API Key
 */
const API = {
  sidecar: 'http://127.0.0.1:8385',
  apiKey: '', // 保留兼容但不再使用

  init(apiKey) {
    this.apiKey = apiKey;
  },

  // ===== Syncthing REST API (通过 sidecar 代理) =====
  async stFetch(endpoint, method = 'GET', data = null) {
    const opts = { method, headers: {} };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
    const resp = await fetch(`${this.sidecar}${endpoint}`, opts);
    if (!resp.ok) throw new Error(`API ${resp.status}: ${endpoint}`);
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  },

  async getConfig() { return this.stFetch('/rest/config'); },
  async setConfig(config) { return this.stFetch('/rest/config', 'PUT', config); },
  async getSystemStatus() { return this.stFetch('/rest/system/status'); },
  async getSystemVersion() { return this.stFetch('/rest/system/version'); },
  async getConnections() { return this.stFetch('/rest/system/connections'); },
  async getEvents(since = 0) { return this.stFetch(`/rest/events?since=${since}&limit=50&timeout=5`); },
  async getFolderStatus(id) { return this.stFetch(`/rest/db/status?folder=${encodeURIComponent(id)}`); },
  async getCompletion(device, folder) {
    return this.stFetch(`/rest/db/completion?device=${device}&folder=${encodeURIComponent(folder)}`);
  },
  async rescanFolder(id) { return this.stFetch(`/rest/db/scan?folder=${encodeURIComponent(id)}`, 'POST'); },
  async rescanAll() { return this.stFetch('/rest/db/scan', 'POST'); },
  async restart() { return this.stFetch('/rest/system/restart', 'POST'); },
  async getIgnores(id) { return this.stFetch(`/rest/db/ignores?folder=${encodeURIComponent(id)}`); },
  async setIgnores(id, ignores) {
    return this.stFetch(`/rest/db/ignores?folder=${encodeURIComponent(id)}`, 'POST', ignores);
  },
  async pauseFolder(id, paused) {
    return this.sideFetch('/api/pause-folder', 'POST', { folderId: id, paused });
  },

  // ===== Sidecar API =====
  async sideFetch(endpoint, method = 'GET', data = null) {
    const opts = { method, headers: {} };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
    const resp = await fetch(`${this.sidecar}${endpoint}`, opts);
    return resp.json();
  },

  async getHealth() { return this.sideFetch('/api/health'); },
  async getLocalFolderStatus() { return this.sideFetch('/api/local-folder-status'); },
  async getNasStatusCache() { return this.sideFetch('/api/nas-status-cache'); },
  async getFolderOrder() { return this.sideFetch('/api/folder-order'); },
  async setFolderOrder(order) { return this.sideFetch('/api/folder-order', 'POST', { order }); },
  async getGlobalIgnore() { return this.sideFetch('/api/global-ignore'); },
  async setGlobalIgnore(rules) { return this.sideFetch('/api/global-ignore', 'POST', { rules }); },
  async getNote(path) { return this.sideFetch(`/api/note?path=${encodeURIComponent(path)}`); },
  async getAllNotes() { return this.sideFetch('/api/notes'); },
  async setNote(path, note) { return this.sideFetch('/api/note', 'POST', { path, note }); },
  async addFolder(path, label) { return this.sideFetch('/api/add-folder', 'POST', { path, label }); },
  async findPath(name) { return this.sideFetch(`/api/find-path?name=${encodeURIComponent(name)}`); },
  async getNasFolders() { return this.sideFetch('/api/nas-folders'); },
  async getNasFolderStatus(folderId) { return this.sideFetch(`/api/nas-folder-status?folder=${encodeURIComponent(folderId)}`); },
  async syncToLocal(folderId, localPath, autoResume) { return this.sideFetch('/api/sync-to-local', 'POST', { folderId, localPath, autoResume: !!autoResume }); },
  async unsyncLocal(folderId) { return this.sideFetch('/api/unsync-local', 'POST', { folderId }); },
  async deleteFolder(folderId) { return this.sideFetch('/api/delete-folder', 'POST', { folderId }); },
  async migratePath(folderId, newPath) {
    return this.sideFetch('/api/migrate-path', 'POST', { folderId, newPath });
  },
  async browseDir(path) {
    return this.sideFetch(`/api/browse-dir?path=${encodeURIComponent(path || '')}`);
  },
  async getTransferLog(folder, limit = 100) {
    const params = new URLSearchParams();
    if (folder) params.set('folder', folder);
    params.set('limit', limit);
    return this.sideFetch(`/api/transfer-log?${params}`);
  },
};
