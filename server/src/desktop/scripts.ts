// The Windows PowerShell 5.1 scripts of the desktop app, embedded as readable text and sent to
// powershell.exe over stdin (powershell.ts). They take every value as JSON from stdin, never as code,
// and write no files. (Template literals: no backtick and no dollar-brace in them.)
//
// PowerShell logs every script that contains certain words (Add-Type, MemoryStream and others it
// finds suspicious) as a Warning in its event log (event 4104), which security tools watch. These
// scripts avoid them: the WinForms and Drawing assemblies are loaded by their full names (what
// Add-Type -AssemblyName does), and the icon is read from its bytes by System.Drawing's own
// IconConverter. (SUSPICIOUS_WORDS in the tests keeps it so.)

/**
 * The notification-area icon (tray.ts). Protocol, one JSON object per line, UTF-8:
 *   app -> helper: init {parentPid, tooltip, icon (base64 .ico, or null for a stock icon),
 *                  menu [{id, text, default?} | {separator: true}], testHooks},
 *                  tooltip {text}, copy {text}, ping {id}, exit,
 *                  test {op} (only with testHooks: click:<id>, describe)
 *   helper -> app: hello {languageMode, ps, pid}, ready {iconSize, dpi}, action {id, via: menu|left-click},
 *                  session-ending {reason}, copied, pong {id}, described {menu, tooltip},
 *                  error {message}, bye {reason: exit|stdin-eof|parent-exit|session-ended|error}
 * It removes the icon and exits when told to, when stdin closes (the app has ended), when the app's
 * process is gone (checked every 500 ms), and when Windows ends the session; the icon is removed
 * on every way out (finally).
 */
export const TRAY_SCRIPT = String.raw`
# Lyren Plan: the icon in the notification area (Windows PowerShell 5.1, System.Windows.Forms).
param([System.IO.TextReader]$Reader)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

function Send([hashtable]$Message) {
  try { $stdout.WriteLine((ConvertTo-Json $Message -Compress -Depth 4)) } catch { }
}

Send @{ type = 'hello'; languageMode = "$($ExecutionContext.SessionState.LanguageMode)"; ps = "$($PSVersionTable.PSVersion)"; pid = $PID }

[void][System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
[void][System.Reflection.Assembly]::Load('System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
# An error in an event handler ends the helper (and removes the icon) instead of showing a WinForms dialog.
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::ThrowException)
[System.Windows.Forms.Application]::EnableVisualStyles()
# Session events run on this thread (through this context), not on a worker thread.
[System.Threading.SynchronizationContext]::SetSynchronizationContext((New-Object System.Windows.Forms.WindowsFormsSynchronizationContext))

$script:notify = $null
$script:parent = $null
$script:exitReason = $null
$script:testHooks = $false
$script:defaultId = $null
$script:pending = $Reader.ReadLineAsync()

function Stop-Helper([string]$Reason) {
  if ($script:exitReason) { return }
  $script:exitReason = $Reason
  if ($script:notify) { $script:notify.Visible = $false; $script:notify.Dispose(); $script:notify = $null }
  [System.Windows.Forms.Application]::ExitThread()
}

# The icon size: 16 px at 100% scaling. powershell.exe is not DPI aware (SystemInformation always
# says 16), so the system DPI comes from the registry.
function Get-IconSize {
  $dpi = 96
  try {
    $value = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI
    if ($value -ge 96) { $dpi = [int]$value }
  } catch { }
  return @{ dpi = $dpi; size = [int][Math]::Round(16 * $dpi / 96) }
}

function Limit-Tooltip([string]$Text) {
  # NotifyIcon.Text takes at most 63 characters.
  if ($Text.Length -gt 63) { return $Text.Substring(0, 62) + [char]0x2026 }
  return $Text
}

function New-Menu($Items) {
  # The classic Windows menu (ContextMenu): native look, keyboard access, a bold default item.
  $menu = New-Object System.Windows.Forms.ContextMenu
  foreach ($item in $Items) {
    if ($item.separator) { [void]$menu.MenuItems.Add('-'); continue }
    $menuItem = New-Object System.Windows.Forms.MenuItem([string]$item.text)
    $menuItem.Tag = [string]$item.id
    if ($item.default) { $menuItem.DefaultItem = $true }
    $menuItem.add_Click({ param($sender, $e) Send @{ type = 'action'; id = $sender.Tag; via = 'menu' } })
    [void]$menu.MenuItems.Add($menuItem)
  }
  return $menu
}

function Initialize-Icon($Init) {
  $sizing = Get-IconSize
  if ($Init.icon) {
    # The .ico holds several sizes: take the one for this DPI.
    $bytes = [Convert]::FromBase64String([string]$Init.icon)
    $all = (New-Object System.Drawing.IconConverter).ConvertFrom($bytes)
    $icon = New-Object System.Drawing.Icon($all, $sizing.size, $sizing.size)
  } else {
    $icon = [System.Drawing.SystemIcons]::Application
  }
  $script:notify = New-Object System.Windows.Forms.NotifyIcon
  $script:notify.Icon = $icon
  $script:notify.Text = Limit-Tooltip ([string]$Init.tooltip)
  $script:notify.ContextMenu = New-Menu $Init.menu
  $default = @($Init.menu | Where-Object { $_.default })[0]
  if ($default) {
    $script:defaultId = [string]$default.id
    $script:notify.add_MouseClick({ param($sender, $e)
      if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send @{ type = 'action'; id = $script:defaultId; via = 'left-click' } }
    })
  }
  $script:notify.Visible = $true
  Send @{ type = 'ready'; iconSize = $icon.Width; dpi = $sizing.dpi }
}

function Invoke-Test([string]$Op) {
  # Test hooks (LYREN_TEST_TRAY_CONTROL): the menu items' own Click handlers, no synthetic input.
  if (-not $script:notify) { return }
  if ($Op -like 'click:*') {
    $item = @($script:notify.ContextMenu.MenuItems | Where-Object { $_.Tag -eq $Op.Substring(6) })[0]
    if ($item) { $item.PerformClick() }
  } elseif ($Op -eq 'describe') {
    $items = @($script:notify.ContextMenu.MenuItems | ForEach-Object { @{ id = $_.Tag; text = $_.Text; default = $_.DefaultItem; enabled = $_.Enabled } })
    Send @{ type = 'described'; menu = $items; tooltip = $script:notify.Text; iconSize = $script:notify.Icon.Width }
  }
}

function Invoke-Message([string]$Line) {
  $m = ConvertFrom-Json $Line
  switch ([string]$m.type) {
    'init' {
      $script:testHooks = [bool]$m.testHooks
      if ($m.parentPid) {
        try { $script:parent = [Diagnostics.Process]::GetProcessById([int]$m.parentPid); $null = $script:parent.Handle }
        catch { Stop-Helper 'parent-exit'; return }
      }
      Initialize-Icon $m
    }
    'tooltip' { if ($script:notify) { $script:notify.Text = Limit-Tooltip ([string]$m.text) } }
    'copy' { [System.Windows.Forms.Clipboard]::SetText([string]$m.text); Send @{ type = 'copied' } }
    'ping' { Send @{ type = 'pong'; id = $m.id } }
    'exit' { Stop-Helper 'exit' }
    'test' { if ($script:testHooks) { Invoke-Test ([string]$m.op) } }
  }
}

# Messages from the app, and whether the app still runs: every 100 ms on this (the UI) thread.
$script:ticks = 0
function Invoke-Pending {
  try {
    while ($script:pending -and $script:pending.IsCompleted) {
      if ($script:pending.IsFaulted) { Stop-Helper 'stdin-eof'; return }
      $line = $script:pending.Result
      if ($null -eq $line) { $script:pending = $null; Stop-Helper 'stdin-eof'; return }
      $script:pending = $Reader.ReadLineAsync()
      if ($line.Trim()) { Invoke-Message $line }
      if ($script:exitReason) { return }
    }
    $script:ticks++
    if ($script:parent -and ($script:ticks % 5 -eq 0) -and $script:parent.HasExited) { Stop-Helper 'parent-exit' }
  } catch {
    Send @{ type = 'error'; message = "$($_.Exception.Message)" }
    Stop-Helper 'error'
  }
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.add_Tick({ Invoke-Pending })

# Sign-out or shutdown: ask the app to quit now. When the session really ends, keep answering the app
# (its exit message) for at most 4 s; waiting for it in a blocking call would stop this loop.
$script:sessionEnding = $false
[Microsoft.Win32.SystemEvents]::add_SessionEnding({ param($sender, $e)
  $script:sessionEnding = $true
  Send @{ type = 'session-ending'; reason = "$($e.Reason)" }
})
[Microsoft.Win32.SystemEvents]::add_SessionEnded({ param($sender, $e)
  if (-not $script:sessionEnding) { Send @{ type = 'session-ending'; reason = "$($e.Reason)" } }
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while (-not $script:exitReason -and $wait.ElapsedMilliseconds -lt 4000) {
    Invoke-Pending
    if ($script:parent -and $script:parent.HasExited) { break }
    Start-Sleep -Milliseconds 50
  }
  Stop-Helper 'session-ended'
})

try {
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} catch {
  Send @{ type = 'error'; message = "$($_.Exception.Message)" }
  if (-not $script:exitReason) { $script:exitReason = 'error' }
} finally {
  $timer.Stop()
  if ($script:notify) { $script:notify.Visible = $false; $script:notify.Dispose() }
  Send @{ type = 'bye'; reason = $script:exitReason }
}
`;

