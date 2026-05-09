# SyncTrayzor Custom GUI - 一键启动
# 用法: .\start.ps1
# 可选: .\start.ps1 -ApiKey "你的API Key"

param(
    [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 加载 .env 文件（NAS 配置等）
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
    Write-Host "[启动] 已加载 .env 配置"
}

# 获取 API Key
if (-not $ApiKey) {
    $ApiKey = $env:SYNCTHING_API_KEY
}
if (-not $ApiKey) {
    # 尝试从 Syncthing config.xml 读取
    $configPath = "$env:LOCALAPPDATA\Syncthing\config.xml"
    if (Test-Path $configPath) {
        $xml = [xml](Get-Content $configPath -Raw)
        $ApiKey = $xml.configuration.gui.apikey
        Write-Host "[启动] 从 config.xml 读取 API Key: $($ApiKey.Substring(0,8))..."
    }
}
if (-not $ApiKey) {
    Write-Host "[错误] 未找到 API Key，请设置 SYNCTHING_API_KEY 环境变量或传入 -ApiKey 参数" -ForegroundColor Red
    exit 1
}

# 启动 Sidecar
Write-Host "[启动] 启动 Sidecar 服务 (:8385)..."
$sidecar = Start-Process -FilePath "python" `
    -ArgumentList "$root\backend\sidecar.py", $ApiKey `
    -WindowStyle Hidden -PassThru

# 启动前端服务
Write-Host "[启动] 启动前端服务 (:8080)..."
$frontend = Start-Process -FilePath "python" `
    -ArgumentList "-m", "http.server", "8080", "--directory", "$root\frontend" `
    -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 1

# 打开浏览器
$url = "http://127.0.0.1:8080?key=$ApiKey"
Write-Host "[启动] 打开浏览器: $url"
Start-Process $url

Write-Host ""
Write-Host "=== Syncthing Custom GUI 已启动 ===" -ForegroundColor Green
Write-Host "  前端: http://127.0.0.1:8080"
Write-Host "  Sidecar: http://127.0.0.1:8385"
Write-Host "  Syncthing API: http://127.0.0.1:8384"
Write-Host ""
Write-Host "按 Ctrl+C 或关闭此窗口停止服务"

# 等待退出
try {
    Wait-Process -Id $sidecar.Id
} catch {
    # 清理
    if (!$sidecar.HasExited) { Stop-Process -Id $sidecar.Id -Force }
    if (!$frontend.HasExited) { Stop-Process -Id $frontend.Id -Force }
}
