# Smoke test of the Windows app, run by the release workflow (.github/workflows/release.yml) on a
# Windows runner, and the same by hand on Windows (Windows PowerShell 5.1 or PowerShell 7):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke-windows.ps1 `
#     -Exe dist\lyren-plan-0.1.0-win-x64.exe -WorkDir "$env:TEMP\lyren-smoke-1" -Port 43871
#
#  1. The exe matches its .sha256 file (next to it, as scripts/package.mjs writes it).
#  2. `<exe> help` ends with exit code 0 and prints "Lyren Plan <version> - desktop app".
#  3. `<exe> --no-browser --data-dir <WorkDir>\data --port <Port>` starts, with standard input,
#     output and error redirected to files in WorkDir, so it runs in plain console mode (no icon,
#     no message boxes, no log file; SPEC 12.1 Modes). /api/health answers with that version, and
#     / serves the web app.
#  4. `<exe> stop --data-dir <WorkDir>\data` ends with exit code 0, the server process then exits
#     with 0, and the port no longer answers.
#  5. The upgrade check (docs/design/multi-user-and-cloudflare.md §9.9; scripts/ci/smoke-node.sh does
#     the same on Linux): the previous release's exe sets up an account (by username, as 1.x does), a
#     project and a task in <WorkDir>\upgrade-data and is stopped; <exe> must upgrade that 1.x
#     database at its first start (the upgrade line in its output, spaces\<id>.db, the before-upgrade
#     snapshot, a sign-in with the old username and password, the project and the task in the space),
#     and the previous exe must then refuse the upgraded data without changing it. The previous exe is
#     -PreviousExe, else the variable SMOKE_PREVIOUS_RELEASE, else lyren-plan-<v>-win-x64.exe of the
#     newest published release other than this version that has one (or SMOKE_PREVIOUS_TAG), downloaded
#     with `gh release download` (GH_TOKEN, GH_REPO); without one, or without gh or a token, the check is
#     skipped with a notice. A .sha256 file next to it is checked. With -CrashPrevious the previous exe
#     is ended with Stop-Process -Force instead of `stop`, so that the upgrade starts from the -wal and
#     -shm files a crash leaves (design §3.8: the exclusive lock on such a file).
# On a failure it prints the server's output and exits with 1. The server never stays running.
#
# It never touches a real Lyren Plan: -WorkDir must be a new or empty folder (the app creates its
# data folder in it, and everything is left there for inspection), -Port must be given, free, and
# not one of the app's own ports (43770-43779), any other argument is refused (exit code 2, as for
# a missing one), and the app's environment variables (DB_PATH, HOST, ...) are removed for the
# programs it starts.

param(
  [string] $Exe = '',
  [string] $WorkDir = '',
  [int] $Port = 0,
  [string] $PreviousExe = '',
  [switch] $CrashPrevious
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # no progress bar for each web request (slow in Windows PowerShell 5.1)
Set-StrictMode -Version 2.0

# A script without [CmdletBinding()] keeps what it can't bind in $args, e.g. the rest of an unquoted
# path with a space (cmd: -WorkDir %TEMP%\x with TEMP=C:\Users\A B\...), which would leave -WorkDir
# cut short. Refuse instead.
if ($args.Count -gt 0) {
  Write-Host "Unexpected arguments: $($args -join ' ')"
  Write-Host 'The options are -Exe, -WorkDir, -Port, -PreviousExe and -CrashPrevious; put a path that contains spaces in double quotes.'
  exit 2
}
if ($Exe -eq '' -or $WorkDir -eq '' -or $Port -eq 0) {
  Write-Host 'Usage: smoke-windows.ps1 -Exe <lyren-plan-<version>-win-x64.exe> -WorkDir <new or empty folder> -Port <free port>'
  Write-Host 'All three are required, so that the test can never use the data folder or the port of a real Lyren Plan.'
  exit 2
}
if ($Port -lt 1024 -or $Port -gt 65535) {
  Write-Host "-Port must be between 1024 and 65535 (got $Port)."
  exit 2
}
if ($Port -ge 43770 -and $Port -le 43779) {
  Write-Host "-Port $Port is one of the app's own ports (43770-43779), where a real Lyren Plan may run. Choose another."
  exit 2
}

# The variables the app reads (README "Configuration"; LYREN_* are its internal and test hooks), and the
# token for gh, which only gh gets.
$AppVariables = @('PORT', 'HOST', 'DATA_DIR', 'DB_PATH', 'WEB_DIR', 'OPEN_BROWSER', 'TRUST_PROXY', 'COOKIE_SECURE',
  'SESSION_TTL_DAYS', 'SETUP_TOKEN', 'BODY_LIMIT', 'IMPORT_BODY_LIMIT', 'SNAPSHOT_KEEP', 'LOG_REQUESTS', 'PUBLIC_URL',
  'SIGNUP_POLICY', 'MAIL_TRANSPORT', 'GH_TOKEN')

function Resolve-FullPath([string] $Path) {
  return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).ProviderPath, $Path))
}

