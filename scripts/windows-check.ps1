<#
  Plain ASCII on purpose: Windows PowerShell reads a file without a byte-order mark as Windows-1252,
  and treats a curly apostrophe as a quote, which ends a string mid-word.

  Checks Polyphemus on a Windows computer, through WSL2, and writes a report to paste back.

  Run it in an ordinary PowerShell window (not as Administrator), from the folder it's in:

    powershell -ExecutionPolicy Bypass -File .\windows-check.ps1

  With a polyphemus-*.tgz and install.sh beside it, it installs that build; otherwise the published
  one. What it changes: Polyphemus is installed inside your default WSL distribution (in ~/.local),
  and runs there as a service if systemd is on. To check a phone could reach it, it points this
  computer's Tailscale HTTPS address at Polyphemus for a few seconds and then turns that off again -
  skipped if that address already serves something, or with -NoPhone. It never installs WSL, never
  runs as Administrator, and never changes Windows settings.
#>
param([switch]$NoPhone)

$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1'  # wsl.exe answers in UTF-16 otherwise, which PowerShell reads as noise
# What Linux prints is UTF-8; Windows PowerShell would read it with the console's code page, and a
# tick or an apostrophe from poly doctor would arrive as three characters of noise.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$port = 3900
$report = New-Object System.Collections.Generic.List[string]
function Say([string]$line) { $report.Add($line); Write-Host $line }
function Pass([string]$what) { Say "PASS  $what" }
function Fail([string]$what) { Say "FAIL  $what" }
function Note([string]$what) { Say "      $what" }
function Finish([switch]$Clean) {
  # Only after a run that got to the end: one that stops to say "do this, then run this again" needs
  # its files for the next run. And only files it can tell are its own, whatever Taildrop called them.
  if ($Clean) {
    $ours = Get-ChildItem -Path $PSScriptRoot -File | Where-Object {
      $_.Name -like 'windows-check*.ps1' -or $_.Name -like 'windows-check-wsl*.sh' -or $_.Name -like 'polyphemus-*.tgz' -or
      ($_.Name -like 'install*.ps1' -and (Select-String -Path $_.FullName -Pattern 'Installs Polyphemus on Windows' -SimpleMatch -Quiet)) -or
      ($_.Name -like 'install*.sh' -and (Select-String -Path $_.FullName -Pattern 'Installs Polyphemus on macOS or Linux' -SimpleMatch -Quiet))
    }
    $ours | Remove-Item -Force -ErrorAction SilentlyContinue
    $report.Add("      Removed the files it was sent: $(($ours | ForEach-Object { $_.Name }) -join ', ')")
  }
  $path = Join-Path $PSScriptRoot 'windows-check-report.txt'
  $report | Set-Content -Encoding utf8 -Path $path
  Write-Host ''
  if ($Clean) { Write-Host 'Removed the files it was sent; the report stays.' }
  Write-Host "Saved to $path. Paste it back."
  exit
}
# A yes or no from the person running this, kept in the report with the answer.
function Ask([string]$question) {
  $answer = Read-Host "$question (y/n)"
  $yes = $answer -match '^\s*y'
  $report.Add("ASKED $question -> $(if ($yes) { 'yes' } else { 'no' })")
  return $yes
}
# An HTTP status, 401 included: Windows PowerShell throws on anything but success.
function HttpCode([string]$url) {
  try { return [int](Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8 -MaximumRedirection 0).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 } }
}

Say "Polyphemus Windows check, $(Get-Date -Format s)"
$os = Get-CimInstance Win32_OperatingSystem
Say "Windows: $($os.Caption), build $($os.BuildNumber), $env:PROCESSOR_ARCHITECTURE"

