# token-guard — ícone da bandeja do Windows (PowerShell 5.1, System.Windows.Forms.NotifyIcon).
#
# Mostra o estado do daemon (verde protegendo, âmbar em parte, vermelho desligado, cinza daemon
# fora do ar) e abre a tela de configurações. Sem dependências: nada além do que o Windows traz.
#
# O estado chega EMPURRADO: uma thread de fundo mantém aberto o fluxo SSE do daemon
# (127.0.0.1, header X-Token-Guard) e escreve numa tabela compartilhada; o timer de 400 ms do
# formulário só lê essa tabela local para repintar (nenhuma consulta de rede em laço).
#
# Uma instância por usuário (mutex). Lançado pelo daemon sob `conhost.exe --headless`: sem janela.
#   -ProfileDir <pasta>     raiz do perfil (padrão $env:USERPROFILE; os testes apontam para uma pasta temporária)
#   -DumpIcons <pasta> grava um PNG de cada estado e sai (prova dos pixels reais; não abre nada)
#   -StatusFile <arq>  a cada repintura grava ali o que o ícone mostra (estado, título, dica) e o PNG
#                      do ícone entregue ao Windows em <arq>.png: a bandeja do Windows não deixa
#                      ler isso de fora, e é o que a verificação precisa
param(
  [string]$ProfileDir = $env:USERPROFILE,
  [string]$DumpIcons = '',
  [string]$StatusFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace TG -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'

$Colors = @{
  on      = '#2FA36B'
  partial = '#E0A02A'
  off     = '#D14B4B'
  down    = '#8A8F98'
}

# Escudo com o sinal do estado por dentro: visto (protegendo), traço curto (em parte),
# barra (desligado), ponto (daemon fora). A cor sozinha não carrega o significado.
function New-StateBitmap([string]$state, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 32.0
  $shield = @(
    (New-Object System.Drawing.PointF (16 * $k), (2 * $k)),
    (New-Object System.Drawing.PointF (28 * $k), (6.5 * $k)),
    (New-Object System.Drawing.PointF (28 * $k), (16 * $k)),
    (New-Object System.Drawing.PointF (16 * $k), (30 * $k)),
    (New-Object System.Drawing.PointF (4 * $k), (16 * $k)),
    (New-Object System.Drawing.PointF (4 * $k), (6.5 * $k))
  )
  $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($Colors[$state]))
  $g.FillPolygon($fill, $shield)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single](3.2 * $k))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  switch ($state) {
    'on'      { $g.DrawLines($pen, @((New-Object System.Drawing.PointF (10 * $k), (16 * $k)), (New-Object System.Drawing.PointF (14.5 * $k), (20.5 * $k)), (New-Object System.Drawing.PointF (22 * $k), (11 * $k)))) }
    'partial' { $g.DrawLine($pen, (10 * $k), (16 * $k), (22 * $k), (16 * $k)) }
    'off'     { $g.DrawLine($pen, (10 * $k), (10 * $k), (22 * $k), (21 * $k)) }
    'down'    { $g.FillEllipse([System.Drawing.Brushes]::White, (13.5 * $k), (13.5 * $k), (5 * $k), (5 * $k)) }
  }
  $pen.Dispose(); $fill.Dispose(); $g.Dispose()
  return $bmp
}