/**
 * A message box (dialog.ts). Reads {title, text, icon: Error|Warning|Information} as one JSON line
 * from stdin; prints {"type":"hello","pid"} first, {"type":"showing"} once the box is about to appear
 * and {"type":"closed"} after it was closed (unless the app has ended by then: a command's result box
 * outlives the command). MessageBoxOptions.DefaultDesktopOnly makes it a top-most box on the user's
 * desktop: a program running in the background may not take the foreground, and a box owned by a
 * hidden top-most window was found below other windows when started that way.
 */
export const DIALOG_SCRIPT = String.raw`
# Lyren Plan: a message box (Windows PowerShell 5.1, System.Windows.Forms).
param([System.IO.TextReader]$Reader)

$ErrorActionPreference = 'Stop'
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$stdout.AutoFlush = $true
$stdout.WriteLine('{"type":"hello","pid":' + $PID + '}')
$m = ConvertFrom-Json $Reader.ReadLine()
[void][System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
[System.Windows.Forms.Application]::EnableVisualStyles()
$icon = [System.Windows.Forms.MessageBoxIcon]::Error
if ([string]$m.icon -eq 'Warning') { $icon = [System.Windows.Forms.MessageBoxIcon]::Warning }
if ([string]$m.icon -eq 'Information') { $icon = [System.Windows.Forms.MessageBoxIcon]::Information }
$stdout.WriteLine('{"type":"showing","pid":' + $PID + '}')
$result = [System.Windows.Forms.MessageBox]::Show([string]$m.text, [string]$m.title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button1, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)
# The app may have ended while the box was up (a command's result): nobody reads this then.
try { $stdout.WriteLine('{"type":"closed","result":"' + $result + '"}') } catch { }
`;