# WSL itself.
# All of it, then the exit code: Select-Object -First stops wsl.exe early, and a stopped wsl.exe
# looks like one that failed, so an up-to-date WSL was offered an update (2026-09-23).
# Told apart without running wsl.exe while it might be the stub Windows leaves once WSL is removed,
# which answers everything with "Press any key to install" (install.ps1 says more).
$wslInstalled = Test-Path (Join-Path $env:ProgramFiles 'WSL\wsl.exe')
$wslRegistered = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue).Count -gt 0
$versionLines = @()
if ($wslInstalled) { $versionLines = @(wsl.exe --version 2>$null | ForEach-Object { "$_" -replace "`0", '' }) }
$wslCurrent = $wslInstalled -and $LASTEXITCODE -eq 0
$wslVersion = $versionLines | Select-Object -First 1
if (-not $wslCurrent) {
  if (-not $wslInstalled -and -not $wslRegistered) {
    Say "FOUND WSL isn't installed. On Windows, Polyphemus runs inside WSL: a Linux that comes from Microsoft."
    if (-not (Ask 'Install WSL with Ubuntu now? Windows asks for permission, and you restart the computer afterwards.')) {
      Fail "WSL isn't installed, so Polyphemus can't be installed here"
      Note 'When you are ready: wsl --install -d Ubuntu, restart, then run this again.'
      Finish
    }
    wsl.exe --install -d Ubuntu 2>&1 | ForEach-Object { Note ("$_" -replace "`0", '') }
    if ($LASTEXITCODE -ne 0) {
      Fail "WSL didn't install"
      Note 'Try the same in PowerShell opened as Administrator: wsl --install -d Ubuntu'
      Finish
    }
    Pass 'WSL is installed'
    # Nothing here survives the restart WSL needs, so the next step is said plainly instead.
    Say 'NEXT  Restart Windows. Ubuntu then opens by itself and asks for a username and password: any you like.'
    Say '      Then run this again.'
    Finish
  }
  Say "FOUND This computer has the WSL that came built into Windows. It's out of date, and it can't run"
  Say "      systemd, which Polyphemus needs to keep running in the background."
  if (-not (Ask 'Update WSL now? It downloads the current version from Microsoft, and Windows may ask for permission.')) {
    Fail "WSL wasn't updated, so Polyphemus can't be installed here"
    Note 'When you are ready: wsl --update, then run this again.'
    Finish
  }
  $said = @(wsl.exe --update 2>&1)
  $said | ForEach-Object { Note ("$_" -replace "`0", '') }
  $versionLines = @(wsl.exe --version 2>$null | ForEach-Object { "$_" -replace "`0", '' })
  $wslVersion = $versionLines | Select-Object -First 1
  if ($LASTEXITCODE -ne 0) {
    Fail "WSL didn't update"
    Note 'Try: install "Windows Subsystem for Linux" from the Microsoft Store, then run this again.'
    Finish
  }
  Pass "WSL updated: $wslVersion"
} else {
  Note "WSL: $wslVersion"
}
$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
$mode = if ((Test-Path $wslconfig) -and (Select-String -Path $wslconfig -Pattern '^\s*networkingMode\s*=\s*mirrored' -Quiet)) { 'mirrored' } else { 'NAT (the default)' }
Note "WSL networking: $mode"

# Older WSL ignores WSL_UTF8 and answers in UTF-16 anyway: the nulls come out before matching.
$default = wsl.exe -l -v 2>&1 | ForEach-Object { "$_" -replace "`0", '' } | Where-Object { $_ -match '^\s*\*' } | Select-Object -First 1
if (-not $default) {
  Say 'FOUND WSL is here, but it has no Linux in it yet.'
  if (-not (Ask 'Install Ubuntu now? It asks you for a username and password; at the Linux prompt that follows, type exit to come back here.')) {
    Fail "There's no Linux in WSL, so Polyphemus can't be installed here"
    Note 'When you are ready: wsl --install -d Ubuntu, then run this again.'
    Finish
  }
  # Interactive on purpose: Ubuntu's first start is where the person picks their Linux username.
  wsl.exe --install -d Ubuntu
  $default = wsl.exe -l -v 2>&1 | ForEach-Object { "$_" -replace "`0", '' } | Where-Object { $_ -match '^\s*\*' } | Select-Object -First 1
  if (-not $default) {
    Fail "Ubuntu didn't install"
    Finish
  }
  Pass 'Ubuntu is installed'
}
$parts = @(($default -replace '^\s*\*\s*', '') -split '\s+' | Where-Object { $_ })
$distro = $parts[0]
$version = $parts[-1]
if ($version -ne '2') {
  Fail "$distro runs on WSL $version; Polyphemus needs WSL 2"
  Note "Fix: wsl --set-version $distro 2"
  Finish
}
Pass "WSL 2, with $distro as the default distribution"