if ($DumpIcons) {
  New-Item -ItemType Directory -Force -Path $DumpIcons | Out-Null
  foreach ($s in $Colors.Keys) {
    foreach ($px in 32, 128) {
      $b = New-StateBitmap $s $px
      $b.Save((Join-Path $DumpIcons ("tray-{0}-{1}.png" -f $s, $px)), [System.Drawing.Imaging.ImageFormat]::Png)
      $b.Dispose()
    }
  }
  exit 0
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\TokenGuardTray', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

$tgDir = Join-Path $ProfileDir '.token-guard'

function Get-Endpoint {
  try {
    $ep = Get-Content -Raw -Path (Join-Path $tgDir 'daemon-http.json') | ConvertFrom-Json
    $token = (Get-Content -Raw -Path (Join-Path $tgDir 'daemon-http.token')).Trim()
    if ($ep.port -and $token) { return @{ port = [int]$ep.port; token = $token } }
  } catch { }
  return $null
}

# Estado compartilhado com a thread do fluxo: só esta tabela cruza as duas.
$shared = [hashtable]::Synchronized(@{ state = 'down'; label = 'Daemon fora do ar'; blocks = 0; tokens = 0; show = $true; dirty = $true })

$reader = [powershell]::Create()
$null = $reader.AddScript({
  param($shared, $tgDir)
  while ($true) {
    try {
      $ep = Get-Content -Raw -Path (Join-Path $tgDir 'daemon-http.json') | ConvertFrom-Json
      $token = (Get-Content -Raw -Path (Join-Path $tgDir 'daemon-http.token')).Trim()
      $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$($ep.port)/token-guard/stream")
      $req.Headers.Add('X-Token-Guard', $token)
      $req.ReadWriteTimeout = 90000
      $resp = $req.GetResponse()
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      while ($null -ne ($line = $sr.ReadLine())) {
        if ($line.StartsWith('data:')) {
          $j = $line.Substring(5) | ConvertFrom-Json
          $shared.state = [string]$j.state
          $shared.label = [string]$j.label
          $shared.blocks = [int]$j.blocksToday
          $shared.tokens = [int]$j.tokensToday
          $shared.show = [bool]$j.show
          $shared.dirty = $true
        }
      }
    } catch { }
    $shared.state = 'down'; $shared.label = 'Daemon fora do ar'; $shared.dirty = $true
    Start-Sleep -Seconds 3
  }
}).AddArgument($shared).AddArgument($tgDir)
$null = $reader.BeginInvoke()

function Start-Daemon {
  $launcher = Join-Path $PSScriptRoot 'run-daemon.cmd'
  if (Test-Path $launcher) {
    Start-Process -FilePath 'conhost.exe' -ArgumentList @('--headless', 'cmd.exe', '/d', '/c', "`"$launcher`"") -WindowStyle Hidden
  }
}

function Open-Settings {
  $ep = Get-Endpoint
  if ($ep) {
    try {
      $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$($ep.port)/token-guard/ui/ticket")
      $req.Method = 'POST'
      $req.ContentLength = 0
      $req.Timeout = 3000
      $req.Headers.Add('X-Token-Guard', $ep.token)
      $resp = $req.GetResponse()
      $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
      Start-Process ((ConvertFrom-Json $body).url)
      return
    } catch { }
  }
  Start-Daemon
  $icon.ShowBalloonTip(4000, 'token-guard', 'O daemon estava fora do ar. Estou subindo ele; clique de novo em alguns segundos.', 'Info')
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$title = $menu.Items.Add('token-guard'); $title.Enabled = $false
$title.Font = New-Object System.Drawing.Font($title.Font, [System.Drawing.FontStyle]::Bold)
$counts = $menu.Items.Add('Aguardando o daemon'); $counts.Enabled = $false
$null = $menu.Items.Add('-')
$open = $menu.Items.Add('Abrir configurações')
$exit = $menu.Items.Add('Fechar o ícone')
$icon.ContextMenuStrip = $menu
$icon.Visible = $true

$script:currentIcon = $null
function Update-View {
  $s = [string]$shared.state
  if (-not $Colors.ContainsKey($s)) { $s = 'down' }
  $bmp = New-StateBitmap $s 32
  $h = $bmp.GetHicon()
  $newIcon = [System.Drawing.Icon]::FromHandle($h)
  $icon.Icon = $newIcon
  if ($script:currentIcon) { [void][TG.Native]::DestroyIcon($script:currentIcon.Handle) }
  $script:currentIcon = $newIcon
  if ($StatusFile) { $bmp.Save($StatusFile + '.png', [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
  $title.Text = 'token-guard · ' + $shared.label
  if ($s -eq 'down') {
    $counts.Text = 'Sem resposta do daemon'
    $icon.Text = 'token-guard: daemon fora do ar'
  } else {
    $counts.Text = ('Barrados hoje: {0} · poupados: ~{1} tokens' -f $shared.blocks, $shared.tokens)
    $icon.Text = ('token-guard: {0} ({1} barrados hoje)' -f $shared.label, $shared.blocks)
  }
  if ($icon.Text.Length -gt 63) { $icon.Text = $icon.Text.Substring(0, 63) }
  if ($StatusFile) {
    @{ state = $s; title = $title.Text; counts = $counts.Text; tooltip = $icon.Text; visible = $icon.Visible } | ConvertTo-Json | Set-Content -Path $StatusFile -Encoding UTF8
  }
}

$open.add_Click({ Open-Settings })
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Settings } })
$exit.add_Click({ [System.Windows.Forms.Application]::Exit() })

# Repinta só quando o fluxo escreveu algo novo (flag local; nenhuma consulta de rede aqui).
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.add_Tick({
  if ($shared.dirty) {
    $shared.dirty = $false
    if (-not $shared.show) { [System.Windows.Forms.Application]::Exit(); return }
    Update-View
  }
})
Update-View
$timer.Start()

try { [System.Windows.Forms.Application]::Run() }
finally {
  $timer.Stop()
  $icon.Visible = $false
  $icon.Dispose()
  try { $mutex.ReleaseMutex() } catch { }
}
# A thread do fluxo está presa numa leitura de rede bloqueante: Stop() esperaria o daemon fechar o
# fluxo. Sair do processo direto encerra a thread junto.
[Environment]::Exit(0)