# One command line by the rules of the C runtime (CommandLineToArgvW), which the exe parses it with.
function Join-CommandLine([string[]] $Arguments) {
  $quoted = foreach ($a in $Arguments) {
    if ($a -match '^[^\s"]+$') { $a }
    else { '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
  }
  return $quoted -join ' '
}

function Test-PortOpen([int] $P) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    return ($client.ConnectAsync('127.0.0.1', $P).Wait(1000) -and $client.Connected)
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-TaskText($Task) {
  if ($Task.Wait(5000)) { return $Task.Result }
  return '(output incomplete)'
}

# Runs the exe (or the one at <Path>) with all standard handles redirected and returns its exit code
# and output.
function Invoke-Exe([string[]] $Arguments, [int] $TimeoutSeconds, [string] $Path = $script:ExePath) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Path
  $psi.Arguments = Join-CommandLine $Arguments
  $psi.WorkingDirectory = $script:Work
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $p = [System.Diagnostics.Process]::Start($psi)
  try {
    $p.StandardInput.Close()
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
      throw "$($Arguments -join ' ') did not end within $TimeoutSeconds s"
    }
    $p.WaitForExit()
    $output = ((Get-TaskText $stdout) + (Get-TaskText $stderr)).Trim()
    return New-Object PSObject -Property @{ ExitCode = $p.ExitCode; Output = $output }
  } finally {
    if (-not $p.HasExited) {
      try { $p.Kill() } catch { } # it may have ended in the meantime
      $null = $p.WaitForExit(5000)
    }
    $p.Dispose()
  }
}