# Everything inside Linux: the other half of this check.
# Only what it prints, never its warnings: the WSL built into Windows puts a notice about the Store
# version on stderr, which merged in here once came back as the path (2026-09-23).
# -e runs wslpath itself rather than through Linux's shell, which read the backslashes in a Windows
# path as escapes (2026-09-23); forward slashes are what wslpath takes either way. WSL's own default
# mount is the fallback.
$kit = @(wsl.exe -d $distro -e wslpath -a ($PSScriptRoot -replace '\\', '/') 2>$null | ForEach-Object { "$_" -replace "`0", '' } | Where-Object { $_ -like '/*' })[0]
if (-not $kit -and $PSScriptRoot -match '^([A-Za-z]):\\(.*)$') { $kit = "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\', '/')" }
# The newest copy of the other half: Taildrop saves a second send as "windows-check-wsl (1).sh".
$wslHalf = (Get-ChildItem -Path $PSScriptRoot -Filter 'windows-check-wsl*.sh' | Sort-Object LastWriteTime | Select-Object -Last 1).Name
$null = wsl.exe -d $distro -e test -f "$kit/$wslHalf" 2>$null
if ($LASTEXITCODE -ne 0) { $kit = $null }
if (-not $kit) {
  Fail "WSL couldn't see this folder ($PSScriptRoot)"
  Finish
}
# systemd is what keeps Polyphemus running in the background; WSL leaves it off unless asked.
$null = wsl.exe -d $distro -- test -d /run/systemd/system 2>$null
if ($LASTEXITCODE -ne 0) {
  Say "FOUND systemd is off in $distro, so Polyphemus can't run in the background there."
  if (Ask "Turn systemd on? It adds two lines to /etc/wsl.conf in $distro and restarts WSL, which stops anything running in it now.") {
    $said = @(wsl.exe -d $distro -u root -- bash "$kit/$wslHalf" --enable-systemd 2>&1)
    $said | ForEach-Object { Note "$_" }
    $null = wsl.exe --shutdown 2>&1
    foreach ($i in 1..20) { $null = wsl.exe -d $distro -- test -d /run/systemd/system 2>$null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 2 }
    if ($LASTEXITCODE -eq 0) { Pass "systemd is on in $distro" } else { Fail "systemd didn't start in $distro" }
  } else {
    Note 'Left off: Polyphemus runs while its terminal is open (poly serve), but not in the background.'
  }
}
# Collected, then printed: while wsl.exe runs it puts the console in a mode where a new line doesn't
# go back to the left edge, so anything printed meanwhile staircases across the screen (2026-09-23).
Note 'Checking Linux and installing Polyphemus inside it: a minute or two.'
$said = @(wsl.exe -d $distro -- bash "$kit/$wslHalf" "$kit" 2>&1)
$said | ForEach-Object { Say "$_" }
$serviced = $report -contains 'PASS  poly service install'
if (-not ($report | Where-Object { $_ -like 'PASS  installed polyphemus*' })) { Finish }

