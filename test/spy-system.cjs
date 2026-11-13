'use strict';
/**
 * spy-system.cjs — preload (NODE_OPTIONS=--require) que impede um instalador de teste de executar comandos do
 * sistema (schtasks, setx, systemctl, launchctl...): registra a chamada em SPY_LOG e devolve sucesso.
 */
const cp = require('child_process');
const fs = require('fs');
const SYSTEM = new Set(['schtasks', 'setx', 'systemctl', 'launchctl', 'reg', 'conhost', 'conhost.exe', 'wscript', 'cscript', 'powershell', 'pwsh']);
const log = (file, args) => fs.appendFileSync(process.env.SPY_LOG, JSON.stringify({ file: String(file), args: args || [] }) + '\n');
const base = (f) => String(f).replace(/\.exe$/i, '').split(/[\\/]/).pop().toLowerCase();
const queryReply = (f, a) => (base(f) === 'schtasks' && a && a[0] === '/query' && process.env.SPY_TASKS_EXIST !== '1' ? 1 : 0);
for (const name of ['execFileSync', 'spawnSync']) {
  const real = cp[name];
  cp[name] = function (file, args, opts) {
    if (SYSTEM.has(base(file))) {
      log(file, Array.isArray(args) ? args : []);
      if (queryReply(file, args)) { const e = new Error('spy: tarefa inexistente'); e.status = 1; if (name === 'execFileSync') throw e; return { status: 1 }; }
      return name === 'execFileSync' ? Buffer.alloc(0) : { status: 0, stdout: '', stderr: '' };
    }
    return real.apply(this, arguments);
  };
}
for (const name of ['execSync', 'exec', 'execFile', 'spawn']) {
  const real = cp[name];
  cp[name] = function (file) {
    if (SYSTEM.has(base(String(file).split(' ')[0]))) { log(file, []); throw new Error('spy: ' + name + ' de comando do sistema nao permitido no teste'); }
    return real.apply(this, arguments);
  };
}
