param([Parameter(Mandatory=$true)][string]$SyncDirectory)
# Codex Stop hook: enqueue user text and successful file-change metadata without diffs.
$ErrorActionPreference = 'Stop'
try {
    $enabledPath = Join-Path $SyncDirectory 'enabled'
    if (-not (Test-Path -LiteralPath $enabledPath)) { exit 0 }
    $enabledAt = (Get-Item -LiteralPath $enabledPath).LastWriteTimeUtc
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    $eventData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($eventData.hook_event_name -ne 'Stop' -or $eventData.stop_hook_active) { exit 0 }
    if (-not $eventData.session_id -or -not $eventData.turn_id -or -not $eventData.transcript_path) { exit 0 }
    $messages = [System.Collections.Generic.Queue[object]]::new()
    $files = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $changeIndex = 0
    $currentTurn = ''
    $lineNumber = 0
    $projectDirectory = [string]$eventData.cwd
    $stream = [System.IO.File]::Open($eventData.transcript_path, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    try {
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            $lineNumber++
            if ($currentTurn -and $currentTurn -ne $eventData.turn_id -and
                $line -notmatch '"type"\s*:\s*"(task_started|turn_started)"') { continue }
            if ($line -notmatch '"type"\s*:\s*"(session_meta|task_started|turn_started|FileChange|message)"') { continue }
            try { $entry = $line | ConvertFrom-Json } catch { continue }
            $payload = $entry.payload
            if ($entry.type -eq 'session_meta' -and !$projectDirectory -and $payload.cwd) {
                $projectDirectory = [string]$payload.cwd
            }
            if ($entry.type -eq 'event_msg' -and $payload.type -in @('task_started', 'turn_started') -and $payload.turn_id) {
                if ($currentTurn -ne $payload.turn_id -and $payload.turn_id -eq $eventData.turn_id) { $messages.Clear() }
                $currentTurn = $payload.turn_id
                continue
            }
            if ($currentTurn -and $currentTurn -ne $eventData.turn_id) { continue }
            if (!$entry.timestamp) { continue }
            try { $entryTime = [DateTimeOffset]::Parse($entry.timestamp).UtcDateTime } catch { continue }
            if ($entryTime -lt $enabledAt) { continue }
            if ($entry.type -eq 'event_msg' -and $payload.type -eq 'item_completed' -and $payload.turn_id -eq $eventData.turn_id -and
                $payload.item.type -eq 'FileChange' -and $payload.item.status -eq 'completed' -and $payload.item.changes) {
                foreach ($change in $payload.item.changes.PSObject.Properties) {
                    $name = ($change.Name -split '[/\\]')[-1]
                    if ($name -notmatch '^(Dockerfile|Makefile|CMakeLists\.txt|\.[a-z]*rc)$' -and
                        $name -notmatch '\.(ada|astro|bash|bat|c|cc|clj|cmake|cmd|coffee|cpp|cs|css|cxx|dart|exs?|fsx?|go|gradle|graphql|h|hpp|html|java|js|jsonc?|jsx|kt|kts|less|lua|mjs|cjs|m|mm|php|pl|proto|ps1|psm1|py|rb|rs|sass|scala|scss|sh|sln|sql|svelte|swift|toml|tsx?|ttml|ttss|vb|vue|wxml|wxss|xhsml|xml|xsd|ya?ml|zig)$') { continue }
                    if ($name.Length -gt 255 -or $name -match '[\x00-\x1f]') { continue }
                    $changeIndex = $lineNumber
                    if ($files.Count -lt 20) { [void]$files.Add($name) }
                }
                continue
            }
            if ($entry.type -ne 'response_item' -or $payload.type -ne 'message' -or $payload.role -ne 'user') { continue }
            $parts = @($payload.content | Where-Object {
                $_.type -eq 'input_text' -and $_.text -and $_.text -notmatch '^<(environment_context|permissions instructions)>'
            } | ForEach-Object { $_.text })
            $text = $parts -join "`n"
            $requestMarker = '## My request:'
            $requestAt = $text.IndexOf($requestMarker, [StringComparison]::Ordinal)
            if ($requestAt -ge 0) { $text = $text.Substring($requestAt + $requestMarker.Length).TrimStart() }
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            $messages.Enqueue(@{ index = $lineNumber; role = 'user'; text = $text.Substring(0, [Math]::Min($text.Length, 3000)) })
            if ($messages.Count -gt 4) { [void]$messages.Dequeue() }
        }
    } finally { $reader.Dispose() }
    if ($messages.Count -eq 0 -and $changeIndex -eq 0) { exit 0 }
    $job = @{ session_id = [string]$eventData.session_id; turn_id = [string]$eventData.turn_id; cwd = $projectDirectory; messages = $messages.ToArray(); explicit_only = $true }
    if ($changeIndex -gt 0) { $job.code_change = @{ index = $changeIndex; files = @($files | Sort-Object) } }
    $json = ConvertTo-Json -InputObject $job -Depth 8 -Compress
    if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt 98304) { throw '对话过长，请缩短后手动同步。' }
    $queue = Join-Path $SyncDirectory 'queue'
    [System.IO.Directory]::CreateDirectory($queue) | Out-Null
    $name = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfffffff') + '-' + [Guid]::NewGuid().ToString('N')
    $temp = Join-Path $queue ($name + '.tmp')
    [System.IO.File]::WriteAllText($temp, $json, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($temp, (Join-Path $queue ($name + '.json')))
} catch {
    try {
        [System.IO.File]::WriteAllText((Join-Path $SyncDirectory 'last-error'),
            ('对话采集失败：' + $_.Exception.Message), [System.Text.UTF8Encoding]::new($false))
    } catch { }
    # No transcript or credentials in hook output. Failure never blocks the conversation.
    [Console]::Error.WriteLine('桌面便签未能收集本轮对话；请检查同步设置和日志。')
}
exit 0