# Without systemd there's no service, so a daemon of its own, only for this check.
$temporary = $null
if (-not $serviced) {
  Note 'No service, so starting polyphemus in a hidden window for the rest of this check'
  # One string, quoted by hand: Windows PowerShell joins an argument list with spaces and no quoting.
  $temporary = Start-Process wsl.exe -ArgumentList "-d $distro -- bash -c `"POLYPHEMUS_TAILSCALE=off ~/.local/bin/poly serve`"" -WindowStyle Hidden -PassThru
}
$code = 0
foreach ($i in 1..30) { $code = HttpCode "http://127.0.0.1:$port/"; if ($code -eq 401) { break }; Start-Sleep -Seconds 1 }
if ($code -eq 401) { Pass "Windows reaches polyphemus in WSL at http://127.0.0.1:$port" }
else { Fail "Windows can't reach polyphemus in WSL at http://127.0.0.1:$port (HTTP $code)"; Note "WSL's localhost forwarding is off or not working: check localhostForwarding in .wslconfig" }

# The one command a new person runs: it should open this computer's browser on the setup wizard.
# Observed, not asked: a browser that opens the link pairs as a new device, and Polyphemus says so.
function PairedDevices {
  $json = (wsl.exe -d $distro -- bash -c '~/.local/bin/poly devices --json' 2>$null) -join ''
  try { return @((ConvertFrom-Json $json).data.devices | Where-Object { -not $_.revokedAt }).Count } catch { return -1 }
}
if ($code -eq 401) {
  $before = PairedDevices
  $said = @(wsl.exe -d $distro -- bash -c '~/.local/bin/poly start' 2>&1)
  $said | ForEach-Object { Note "poly start: $_" }
  $after = $before
  foreach ($i in 1..15) { Start-Sleep -Seconds 2; $after = PairedDevices; if ($after -gt $before) { break } }
  if ($before -lt 0) { Fail "Couldn't count paired devices to see whether the browser opened" }
  elseif ($after -gt $before) { Pass 'poly start opened the setup wizard in the Windows browser: it paired as a new device' }
  else {
    Fail "poly start didn't open the setup wizard in the Windows browser: nothing paired within 30 seconds"
    # The same link, opened from Windows itself: tells "Windows won't open a browser" from "the hand-off
    # from inside WSL doesn't reach it". The link works once, and it wasn't used.
    $link = ($said | ForEach-Object { "$_" } | Select-String -Pattern 'http://127\.0\.0\.1:\d+/pair\?code=[A-Z0-9-]+' | Select-Object -First 1).Matches.Value
    if ($link) {
      Start-Process $link
      foreach ($i in 1..10) { Start-Sleep -Seconds 2; $after = PairedDevices; if ($after -gt $before) { break } }
      if ($after -gt $before) { Note 'Opened from Windows itself, the same link paired: the hand-off from inside WSL is what fails' }
      else { Note 'Opened from Windows itself, it still did not pair: Windows did not open a browser on that link either' }
    }
  }
}

# A phone reaches this computer over Tailscale, which runs on Windows, not inside WSL.
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $tailscale = Get-Command "$env:ProgramFiles\Tailscale\tailscale.exe" }
if (-not $tailscale) {
  Fail "Tailscale isn't installed on Windows, so a phone can't reach this computer"
} else {
  $ts = & $tailscale status --json 2>$null | ConvertFrom-Json
  if (-not $ts -or $ts.BackendState -ne 'Running') {
    Fail 'Tailscale is installed on Windows but not connected'
  } else {
    $name = $ts.Self.DNSName.TrimEnd('.')
    $ip = @($ts.Self.TailscaleIPs | Where-Object { $_ -notmatch ':' })[0]
    Pass 'Tailscale is connected on Windows'
    $direct = HttpCode "http://${ip}:$port/"
    if ($direct -eq 401) { Pass "a phone could reach it directly at this computer's tailnet address, port $port" }
    else { Note "Not reachable directly at the tailnet address, port $port (HTTP $direct): expected, WSL only forwards Windows's own localhost" }
    $serving = & $tailscale serve status 2>&1 | Out-String
    if ($serving -match "127\.0\.0\.1:$port|localhost:$port") {
      # Polyphemus in WSL points Tailscale's HTTPS here itself, through tailscale.exe: checked, and
      # left as it is, since it's how the phone gets in.
      $https = 0
      foreach ($i in 1..10) { $https = HttpCode "https://$name/"; if ($https -eq 401) { break }; Start-Sleep -Seconds 2 }
      if ($https -eq 401) { Pass "a phone can reach it at https://$name, which polyphemus set up itself" }
      else { Fail "Tailscale HTTPS points at polyphemus but didn't answer (HTTP $https)" }
    } elseif ($NoPhone) {
      Note 'Skipped the Tailscale HTTPS check (-NoPhone)'
    } elseif ($serving -match ':443|https://') {
      Note "Skipped the Tailscale HTTPS check: this computer's HTTPS address already serves something, and it's left alone"
    } else {
      $served = & $tailscale serve --bg --https=443 "http://127.0.0.1:$port" 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) {
        Fail "Tailscale wouldn't serve HTTPS from Windows"
        Note ($served.Trim() -replace '\s+', ' ')
      } else {
        $https = 0
        foreach ($i in 1..10) { $https = HttpCode "https://$name/"; if ($https -eq 401) { break }; Start-Sleep -Seconds 2 }
        if ($https -eq 401) { Pass "a phone can reach it at https://$name, through Tailscale on Windows" }
        else { Fail "Tailscale HTTPS on Windows didn't reach polyphemus (HTTP $https)" }
        $null = & $tailscale serve --https=443 off 2>&1
        Note 'Turned Tailscale HTTPS off again'
      }
    }
  }
}

if ($temporary) {
  $null = wsl.exe -d $distro -- bash -c "pkill -f '[p]olyphemus.mjs serve'" 2>&1
  Stop-Process -Id $temporary.Id -ErrorAction SilentlyContinue
  Note 'Stopped the polyphemus started for this check'
}
Finish -Clean
