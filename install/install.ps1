<#
  Installs Polyphemus on Windows. It runs inside WSL, a Linux that comes from Microsoft, so this
  sees to WSL first, asking before it changes anything, then installs Polyphemus inside it:

    irm https://polyphemus.ai/install.ps1 | iex

  Run it in an ordinary PowerShell window. Windows asks for permission itself where a step needs it
  (installing or updating WSL). With a polyphemus-*.tgz and install.sh beside this file, it installs
  that build instead of the published one: that is how a build is tried before it's published.

  Plain ASCII on purpose: Windows PowerShell reads a file without a byte-order mark as Windows-1252,
  and treats a curly apostrophe as a quote, which ends a string mid-word. And everything is inside
  one function that returns rather than exits: `irm | iex` runs in your own window, and exit would
  close it. What each step does was proven first by scripts/windows-check.ps1.
#>

function Install-Polyphemus {
  $ErrorActionPreference = 'Continue'
  $env:WSL_UTF8 = '1'  # wsl.exe answers in UTF-16 otherwise
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8  # what Linux prints is UTF-8
  $again = if ($PSCommandPath) { "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"" } else { 'irm https://polyphemus.ai/install.ps1 | iex' }
  function Ask([string]$question) { return (Read-Host "$question (y/n)") -match '^\s*y' }
  function Said([string]$line) { Write-Host "  $line" }
  # Everything wsl.exe prints, then its exit code: stopping it early looks like failing.
  function Wsl([string[]]$arguments) { $script:out = @(wsl.exe @arguments 2>$null | ForEach-Object { "$_" -replace "`0", '' }); return $LASTEXITCODE -eq 0 }
  function Distro {
    $line = @(wsl.exe -l -v 2>&1 | ForEach-Object { "$_" -replace "`0", '' } | Where-Object { $_ -match '^\s*\*' })[0]
    if (-not $line) { return $null }
    $parts = @(($line -replace '^\s*\*\s*', '') -split '\s+' | Where-Object { $_ })
    return @{ name = $parts[0]; version = $parts[-1] }
  }

  Write-Host ''
  Write-Host 'Installing Polyphemus. On Windows it runs inside WSL, a Linux from Microsoft.'
  Write-Host ''

  # WSL itself: here, and new enough to run systemd, which keeps Polyphemus running in the background.
  # Told apart without running wsl.exe: once WSL is removed, the stub Windows keeps answers every
  # command with "Press any key to install", and would sit unseen behind captured output, or install
  # unasked when it timed out (2026-09-23). The current WSL lives in Program Files; Linux systems set
  # up under the old one built into Windows are listed in the registry.
  $current = Test-Path (Join-Path $env:ProgramFiles 'WSL\wsl.exe')
  $registered = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue).Count -gt 0
  if (-not $current -or -not (Wsl @('--version'))) {
    if (-not $current -and -not $registered) {
      Write-Host "WSL isn't installed."
      if (-not (Ask 'Install WSL with Ubuntu now? Windows asks for permission, and may need a restart.')) {
        Write-Host "Polyphemus can't be installed without WSL. When you're ready: wsl --install -d Ubuntu, then run this again."
        return
      }
      wsl.exe --install -d Ubuntu
      if ($LASTEXITCODE -ne 0) { Write-Host "WSL didn't install. Try the same in PowerShell opened as Administrator: wsl --install -d Ubuntu"; return }
      if (-not (Distro)) {
        Set-Clipboard -Value $again
        Write-Host ''
        Write-Host 'Restart Windows. Ubuntu then opens by itself and asks for a username and password: any you like.'
        Write-Host "Then run this again. It's on your clipboard: $again"
        return
      }
    } else {
      Write-Host "This computer has the WSL that came built into Windows. It's out of date and can't run systemd,"
      Write-Host 'which keeps Polyphemus running in the background.'
      if (-not (Ask 'Update WSL now? It downloads the current version from Microsoft.')) {
        Write-Host "Polyphemus can't be installed on this WSL. When you're ready: wsl --update, then run this again."
        return
      }
      wsl.exe --update
      if (-not (Wsl @('--version'))) { Write-Host "WSL didn't update. Try installing it from the Microsoft Store, then run this again."; return }
    }
  }
  if (Wsl @('--version')) { Said "WSL: $(@($script:out)[0])" }

  $distro = Distro
  if (-not $distro) {
    Write-Host 'WSL is here, but it has no Linux in it yet.'
    if (-not (Ask 'Install Ubuntu now? It asks you for a username and password; at the Linux prompt that follows, type exit to come back here.')) {
      Write-Host "Polyphemus can't be installed without a Linux in WSL. When you're ready: wsl --install -d Ubuntu, then run this again."
      return
    }
    wsl.exe --install -d Ubuntu
    $distro = Distro
    if (-not $distro) { Write-Host "Ubuntu didn't install."; return }
  }
  if ($distro.version -ne '2') {
    Write-Host "$($distro.name) runs on WSL $($distro.version), and Polyphemus needs WSL 2."
    if (-not (Ask "Move $($distro.name) to WSL 2 now? It can take a few minutes.")) { Write-Host "When you're ready: wsl --set-version $($distro.name) 2, then run this again."; return }
    wsl.exe --set-version $distro.name 2
  }
  $name = $distro.name
  Said "Linux: $name"

  # systemd, which WSL leaves off unless asked; as root through wsl -u root, so no Linux password.
  $systemd = Wsl @('-d', $name, '-e', 'test', '-d', '/run/systemd/system')
  if (-not $systemd) {
    Write-Host "systemd is off in $name, so Polyphemus can't run in the background there."
    if (Ask "Turn it on? It adds two lines to /etc/wsl.conf in $name and restarts WSL, which stops anything running in it now.") {
      # No double quotes: Windows PowerShell passes them to a program mangled. From / so no pattern here
      # can match a file. Keeps whatever else wsl.conf says, and doesn't add the line twice.
      $enable = 'cd /; f=/etc/wsl.conf; touch $f; if grep -q ^[[:space:]]*systemd[[:space:]]*= $f; then sed -i s/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/ $f; elif grep -q ^.boot.$ $f; then sed -i /^.boot.$/a\ systemd=true $f; else echo >> $f; echo \[boot\] >> $f; echo systemd=true >> $f; fi'
      $null = Wsl @('-d', $name, '-u', 'root', '-e', 'sh', '-c', $enable)
      $null = wsl.exe --shutdown 2>&1
      foreach ($i in 1..20) { if (Wsl @('-d', $name, '-e', 'test', '-d', '/run/systemd/system')) { $systemd = $true; break }; Start-Sleep -Seconds 2 }
      if ($systemd) { Said 'systemd: on' } else { Write-Host "systemd didn't start. Polyphemus will still install; run it with poly serve in Ubuntu." }
    }
  } else {
    Said 'systemd: on'
  }

  # Polyphemus itself, inside Linux, the way it installs on any Linux: that script asks about the
  # Claude, ChatGPT and SuperGrok CLIs, so it runs in this window, not captured.
  Write-Host ''
  $package = Get-ChildItem -Path $PSScriptRoot -Filter 'polyphemus-*.tgz' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  $script = Get-ChildItem -Path $PSScriptRoot -Filter 'install*.sh' -ErrorAction SilentlyContinue | Where-Object { Select-String -Path $_.FullName -Pattern 'Installs Polyphemus on macOS or Linux' -SimpleMatch -Quiet } | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($PSScriptRoot -and $package -and $script) {
    # A build to try: copied to plain names in a folder of its own, so no Windows path, space or
    # quote has to survive the trip into Linux's shell.
    $kit = Join-Path $env:TEMP 'polyphemus-install'
    Remove-Item -Recurse -Force $kit -ErrorAction SilentlyContinue
    $null = New-Item -ItemType Directory -Path $kit
    Copy-Item $package.FullName (Join-Path $kit 'polyphemus.tgz')
    Copy-Item $script.FullName (Join-Path $kit 'install.sh')
    Write-Host "Installing the build beside this script ($($package.Name)) inside $name..."
    wsl.exe -d $name --cd $kit -e sh -c 'POLYPHEMUS_PACKAGE=$PWD/polyphemus.tgz sh install.sh'
  } else {
    Write-Host "Installing Polyphemus inside $name..."
    wsl.exe -d $name --cd '~' -e sh -c 'curl -fsSL https://polyphemus.ai/install.sh | sh'
  }
  if (-not (Wsl @('-d', $name, '-e', 'sh', '-c', '$HOME/.local/bin/poly --version'))) { Write-Host ''; Write-Host "Polyphemus didn't install. What it printed above says why."; return }

  # Running in the background, then setup open in this computer's browser.
  Write-Host ''
  if ($systemd) {
    # poly start installs the background service when nothing's answering yet, then opens setup.
    wsl.exe -d $name -e sh -c '$HOME/.local/bin/poly start'
  } else {
    Write-Host 'Without systemd it runs while a window is open: in Ubuntu, run poly serve, then poly start.'
  }

  Write-Host ''
  Write-Host 'Polyphemus is installed. Its commands are in Ubuntu (from the Start menu): poly help lists them,'
  Write-Host 'and poly doctor says what this computer still lacks.'
  if (-not (Get-Command tailscale -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) {
    Write-Host 'To use it from your phone, install Tailscale on Windows and your phone (tailscale.com/download), then run poly pair in Ubuntu.'
  } else {
    Write-Host 'To add your phone: run poly pair in Ubuntu. Tailscale on Windows carries it.'
  }
}

Install-Polyphemus