# Starts the exe with these arguments, its standard handles redirected to files (console mode), and
# returns the process; the files are the ones the failure report prints.
function Start-Exe([string] $Path, [string[]] $Arguments, [string] $Name) {
  $script:StdoutFile = [System.IO.Path]::Combine($script:Work, "$Name-stdout.txt")
  $script:StderrFile = [System.IO.Path]::Combine($script:Work, "$Name-stderr.txt")
  $process = Start-Process -FilePath $Path -ArgumentList (Join-CommandLine $Arguments) -WorkingDirectory $script:Work -NoNewWindow -PassThru `
    -RedirectStandardInput $stdinFile -RedirectStandardOutput $script:StdoutFile -RedirectStandardError $script:StderrFile
  $null = $process.Handle # Windows PowerShell 5.1 knows the exit code only when the handle was taken while the process ran
  Write-Host "Process $($process.Id)"
  return $process
}

# Waits until <Base>/api/health answers (at most 60 s) and returns the answer.
function Wait-Health($Process) {
  $deadline = (Get-Date).AddSeconds(60)
  $lastError = 'no answer'
  while ($true) {
    if ($Process.HasExited) { throw "The server ended (exit code $($Process.ExitCode)) before $base/api/health answered" }
    if ((Get-Date) -gt $deadline) { throw "$base/api/health did not answer within 60 s (last: $lastError)" }
    try {
      return Get-Page "$base/api/health" 5
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  }
}

# `<Path> stop --data-dir <Data>` must end with exit code 0, then the server with 0, and the port close.
# -EndIfNoStop: a previous release without the stop command is ended instead.
function Stop-Exe([string] $Path, [string] $Data, $Process, [switch] $EndIfNoStop) {
  $stop = Invoke-Exe @('stop', '--data-dir', $Data) 60 $Path
  if ($stop.ExitCode -ne 0 -and $EndIfNoStop -and $stop.Output.Contains('Unknown command: stop')) {
    Write-Host 'This release has no stop command: ending its process.'
    Stop-Process -Id $Process.Id -Force
    $null = $Process.WaitForExit(30000)
    return
  }
  if ($stop.ExitCode -ne 0) { throw "stop ended with exit code $($stop.ExitCode):`n$($stop.Output)" }
  Write-Host $stop.Output
  if (-not $Process.WaitForExit(30000)) { throw "The server still runs 30 s after stop ended" }
  $Process.WaitForExit()
  if ($Process.ExitCode -ne 0) { throw "The server ended with exit code $($Process.ExitCode), expected 0" }
  if (Test-PortOpen $Port) { throw "Port $Port still answers after the server ended" }
}

# A client for the API that keeps cookies and sends the CSRF header (System.Net.Http, the same in
# Windows PowerShell 5.1 and 7, and never throwing for an HTTP status).
function New-ApiClient {
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.CookieContainer = New-Object System.Net.CookieContainer
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(15)
  $client.DefaultRequestHeaders.Add('X-Lyren-Request', '1')
  return $client
}

# <Method> <base><Path> with an optional JSON body: the status code and the body as text.
function Invoke-Api($Client, [string] $Method, [string] $Path, $Body = $null) {
  $request = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), "$base$Path")
  if ($null -ne $Body) {
    $request.Content = New-Object System.Net.Http.StringContent(($Body | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8, 'application/json')
  }
  $response = $Client.SendAsync($request).GetAwaiter().GetResult()
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  return New-Object PSObject -Property @{ Status = [int]$response.StatusCode; Text = $text }
}

# Invoke-Api that must answer 2xx; returns the body as text.
function Invoke-ApiOk($Client, [string] $Method, [string] $Path, $Body = $null) {
  $res = Invoke-Api $Client $Method $Path $Body
  if ($res.Status -lt 200 -or $res.Status -gt 299) { throw "$Method $Path answered $($res.Status): $($res.Text)" }
  return $res.Text
}

# A file's SHA-256, lower case.
function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# The exe against the .sha256 file next to it ('<sha256>  <file name>', as scripts/package.mjs writes it).
function Test-Sha256File([string] $Path, [bool] $Required) {
  $name = [System.IO.Path]::GetFileName($Path)
  $shaFile = "$Path.sha256"
  if (-not (Test-Path -LiteralPath $shaFile -PathType Leaf)) {
    if ($Required) { throw "There is no $name.sha256 next to the exe" }
    return
  }
  $line = [string](Get-Content -LiteralPath $shaFile -TotalCount 1)
  if ($line -match '^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$') { $expected = $Matches[1].ToLowerInvariant(); $named = $Matches[2] }
  else { throw "$name.sha256 does not hold '<sha256>  <file name>'" }
  if ($named -ne $name) { throw "$name.sha256 is for $named" }
  $actual = Get-Sha256 $Path
  if ($actual -ne $expected) { throw "SHA-256 mismatch: $name.sha256 says $expected, the file has $actual" }
  Write-Host "OK $name $actual"
}

