# 安装钉钉打卡确认助手计划任务
# 上班 09:40 启动（脚本内随机 09:40-09:50 发微信）
# 下班 19:05 启动（脚本内随机 19:05-19:20 发微信）

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodePath = if ($nodeCmd) { $nodeCmd.Source } else { $null }
if (-not $NodePath) {
    Write-Error '未找到 node，请先安装 Node.js 18+'
}

$MorningTask = '钉钉上班确认助手'
$EveningTask = '钉钉下班确认助手'

function Install-HelperTask {
    param(
        [string]$Name,
        [string]$At,
        [string]$TaskArg
    )
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "更新计划任务: $Name"
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    } else {
        Write-Host "创建计划任务: $Name"
    }

    $action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$ProjectRoot\src\main.js`" $TaskArg" -WorkingDirectory $ProjectRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    # 仅当用户登录时运行；默认不唤醒电脑（wakeToRun=false）
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -WakeToRun:$false
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    try {
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        Write-Host "  OK: $Name 每天 $At 运行（仅用户登录时）"
        return $true
    } catch {
        Write-Warning "  普通权限失败，尝试最高权限: $_"
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        Write-Host "  OK (Highest): $Name 每天 $At 运行"
        return $true
    }
}

Write-Host '========================================'
Write-Host ' 安装钉钉打卡确认助手计划任务'
Write-Host " 项目目录: $ProjectRoot"
Write-Host ' 说明: 需用户已登录且 wxbot/微信在线'
Write-Host '========================================'

Install-HelperTask -Name $MorningTask -At '09:40' -TaskArg 'morning'
Install-HelperTask -Name $EveningTask -At '19:05' -TaskArg 'evening'

Write-Host ''
Write-Host '完成。可用以下命令查看:'
Write-Host "  Get-ScheduledTask -TaskName '$MorningTask',''$EveningTask''"
