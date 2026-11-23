$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('sticky-notes-hook-' + [Guid]::NewGuid().ToString('N'))
try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $scriptPath = Join-Path $testRoot 'hook.ps1'
    $source = Join-Path $PSScriptRoot '..\scripts\chat-sync-hook.ps1'
    [System.IO.File]::WriteAllText($scriptPath, [System.IO.File]::ReadAllText($source), [System.Text.UTF8Encoding]::new($true))
    $transcript = Join-Path $testRoot '中文对话.jsonl'
    $entries = @(
        @{ type = 'session_meta'; payload = @{ cwd = 'C:\项目\中文项目' } },
        @{ type = 'response_item'; payload = @{ type = 'message'; role = 'system'; content = @(@{type='input_text';text='PRIVATE SYSTEM INSTRUCTIONS'}) } },
        @{ type = 'response_item'; payload = @{ type = 'message'; role = 'user'; content = @(@{type='input_text';text='明天给客户发报价'}) } },
        @{ type = 'response_item'; payload = @{ type = 'message'; role = 'assistant'; content = @(@{type='output_text';text='报价计划已经整理好了'}) } },
        @{ type = 'response_item'; payload = @{ type = 'function_call'; name = 'secret_tool'; arguments = 'NOT INCLUDED' } }
    )
    foreach ($entry in $entries) { $entry.timestamp = [DateTimeOffset]::UtcNow.AddSeconds(10).ToString('o') }
    $oldMessage = @{ timestamp='2020-01-01T00:00:00Z'; type='response_item';payload=@{type='message';role='user';content=@(@{type='input_text';text='Do not backfill this historical task'})} }
    $entries += $oldMessage
    $lines = @($entries | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 10 -Compress })
    [System.IO.File]::WriteAllLines($transcript, $lines, [System.Text.UTF8Encoding]::new($false))
    $eventJson = ConvertTo-Json -Compress @{session_id='test-session';turn_id='test-turn';hook_event_name='Stop';transcript_path=$transcript;stop_hook_active=$false}
    # Native hooks send UTF-8 JSON, including paths containing unicode characters.
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $eventJson | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -SyncDirectory $testRoot
    if (@(Get-ChildItem (Join-Path $testRoot 'queue') -Filter '*.json' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Disabled hook unexpectedly queued a conversation' }
    [System.IO.File]::WriteAllText((Join-Path $testRoot 'enabled'), '1')
    # The real client keeps the transcript open for writing while Stop hooks run.
    $writer = [System.IO.File]::Open($transcript, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
    try {
        $eventJson | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -SyncDirectory $testRoot
    } finally { $writer.Dispose() }
    $files = @(Get-ChildItem (Join-Path $testRoot 'queue') -Filter '*.json')
    if ($files.Count -ne 1) { throw 'Enabled Stop hook did not enqueue exactly one turn' }
    $job = [System.IO.File]::ReadAllText($files[0].FullName) | ConvertFrom-Json
    if (!$job.explicit_only -or $job.messages.Count -ne 1 -or $job.messages[0].role -ne 'user' -or $job.messages[0].text -ne '明天给客户发报价') { throw 'Hook must enqueue only the user text with explicit sync enabled' }
    if ($job.messages[0].index -ne 3) { throw 'Transcript cursor positions were not preserved' }
    if ($job.cwd -ne 'C:\项目\中文项目') { throw 'Session metadata project directory was not preserved' }
    $repeatEvent = ConvertTo-Json -Compress @{session_id='test-session';turn_id='test-turn';hook_event_name='Stop';transcript_path=$transcript;stop_hook_active=$true}
    $repeatEvent | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -SyncDirectory $testRoot
    if (@(Get-ChildItem (Join-Path $testRoot 'queue') -Filter '*.json').Count -ne 1) { throw 'Continuation hook unexpectedly queued another turn' }
    $cwdEvent = ConvertTo-Json -Compress @{session_id='test-session';turn_id='second-turn';hook_event_name='Stop';transcript_path=$transcript;cwd='C:\项目\当前项目';stop_hook_active=$false}
    $cwdEvent | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -SyncDirectory $testRoot
    $jobs = @(Get-ChildItem (Join-Path $testRoot 'queue') -Filter '*.json' | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json })
    if ($jobs.Count -ne 2 -or @($jobs | Where-Object { $_.turn_id -eq 'second-turn' -and $_.cwd -eq 'C:\项目\当前项目' }).Count -ne 1) { throw 'Hook event cwd did not take precedence over session metadata' }

    $editorEntries = @(
        @{ type='event_msg'; payload=@{ type='task_started'; turn_id='earlier' } },
        @{ type='response_item'; payload=@{ type='message'; role='user'; content=@(@{type='input_text';text='记个待办：旧消息'}) } },
        @{ type='event_msg'; payload=@{ type='item_completed'; turn_id='earlier'; item=@{ type='FileChange'; status='completed'; changes=@{'C:\project\old.ts'=@{type='add';content='PRIVATE PATCH'}} } } },
        @{ type='event_msg'; payload=@{ type='task_started'; turn_id='edit-turn' } },
        @{ type='response_item'; payload=@{ type='message'; role='user'; content=@(@{type='input_text';text=(('附件' * 1750) + "`n## My request:`n隐藏项目路径")}) } },
        @{ type='event_msg'; payload=@{ type='item_completed'; turn_id='edit-turn'; item=@{ type='FileChange'; status='failed'; changes=@{'C:\project\failed.rs'=@{type='add';content='PRIVATE PATCH'}} } } },
        @{ type='event_msg'; payload=@{ type='item_completed'; turn_id='edit-turn'; item=@{ type='FileChange'; status='completed'; changes=@{'C:\project\README.md'=@{type='add';content='PRIVATE PATCH'}} } } },
        @{ type='event_msg'; payload=@{ type='item_completed'; turn_id='edit-turn'; item=@{ type='FileChange'; status='completed'; changes=@{'C:\project\项目.tsx'=@{type='update';unified_diff='PRIVATE PATCH'}; 'C:\project\style.css'=@{type='delete';content='PRIVATE PATCH'}} } } }
    )
    foreach ($entry in $editorEntries) { $entry.timestamp = [DateTimeOffset]::UtcNow.AddSeconds(10).ToString('o') }
    $editorLines = @($editorEntries | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 10 -Compress })
    $editorLines += @('{"type":"response_item","payload":{"type":"reasoning"}}') * 405
    [System.IO.File]::WriteAllLines($transcript, $editorLines, [System.Text.UTF8Encoding]::new($false))
    $editEvent = ConvertTo-Json -Compress @{session_id='test-session';turn_id='edit-turn';hook_event_name='Stop';transcript_path=$transcript;cwd='C:\project'}
    $editEvent | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -SyncDirectory $testRoot
    $rawJobs = @(Get-ChildItem (Join-Path $testRoot 'queue') -Filter '*.json' | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) })
    $editJob = $rawJobs | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object turn_id -eq 'edit-turn'
    if (!$editJob -or $editJob.messages.Count -ne 1 -or $editJob.messages[0].text -ne '隐藏项目路径') { throw 'Hook missed or mixed up the long turn user request' }
    if ($editJob.code_change.index -ne 8 -or $editJob.code_change.files.Count -ne 2 -or
        '项目.tsx' -notin $editJob.code_change.files -or 'style.css' -notin $editJob.code_change.files) { throw 'Hook must capture only successful current-turn code file changes' }
    if (($rawJobs -join '') -match 'PRIVATE PATCH|NOT INCLUDED') { throw 'Hook leaked a patch or tool parameters into the queue' }
    Write-Output 'PASS: code change evidence, long turns, old and failed changes, diff exclusion, unicode, and existing hook behavior'
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedTestRoot -Leaf).StartsWith('sticky-notes-hook-')) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
