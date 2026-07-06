# 创建桌面快捷方式 — 双击启动飞书桥接
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '飞书桥接.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = Join-Path $scriptDir 'start.bat'
$sc.WorkingDirectory = $scriptDir
$sc.Description = '飞书↔Claude Code 消息桥接'
$sc.WindowStyle = 7          # 最小化启动
$sc.IconLocation = 'shell32.dll,14'   # 地球图标，可自行换
$sc.Save()

Write-Host "✅ 桌面快捷方式已创建: 飞书桥接.lnk"
Write-Host "   右键快捷方式 → 属性 → 更改图标 可以换别的图标"
