$ErrorActionPreference = "Continue"
$dir = $PSScriptRoot
Set-Location $dir
$tokenFile = Join-Path $env:USERPROFILE ".gemini-mcp-token"
$tunnelLog = Join-Path $dir "tunnel.log"
$launchLog = Join-Path $env:USERPROFILE ".gemini-mcp-launcher.log"
$cf = Join-Path $dir "cloudflared.exe"
$script:srv = $null
$script:tun = $null
$script:url = $null
$PORT = 41337

function Log($m) {
  try { Add-Content -Path $launchLog -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) } catch {}
}

function Kill-Tree($id) {
  if ($id) { & taskkill /PID $id /T /F 2>$null | Out-Null }
}

function Start-Server {
  $env:NODE_ENV = "production"
  $script:srv = Start-Process node -ArgumentList "server.js" -WorkingDirectory $dir -WindowStyle Minimized -PassThru
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$PORT/health" -TimeoutSec 2
      if ($h.status -eq "ok") { return $true }
    } catch {}
  }
  return $false
}

function Start-Tunnel {
  if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue }
  $script:tun = Start-Process $cf -ArgumentList "tunnel","--url","http://127.0.0.1:$PORT","--no-autoupdate","--logfile",$tunnelLog -WindowStyle Minimized -PassThru
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $txt = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
    if ($txt -match "https://[a-z0-9-]+\.trycloudflare\.com") { $script:url = $Matches[0]; return $true }
  }
  return $false
}

function Publish-Url($banner) {
  $token = (Get-Content $tokenFile -Raw).Trim()
  $full = "$($script:url)/mcp/$token"
  try { Set-Clipboard -Value $full } catch {}
  $verif = $false
  for ($i = 0; $i -lt 15; $i++) {
    try {
      $hostName = ([Uri]$script:url).Host
      $ip = (Resolve-DnsName $hostName -Server 1.1.1.1 -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
      $out = curl.exe -s -m 8 --resolve "${hostName}:443:$ip" "$($script:url)/health"
      if ($out -match '"status":"ok"') { $verif = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if ($verif) { Write-Host "[OK] El tunel responde desde internet" -ForegroundColor Green }
  else { Write-Host "[!] El tunel aun no responde, espera unos segundos y prueba igual" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host $banner -ForegroundColor Cyan
  Write-Host $full -ForegroundColor White
  Write-Host ""
  Write-Host "NO compartas esa URL ni la pegues en capturas: da acceso a tu carpeta proyectos y permite ejecutar comandos en tu PC." -ForegroundColor Yellow
  Log ("URL publicada: " + $script:url + "/mcp/<token>  verificada=" + $verif)
}

Write-Host ""
Write-Host "=== MCP para Gemini ===" -ForegroundColor Cyan
Log "=== inicio del lanzador ==="

Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cf } | ForEach-Object { Kill-Tree $_.Id }
Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Kill-Tree $_.OwningProcess }

if (-not (Start-Server)) {
  Write-Host "ERROR: el servidor no arranco. Revisa server.js" -ForegroundColor Red
  Log "ERROR: servidor no arranco"
  Read-Host "Enter para salir"; exit 1
}
Write-Host "[OK] Servidor MCP corriendo en 127.0.0.1:$PORT" -ForegroundColor Green
if (-not (Start-Tunnel)) {
  Write-Host "ERROR: no se obtuvo URL del tunel. Mira tunnel.log" -ForegroundColor Red
  Log "ERROR: tunel sin URL"
  Kill-Tree $script:srv.Id
  Read-Host "Enter para salir"; exit 1
}
Write-Host "[OK] Tunel creado: $($script:url)" -ForegroundColor Green
Publish-Url "URL PARA PEGAR EN GEMINI (ya copiada al portapapeles):"

$interactive = $true
try { $null = [Console]::KeyAvailable } catch { $interactive = $false }

if (-not $interactive) {
  Write-Host "Deja esta ventana abierta. Presiona Enter para APAGAR todo." -ForegroundColor Gray
  Read-Host | Out-Null
} else {
  Write-Host "Vigilando servidor y tunel (Ping anti-inactividad cada 4m)." -ForegroundColor Gray
  Write-Host "Deja esta ventana abierta. Presiona Enter para APAGAR todo." -ForegroundColor Gray
  $stop = $false
  $lastPing = Get-Date
  while (-not $stop) {
    for ($i = 0; $i -lt 5; $i++) {
      Start-Sleep -Seconds 1
      if ([Console]::KeyAvailable) {
        $k = [Console]::ReadKey($true)
        if ($k.Key -eq "Enter") { $stop = $true; break }
      }
    }
    if ($stop) { break }
    
    if (((Get-Date) - $lastPing).TotalMinutes -ge 4) {
        $lastPing = Get-Date
        try { 
            $null = Invoke-RestMethod "$script:url/health" -TimeoutSec 5 -ErrorAction SilentlyContinue
            Log "Ping keep-alive enviado al tunel."
        } catch {}
    }

    if ($script:srv.HasExited) {
      Write-Host "[!] El servidor se cayo. Reiniciando..." -ForegroundColor Yellow
      Log "servidor caido, reiniciando"
      if (Start-Server) { Write-Host "[OK] Servidor de vuelta" -ForegroundColor Green; Log "servidor reiniciado" }
      else { Write-Host "[!] No pudo reiniciar el servidor" -ForegroundColor Red; Log "servidor no reinicio" }
    }
    if ($script:tun.HasExited) {
      Write-Host "[!] El tunel se cayo. Creando uno nuevo (la URL CAMBIA)..." -ForegroundColor Yellow
      Log "tunel caido, reiniciando"
      [Console]::Beep(800, 300)
      if (Start-Tunnel) { Publish-Url "URL NUEVA - actualizala en Gemini (ya copiada al portapapeles):" }
      else { Write-Host "[!] No se pudo crear el tunel nuevo" -ForegroundColor Red; Log "tunel no reinicio" }
    }
  }
}

try {
    Remove-Item (Join-Path $env:USERPROFILE ".gemini-mcp.log") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:USERPROFILE ".gemini-mcp-launcher.log") -Force -ErrorAction SilentlyContinue
} catch {}

Kill-Tree $script:tun.Id
Kill-Tree $script:srv.Id
Log "apagado por el usuario"
Write-Host "Apagado y cache local de logs limpiado." -ForegroundColor Gray
