#!/usr/bin/env pwsh
# scripts/verify-daemon-security.ps1
#
# Checklist MANUAL (F4/D5) — NÃO faz parte de `npm test`. Named pipe no
# Windows não expõe uma API pública em Node pra restringir a DACL na criação
# (net.Server.listen() não aceita security descriptor); esta verificação
# roda contra um daemon já vivo pra confirmar, na plataforma real, que o
# pipe não ficou acessível a outras contas locais.
#
# Uso: com um daemon token-guard já rodando nesta máquina,
#   pwsh scripts/verify-daemon-security.ps1 [-PipeName token-guard-<sid>]

param(
  [string]$PipeName = ""
)

$ErrorActionPreference = "Stop"

if (-not $PipeName) {
  $candidates = Get-ChildItem "\\.\pipe\" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "token-guard-*" }
  if (-not $candidates) {
    Write-Host "Nenhum pipe 'token-guard-*' encontrado. Suba o daemon primeiro (node adapters/daemon-server.cjs)." -ForegroundColor Red
    exit 1
  }
  $PipeName = $candidates[0].Name
  Write-Host "Pipe detectado automaticamente: $PipeName"
}

$fullPath = "\\.\pipe\$PipeName"
Write-Host "Verificando ACL de: $fullPath`n"

try {
  $acl = Get-Acl -Path $fullPath
} catch {
  Write-Host "FALHOU: não foi possível ler ACL do pipe ($($_.Exception.Message))" -ForegroundColor Red
  exit 1
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$everyoneSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-1-0")   # Everyone
$authUsersSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-11") # Authenticated Users

$failed = $false

Write-Host "Regras de acesso encontradas:"
foreach ($ace in $acl.Access) {
  Write-Host ("  - {0,-45} {1,-12} {2}" -f $ace.IdentityReference, $ace.AccessControlType, $ace.FileSystemRights)
  $aceSid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
  if (($aceSid -eq $everyoneSid -or $aceSid -eq $authUsersSid) -and $ace.AccessControlType -eq "Allow") {
    Write-Host "    ^ SUSPEITO: concede acesso a Everyone/Authenticated Users" -ForegroundColor Yellow
    $failed = $true
  }
}

Write-Host ""
if ($failed) {
  Write-Host "FALHOU: pipe acessível além da conta atual — revisar DACL (D5, docs/PLAN-daemon-unico.md)." -ForegroundColor Red
  exit 1
} else {
  Write-Host "OK: nenhuma regra Allow para Everyone/Authenticated Users encontrada." -ForegroundColor Green
  Write-Host "Nota: esta checagem é best-effort — named pipes no Windows por padrão já" -ForegroundColor DarkGray
  Write-Host "rejeitam clientes remotos (PIPE_REJECT_REMOTE_CLIENTS implícito em \\.\pipe\)." -ForegroundColor DarkGray
  exit 0
}
