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
  [int] $Port = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # no progress bar for each web request (slow in Windows PowerShell 5.1)
Set-StrictMode -Version 2.0

# A script without [CmdletBinding()] keeps what it can't bind in $args, e.g. the rest of an unquoted
# path with a space (cmd: -WorkDir %TEMP%\x with TEMP=C:\Users\A B\...), which would leave -WorkDir
# cut short. Refuse instead.
if ($args.Count -gt 0) {
  Write-Host "Unexpected arguments: $($args -join ' ')"
  Write-Host 'The options are -Exe, -WorkDir and -Port; put a path that contains spaces in double quotes.'
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

# The variables the app reads (README "Configuration"; LYREN_* are its internal and test hooks).
$AppVariables = @('PORT', 'HOST', 'DATA_DIR', 'DB_PATH', 'WEB_DIR', 'OPEN_BROWSER', 'TRUST_PROXY', 'COOKIE_SECURE',
  'SESSION_TTL_DAYS', 'SETUP_TOKEN', 'BODY_LIMIT', 'IMPORT_BODY_LIMIT', 'SNAPSHOT_KEEP', 'LOG_REQUESTS')

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

# Runs the exe with all standard handles redirected and returns its exit code and output.
function Invoke-Exe([string[]] $Arguments, [int] $TimeoutSeconds) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:ExePath
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
$stdinFile = [System.IO.Path]::Combine($script:Work, 'serve-stdin.txt')
$stdoutFile = [System.IO.Path]::Combine($script:Work, 'serve-stdout.txt')
$stderrFile = [System.IO.Path]::Combine($script:Work, 'serve-stderr.txt')
$server = $null
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

  Write-Host "== SHA-256 of $exeName"
  $shaFile = "$($script:ExePath).sha256"
  if (-not (Test-Path -LiteralPath $shaFile -PathType Leaf)) { throw "There is no $exeName.sha256 next to the exe" }
  $line = [string](Get-Content -LiteralPath $shaFile -TotalCount 1)
  if ($line -match '^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$') { $expected = $Matches[1]; $named = $Matches[2] }
  else { throw "$exeName.sha256 does not hold '<sha256>  <file name>'" }
  if ($named -ne $exeName) { throw "$exeName.sha256 is for $named" }
  $actual = (Get-FileHash -LiteralPath $script:ExePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA-256 mismatch: $exeName.sha256 says $expected, the file has $actual" }
  Write-Host "OK $actual"

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
  $serveArgs = Join-CommandLine @('--no-browser', '--data-dir', $data, '--port', "$Port")
  $server = Start-Process -FilePath $script:ExePath -ArgumentList $serveArgs -WorkingDirectory $script:Work -NoNewWindow -PassThru `
    -RedirectStandardInput $stdinFile -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  $null = $server.Handle # Windows PowerShell 5.1 knows the exit code only when the handle was taken while the process ran
  Write-Host "Process $($server.Id)"

  $base = "http://127.0.0.1:$Port"
  $deadline = (Get-Date).AddSeconds(60)
  $health = $null
  $lastError = 'no answer'
  while ($null -eq $health) {
    if ($server.HasExited) { throw "The server ended (exit code $($server.ExitCode)) before $base/api/health answered" }
    if ((Get-Date) -gt $deadline) { throw "$base/api/health did not answer within 60 s (last: $lastError)" }
    try {
      $health = Get-Page "$base/api/health" 5
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  }
  # {"ok":true,"version":"<version>"} (server/src/app.ts)
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
  $stop = Invoke-Exe @('stop', '--data-dir', $data) 60
  if ($stop.ExitCode -ne 0) { throw "stop ended with exit code $($stop.ExitCode):`n$($stop.Output)" }
  Write-Host $stop.Output
  if (-not $server.WaitForExit(30000)) { throw "The server still runs 30 s after stop ended" }
  $server.WaitForExit()
  if ($server.ExitCode -ne 0) { throw "The server ended with exit code $($server.ExitCode), expected 0" }
  if (Test-PortOpen $Port) { throw "Port $Port still answers after the server ended" }
  Write-Host "OK (stop and the server ended with exit code 0, port $Port is closed)"
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
    Write-Host "---- server standard output ($stdoutFile)"
    Write-Host (Read-Text $stdoutFile)
    Write-Host "---- server standard error ($stderrFile)"
    Write-Host (Read-Text $stderrFile)
    Write-Host '----'
  }
  exit 1
}
Write-Host ''
Write-Host "Smoke test passed. Its files are in $($script:Work)."
exit 0