# GET <Url>: the status code and the body as text (the same in Windows PowerShell 5.1 and 7).
function Get-Page([string] $Url, [int] $TimeoutSeconds) {
  $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds
  $body = $res.Content
  if ($body -is [byte[]]) { $body = [System.Text.Encoding]::UTF8.GetString($body) }
  return New-Object PSObject -Property @{ StatusCode = [int]$res.StatusCode; Text = [string]$body }
}

# A file of the server's output, also while some process still has it open for writing (a child of
# the server that outlived it): ReadAllText would fail there with a sharing violation. Never throws,
# so that the rest of the failure report and `exit 1` always run.
function Read-Text([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '(no file)' }
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]'ReadWrite, Delete')
    return (New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)).ReadToEnd()
  } catch {
    return "(could not read it: $($_.Exception.Message))"
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

$script:ExePath = Resolve-FullPath $Exe
$script:Work = Resolve-FullPath $WorkDir
$data = [System.IO.Path]::Combine($script:Work, 'data')
$upgradeData = [System.IO.Path]::Combine($script:Work, 'upgrade-data')
$stdinFile = [System.IO.Path]::Combine($script:Work, 'serve-stdin.txt')
$script:StdoutFile = [System.IO.Path]::Combine($script:Work, 'serve-stdout.txt')
$script:StderrFile = [System.IO.Path]::Combine($script:Work, 'serve-stderr.txt')
$base = "http://127.0.0.1:$Port"
$server = $null
$upgradeChecked = $false
$failure = $null
$saved = @{}

try {
  # Checks that use nothing but the arguments come first: until they pass, nothing is started.
  if (Test-Path -LiteralPath $script:Work) {
    if (-not (Test-Path -LiteralPath $script:Work -PathType Container)) { throw "-WorkDir $($script:Work) is a file" }
    if (@(Get-ChildItem -LiteralPath $script:Work -Force).Count -gt 0) {
      throw "-WorkDir $($script:Work) is not empty. Give a new or empty folder (the test leaves its files there)."
    }
  }
  if (Test-PortOpen $Port) { throw "Something already answers on 127.0.0.1:$Port. Choose another -Port." }
  if (-not (Test-Path -LiteralPath $script:ExePath -PathType Leaf)) { throw "-Exe $($script:ExePath) does not exist" }
  $exeName = [System.IO.Path]::GetFileName($script:ExePath)
  if ($PreviousExe -eq '' -and $env:SMOKE_PREVIOUS_RELEASE) { $PreviousExe = $env:SMOKE_PREVIOUS_RELEASE }
  if ($PreviousExe -ne '') {
    $PreviousExe = Resolve-FullPath $PreviousExe
    if (-not (Test-Path -LiteralPath $PreviousExe -PathType Leaf)) { throw "The previous release's exe $PreviousExe does not exist" }
  }

  Write-Host "== SHA-256 of $exeName"
  Test-Sha256File $script:ExePath $true

  $null = [System.IO.Directory]::CreateDirectory($script:Work)
  [System.IO.File]::WriteAllText($stdinFile, '')
  foreach ($name in $AppVariables + @(Get-ChildItem Env: | Where-Object { $_.Name -like 'LYREN_*' } | ForEach-Object { $_.Name })) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) {
      $saved[$name] = $value
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
  }
  if ($saved.Count -gt 0) { Write-Host "Not passed on to the app: $(@($saved.Keys) -join ', ')" }

  Write-Host "== $exeName help"
  $help = Invoke-Exe @('help') 60
  if ($help.ExitCode -ne 0) { throw "help ended with exit code $($help.ExitCode):`n$($help.Output)" }
  if ($help.Output -match 'Lyren Plan (\S+) - desktop app') { $version = $Matches[1] }
  else { throw "help did not print 'Lyren Plan <version> - desktop app':`n$($help.Output)" }
  if ($exeName -match '^lyren-plan-(.+)-win-x64\.exe$' -and $Matches[1] -ne $version) {
    throw "The file name says version $($Matches[1]), help says $version"
  }
  Write-Host "OK (exit code 0, Lyren Plan $version)"

  Write-Host "== Start the server on port $Port with the data folder $data"
  $server = Start-Exe $script:ExePath @('--no-browser', '--data-dir', $data, '--port', "$Port") 'serve'
  $health = Wait-Health $server
  # {"ok":true,"version":"<version>"} (server/src/gateway/app.ts)
  $versionJson = '"version":"' + $version + '"'
  if ($health.StatusCode -ne 200 -or -not $health.Text.Contains('"ok":true') -or -not $health.Text.Contains($versionJson)) {
    throw "/api/health answered $($health.StatusCode) $($health.Text), expected ok true and version $version"
  }
  Write-Host "OK /api/health $($health.Text)"
  $page = Get-Page "$base/" 10
  if ($page.StatusCode -ne 200 -or -not $page.Text.Contains('<div id="root">')) {
    throw "/ answered $($page.StatusCode) without the web app's page"
  }
  Write-Host 'OK / serves the web app'

  Write-Host "== $exeName stop --data-dir $data"
  Stop-Exe $script:ExePath $data $server
  Write-Host "OK (stop and the server ended with exit code 0, port $Port is closed)"

  Write-Host '== Upgrade check'
  if ($PreviousExe -eq '') {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $gh -or -not $saved.ContainsKey('GH_TOKEN')) {
      Write-Host '::notice::Upgrade check skipped: no previous release (-PreviousExe and SMOKE_PREVIOUS_RELEASE are unset, and gh or GH_TOKEN is missing)'
    } else {
      $tag = $env:SMOKE_PREVIOUS_TAG
      [Environment]::SetEnvironmentVariable('GH_TOKEN', $saved['GH_TOKEN'], 'Process')
      if (-not $tag) {
        # The JSON is filtered here: Windows PowerShell 5.1 would mangle the quotes of a --jq filter.
        $listed = & $gh.Path release list --exclude-drafts --exclude-pre-releases --limit 50 --json tagName
        if ($LASTEXITCODE -ne 0) { [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process'); throw "gh release list ended with exit code $LASTEXITCODE" }
        # The newest one that has the Windows app (the earliest releases may have none).
        foreach ($release in (ConvertFrom-Json -InputObject ($listed -join "`n"))) {
          if ($release.tagName -eq "v$version") { continue }
          $viewed = & $gh.Path release view $release.tagName --json assets
          if ($LASTEXITCODE -ne 0) { [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process'); throw "gh release view $($release.tagName) ended with exit code $LASTEXITCODE" }
          $assets = @((ConvertFrom-Json -InputObject ($viewed -join "`n")).assets)
          if (@($assets | Where-Object { $_.name -like 'lyren-plan-*-win-x64.exe' }).Count -gt 0) { $tag = $release.tagName; break }
        }
      }
      if (-not $tag) {
        Write-Host "::notice::Upgrade check skipped: no published release before v$version has a lyren-plan-<version>-win-x64.exe"
      } else {
        $previousDir = [System.IO.Path]::Combine($script:Work, 'previous')
        $null = [System.IO.Directory]::CreateDirectory($previousDir)
        & $gh.Path release download $tag --dir $previousDir --pattern 'lyren-plan-*-win-x64.exe' --pattern 'lyren-plan-*-win-x64.exe.sha256'
        $downloaded = $LASTEXITCODE
        [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process')
        if ($downloaded -ne 0) { throw "gh release download $tag ended with exit code $downloaded" }
        $found = @(Get-ChildItem -LiteralPath $previousDir -Filter 'lyren-plan-*-win-x64.exe' | Where-Object { $_.Name -like '*.exe' })
        if ($found.Count -eq 0) { throw "The release $tag has no lyren-plan-<version>-win-x64.exe" }
        $PreviousExe = $found[0].FullName
        Write-Host "OK downloaded $($found[0].Name) of the release $tag"
      }
      [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process')
    }
  }
  if ($PreviousExe -ne '') {
    Test-Sha256File $PreviousExe $false
    $previousHelp = Invoke-Exe @('help') 60 $PreviousExe
    if ($previousHelp.ExitCode -ne 0 -or -not ($previousHelp.Output -match 'Lyren Plan (\S+) - desktop app')) {
      throw "help of the previous release ended with exit code $($previousHelp.ExitCode):`n$($previousHelp.Output)"
    }
    $previousVersion = "Lyren Plan $($Matches[1])"
    Write-Host "Upgrade check from $previousVersion ($([System.IO.Path]::GetFileName($PreviousExe)))"
    $user = 'smoke-owner'
    $password = 'smoke password 1'
    Add-Type -AssemblyName System.Net.Http

    [Environment]::SetEnvironmentVariable('SETUP_TOKEN', 'smoke-setup-code', 'Process')
    try {
      $server = Start-Exe $PreviousExe @('--no-browser', '--data-dir', $upgradeData, '--port', "$Port") 'previous'
    } finally {
      [Environment]::SetEnvironmentVariable('SETUP_TOKEN', $null, 'Process')
    }
    $null = Wait-Health $server
    $client = New-ApiClient
    $setup = Invoke-Api $client 'POST' '/api/auth/setup' @{ username = $user; displayName = 'Smoke Owner'; password = $password; setupCode = 'smoke-setup-code'; createSampleData = $false }
    if ($setup.Status -eq 400 -and $setup.Text.Contains('email')) {
      Stop-Exe $PreviousExe $upgradeData $server -EndIfNoStop
      Write-Host "::notice::Upgrade check skipped: $previousVersion is already a release with spaces (its setup asks for an email address), so there is no 1.x database to upgrade"
    } else {
      if ($setup.Status -ne 201) { throw "POST /api/auth/setup of $previousVersion answered $($setup.Status): $($setup.Text)" }
      $project = Invoke-ApiOk $client 'POST' '/api/projects' @{ name = 'Upgrade check'; key = 'UPG' } | ConvertFrom-Json
      $null = Invoke-ApiOk $client 'POST' '/api/tasks' @{ projectId = $project.id; title = 'Carried over' }
      if ($CrashPrevious) {
        # As a crash or a power loss would: the 1.x database keeps its -wal and -shm, the task in the -wal.
        Stop-Process -Id $server.Id -Force
        if (-not $server.WaitForExit(30000)) { throw "$previousVersion still runs 30 s after Stop-Process" }
        if (-not (Test-Path -LiteralPath ([System.IO.Path]::Combine($upgradeData, 'lyren.db-wal')) -PathType Leaf)) {
          throw "$previousVersion left no lyren.db-wal after Stop-Process -Force"
        }
        Write-Host "OK $previousVersion ended with Stop-Process -Force: lyren.db-wal is left"
      } else {
        Stop-Exe $PreviousExe $upgradeData $server -EndIfNoStop
      }
      if (-not (Test-Path -LiteralPath ([System.IO.Path]::Combine($upgradeData, 'lyren.db')) -PathType Leaf) -or
          (Test-Path -LiteralPath ([System.IO.Path]::Combine($upgradeData, 'spaces')))) {
        throw "$previousVersion did not leave a 1.x database (lyren.db alone) in $upgradeData"
      }
      Write-Host "OK ${previousVersion}: an account ($user), the project UPG and the task UPG-1 in a 1.x database"

      $server = Start-Exe $script:ExePath @('--no-browser', '--data-dir', $upgradeData, '--port', "$Port") 'upgrade'
      $null = Wait-Health $server
      $output = Read-Text $script:StdoutFile
      $upgraded = 'Upgraded the database for multi-user spaces: your data is now in the space "Smoke Owner''s space" \(spaces\\([0-9a-z]{16})\.db\)\. The old database was saved as backups\\lyren-v1-before-upgrade-[0-9TZ-]+\.db\.'
      if (-not ($output -match $upgraded)) { throw "The output shows no upgrade line:`n$output" }
      $space = $Matches[1]
      $line = $Matches[0]
      $spaceFile = [System.IO.Path]::Combine($upgradeData, 'spaces', "$space.db")
      if (-not (Test-Path -LiteralPath $spaceFile -PathType Leaf)) { throw "No $spaceFile" }
      if (@(Get-ChildItem -LiteralPath ([System.IO.Path]::Combine($upgradeData, 'backups')) -Filter 'lyren-v1-before-upgrade-*.db').Count -eq 0) {
        throw "No before-upgrade snapshot in $upgradeData\backups"
      }
      Write-Host "OK upgrade: $line"
      $client = New-ApiClient
      $null = Invoke-ApiOk $client 'POST' '/api/auth/login' @{ identifier = $user; password = $password }
      $projects = Invoke-ApiOk $client 'GET' "/api/s/$space/projects"
      if (-not $projects.Contains('"key":"UPG"')) { throw "The space has no project UPG: $projects" }
      $task = Invoke-ApiOk $client 'GET' "/api/s/$space/tasks/ref/UPG-1"
      if (-not $task.Contains('"title":"Carried over"')) { throw "UPG-1 is not the task of ${previousVersion}: $task" }
      Stop-Exe $script:ExePath $upgradeData $server
      Write-Host 'OK sign-in with the old username and password; the project UPG and the task UPG-1 are in the space'

      $directoryFile = [System.IO.Path]::Combine($upgradeData, 'lyren.db')
      $before = "$(Get-Sha256 $directoryFile) $(Get-Sha256 $spaceFile)"
      $refused = Invoke-Exe @('--no-browser', '--data-dir', $upgradeData, '--port', "$Port") 60 $PreviousExe
      if ($refused.ExitCode -eq 0) { throw "$previousVersion did not refuse the upgraded data (exit code 0):`n$($refused.Output)" }
      if (-not $refused.Output.Contains('is newer than this build supports')) {
        throw "$previousVersion refused the upgraded data with another message (exit code $($refused.ExitCode)):`n$($refused.Output)"
      }
      if (Test-PortOpen $Port) { throw "Port $Port answers after $previousVersion refused the data" }
      if ("$(Get-Sha256 $directoryFile) $(Get-Sha256 $spaceFile)" -ne $before) { throw "$previousVersion changed the upgraded data" }
      Write-Host "OK $previousVersion refuses the upgraded data (exit code $($refused.ExitCode), files unchanged)"
      $upgradeChecked = $true
    }
  }
} catch {
  $failure = $_
} finally {
  if ($null -ne $server -and -not $server.HasExited) {
    Write-Host "Ending the server (process $($server.Id))"
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    $null = $server.WaitForExit(10000)
  }
  foreach ($name in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}

if ($null -ne $failure) {
  $message = $failure.Exception.Message
  if ($env:GITHUB_ACTIONS -eq 'true') {
    # The whole message as one annotation: for help and stop the cause is on the lines after the
    # first. Workflow commands take % CR LF escaped (%0A shows as a line break).
    $annotation = $message.Trim()
    if ($annotation.Length -gt 2000) { $annotation = $annotation.Substring(0, 2000) + ' ...' }
    $annotation = $annotation.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::error::Windows smoke test failed: $annotation"
  }
  Write-Host ''
  Write-Host "FAILED: $message"
  if ($null -ne $server) {
    Write-Host ''
    Write-Host "---- server standard output ($($script:StdoutFile))"
    Write-Host (Read-Text $script:StdoutFile)
    Write-Host "---- server standard error ($($script:StderrFile))"
    Write-Host (Read-Text $script:StderrFile)
    Write-Host '----'
  }
  exit 1
}
Write-Host ''
if ($upgradeChecked) { Write-Host "Smoke test passed, with the upgrade from $previousVersion. Its files are in $($script:Work)." }
else { Write-Host "Smoke test passed (without the upgrade check). Its files are in $($script:Work)." }
exit 0
