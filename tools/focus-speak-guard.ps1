<#
  focus-speak-guard.ps1 —— 临时兜底：切换会话立即停止语音朗读
  ============================================================================
  背景：dsh-plugin-speak 的「切换会话立即停止朗读」是插件功能，改完代码要重启
  DSH 才生效。本脚本在 DSH 尚未重启时顶上：

  每 300ms 读一次 DSH 主窗口标题（形如「会话名 — DeepSeek Harness」）。切换会话时
  标题会变，于是立刻杀掉正在朗读的 PowerShell 播放进程，并在随后 10 秒内继续拦
  截（防止旧会话的回复合成完才出声）。只按标题变化判断，不看前台窗口——远程桌面
  /远程控制软件常把前台窗口占住，看前台会误判。

  当新版插件启动并写出「切换窗口/会话立即停止朗读」日志后，本脚本自动退出
  （插件接管），所以不需要安装开机自启。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File focus-speak-guard.ps1 -Watch
    powershell -NoProfile -ExecutionPolicy Bypass -File focus-speak-guard.ps1 -DryRun -Watch
    powershell -NoProfile -ExecutionPolicy Bypass -File focus-speak-guard.ps1 -Test
#>
param(
  [switch]$Watch,
  [switch]$DryRun,
  [switch]$Test,
  [int]$PollMs = 300,
  [int]$KillPollMs = 500,
  [int]$BlockSeconds = 10
)

$ErrorActionPreference = 'SilentlyContinue'

$root = Join-Path $env:USERPROFILE '.dsh'
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'focus-speak-guard.log'
$lockFile = Join-Path $logDir 'focus-speak-guard.lock'
$speakLog = Join-Path $logDir 'speak-plugin.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 512KB) {
      Move-Item -Path $logFile -Destination ($logFile + '.1') -Force
    }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch { }
  if (-not $Watch) { Write-Output $line }
}

# ---------------------------------------------------------------- DSH 窗口标题
# 标题形如「<会话名> — DeepSeek Harness」，切换/重命名会话时会变。
function Get-DshWindowTitle {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { return [string]$proc.MainWindowTitle }
  return ''
}

# ---------------------------------------------------------------- 朗读进程
function Get-SpeakingProcesses {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'System\.Windows\.Media\.MediaPlayer|System\.Speech\.Synthesis' } |
    Select-Object ProcessId, CommandLine
}

function Get-SynthesizingProcesses {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'edge_tts' -and $_.CommandLine -match 'speak-' } |
    Select-Object ProcessId, CommandLine
}

function Stop-Speaking {
  $killed = 0
  $speaking = @(Get-SpeakingProcesses)
  foreach ($proc in $speaking) {
    if ($DryRun) {
      Write-Log ("[dry] 应停止播放进程 {0}" -f $proc.ProcessId)
    } else {
      & taskkill /PID $proc.ProcessId /T /F | Out-Null
      $killed++
    }
  }
  $synth = @(Get-SynthesizingProcesses)
  foreach ($proc in $synth) {
    if ($DryRun) {
      Write-Log ("[dry] 应停止合成进程 {0}" -f $proc.ProcessId)
    } else {
      & taskkill /PID $proc.ProcessId /T /F | Out-Null
      $killed++
    }
  }
  return $killed
}

# ---------------------------------------------------------------- 插件是否已接管
function Test-PluginTookOver([datetime]$startedAt) {
  if (-not (Test-Path $speakLog)) { return $false }
  $item = Get-Item $speakLog
  if ($item.LastWriteTime -lt $startedAt) { return $false }
  $tail = Get-Content -Path $speakLog -Tail 60 -Encoding UTF8
  foreach ($line in $tail) {
    if ($line -match '切换窗口/会话立即停止朗读') { return $true }
  }
  return $false
}

# ---------------------------------------------------------------- 单实例
if (-not $Test) {
  if (Test-Path $lockFile) {
    $oldPid = (Get-Content -Path $lockFile -Raw).Trim()
    if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
      Write-Output "已有实例在运行（PID $oldPid），退出。"
      exit 0
    }
  }
  Set-Content -Path $lockFile -Value $PID -Encoding ASCII
}

# ---------------------------------------------------------------- 测试模式
if ($Test) {
  Write-Output ("DSH 窗口标题：{0}" -f (Get-DshWindowTitle))
  $speaking = @(Get-SpeakingProcesses)
  Write-Output ("正在朗读的进程：{0}" -f (($speaking | ForEach-Object { $_.ProcessId }) -join ', '))
  Write-Output ("插件是否已接管：{0}" -f (Test-PluginTookOver (Get-Date).AddYears(-1)))
  exit 0
}

# ---------------------------------------------------------------- 常驻监视
$startedAt = Get-Date
Write-Log ("哨兵启动（PID {0}，轮询 {1}ms，dry={2}）" -f $PID, $PollMs, [bool]$DryRun)

$lastDshTitle = Get-DshWindowTitle
$blockUntil = [DateTime]::MinValue
$lastCheck = Get-Date
$lastTakeoverCheck = Get-Date

while ($Watch) {
  $dshTitle = Get-DshWindowTitle
  if ($dshTitle -and $lastDshTitle -and $dshTitle -ne $lastDshTitle) {
    Write-Log ("切换会话（{0} → {1}）→ 立即停止朗读" -f $lastDshTitle, $dshTitle)
    [void](Stop-Speaking)
    $blockUntil = (Get-Date).AddSeconds($BlockSeconds)
  }
  if ($dshTitle) { $lastDshTitle = $dshTitle }

  if ((Get-Date) -lt $blockUntil -and ((Get-Date) - $lastCheck).TotalMilliseconds -ge $KillPollMs) {
    $killed = Stop-Speaking
    if ($killed -gt 0 -and -not $DryRun) {
      Write-Log ("切换会话后拦截了 {0} 个朗读进程" -f $killed)
    }
    $lastCheck = Get-Date
  }

  if (((Get-Date) - $lastTakeoverCheck).TotalSeconds -ge 10) {
    if (Test-PluginTookOver $startedAt) {
      Write-Log '检测到新版插件已接管（控制端支持切换窗口/会话停止），哨兵退出'
      Remove-Item -Path $lockFile -Force
      exit 0
    }
    $lastTakeoverCheck = Get-Date
  }

  Start-Sleep -Milliseconds $PollMs
}

Remove-Item -Path $lockFile -Force
