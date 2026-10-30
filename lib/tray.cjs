'use strict';
/**
 * tray.cjs — sobe o ícone da bandeja do token-guard (Windows).
 *
 * O ícone é um helper PowerShell 5.1 (adapters/tray.ps1, System.Windows.Forms.NotifyIcon): zero
 * dependências, nada para instalar. Nasce com o daemon, que é um por usuário; o próprio script
 * se trava num mutex, então subir duas vezes não duplica o ícone.
 *
 * O stdin é um pipe e não NUL: o `conhost --headless` não executa o filho quando recebe o stdin
 * fechado (`stdio: 'ignore'`), e o ícone simplesmente não nasce.
 *
 * Nunca pisca janela: o PowerShell roda sob `conhost.exe --headless` (o `-WindowStyle Hidden`
 * não basta: o Windows desenha o console antes). Fail-open: qualquer falha aqui só deixa o
 * daemon sem ícone, e diz por quê.
 *
 * Silêncio garantido nos testes e onde não cabe: TOKEN_GUARD_TRAY=off, config `ui.tray: false`,
 * e fora do Windows (macOS/Linux não têm helper de bandeja; a tela abre por `token-guard setup`).
 */

const path = require('path');
const { spawn } = require('child_process');
const CFG = require('./config.cjs');

const SCRIPT = path.join(__dirname, '..', 'adapters', 'tray.ps1');

function disabledByEnv() {
  const v = String(process.env.TOKEN_GUARD_TRAY || '').toLowerCase();
  return v === 'off' || v === '0' || v === 'false';
}

/**
 * @param {{spawnFn?:Function, platform?:string, cfg?:object}} [deps] seams de teste
 * @returns {{started:boolean, skipped?:string, reason?:string}}
 */
function ensure(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { started: false, skipped: 'bandeja só existe no Windows' };
  if (disabledByEnv()) return { started: false, skipped: 'TOKEN_GUARD_TRAY=off' };
  let cfg;
  try { cfg = deps.cfg || CFG.load(require('os').homedir()); } catch (err) { return { started: false, reason: err.message }; }
  if (!cfg.ui || cfg.ui.tray === false) return { started: false, skipped: 'ui.tray desligado na config' };
  try {
    const child = (deps.spawnFn || spawn)('conhost.exe', [
      '--headless', 'powershell.exe', '-NoProfile', '-NonInteractive', '-STA',
      '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    ], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    if (child && child.on) child.on('error', () => {});
    if (child && child.unref) child.unref();
    return { started: true };
  } catch (err) {
    return { started: false, reason: err.message };
  }
}

module.exports = { ensure, SCRIPT, disabledByEnv };
