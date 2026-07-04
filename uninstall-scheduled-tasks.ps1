# 卸载钉钉打卡确认助手计划任务

$MorningTask = '钉钉上班确认助手'
$EveningTask = '钉钉下班确认助手'

foreach ($name in @($MorningTask, $EveningTask)) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "已删除: $name"
    } else {
        Write-Host "不存在: $name"
    }
}

Write-Host '卸载完成'
