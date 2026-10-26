#!/usr/bin/env node
'use strict';
/**
 * subagent-start.test.cjs — o SubagentStart do scout injeta o bloco `subagente` (P1)
 * e o instalador registra o hook e o agente sem pisar no que é do usuário.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SS = require('../adapters/subagent-start.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

const SRC = path.join(__dirname, '..');
const ADAPTER = path.join(SRC, 'adapters', 'subagent-start.cjs');
const INSTALL = path.join(SRC, 'install.cjs');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `tg-substart-${n}-`));

function runHook(cwd, env) {
  return spawnSync(process.execPath, [ADAPTER], {
    input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'scout', agent_id: 'a1', cwd }),
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000,
  });
}

console.log('\n  [hook]');
{
  const repo = tmp('repo');
  const r = runHook(repo);
  const out = JSON.parse(r.stdout || 'null');
  check('sai 0 e devolve additionalContext do evento SubagentStart',
    r.status === 0 && out?.hookSpecificOutput?.hookEventName === 'SubagentStart', r.stdout + r.stderr);
  const text = out?.hookSpecificOutput?.additionalContext || '';
  check('o texto é o bloco `subagente` do contrato (a resposta é o dado)', /A resposta é o dado/.test(text), text);
  check('não carrega regras de outros gatilhos (sempre/codigo)', !/Comentário registra invariante/.test(text), text);

  const custom = tmp('custom');
  fs.writeFileSync(path.join(custom, 'contract.md'), '## subagente\n\n- Só caminhos.\n', 'utf8');
  const c = JSON.parse(runHook(custom).stdout || 'null');
  check('contrato do repositório vence o default', /Só caminhos/.test(c?.hookSpecificOutput?.additionalContext || ''), JSON.stringify(c));

  const none = tmp('herda');
  fs.writeFileSync(path.join(none, 'contract.md'), '## sempre\n\n- Regra.\n', 'utf8');
  const n = runHook(none);
  check('contrato do repo sem bloco `subagente` herda o do default', n.status === 0 && /A resposta é o dado/.test(n.stdout), n.stdout + n.stderr);

  const off = runHook(repo, { TOKEN_GUARD: 'off' });
  check('TOKEN_GUARD=off: silêncio, sai 0', off.status === 0 && off.stdout === '', off.stdout + off.stderr);

  const bad = spawnSync(process.execPath, [ADAPTER], { input: 'não é json', encoding: 'utf8', timeout: 20000 });
  check('payload inválido: fail-open (sai 0, sem saída)', bad.status === 0 && bad.stdout === '', bad.stdout + bad.stderr);
  check('envelope(\'\') é null', SS.envelope('') === null);
}

console.log('\n  [instalação]');
function install(args, home) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}
{
  const repo = tmp('inst-repo');
  const home = tmp('inst-home');
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const agentPath = path.join(home, '.claude', 'agents', 'scout.agent.md');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
    SubagentStart: [{ matcher: 'outro', hooks: [{ type: 'command', command: 'node "C:/outro/sub.cjs"' }] }],
  } }), 'utf8');

  const r = install(['--target', 'claude', repo], home);
  check('instalação http sai 0', r.status === 0, r.stderr);
  const st = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const mine = (st.hooks.SubagentStart || []).filter((e) => JSON.stringify(e).includes('token-guard'));
  check('SubagentStart: 1 entrada do token-guard, matcher ancorado no scout, comando para subagent-start.cjs',
    mine.length === 1 && mine[0].matcher === '^scout$' && mine[0].hooks.length === 1 &&
    mine[0].hooks[0].type === 'command' && /subagent-start\.cjs/.test(mine[0].hooks[0].command), JSON.stringify(st.hooks.SubagentStart));
  check('hook de outro projeto no mesmo evento preservado', JSON.stringify(st.hooks.SubagentStart).includes('C:/outro/sub.cjs'));
  const agent = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf8') : '';
  check('scout instalado em ~/.claude/agents com tools de escrita negadas, maxTurns e effort',
    /^disallowedTools: Edit, Write, NotebookEdit$/m.test(agent) && /^maxTurns: \d+$/m.test(agent) && /^effort: medium$/m.test(agent), agent.slice(0, 400));

  const before = fs.readFileSync(settingsPath, 'utf8');
  install(['--target', 'claude', repo], home);
  check('reinstalar é idempotente (settings.json idêntico)', fs.readFileSync(settingsPath, 'utf8') === before);

  fs.writeFileSync(agentPath, agent.replace('maxTurns: 30', 'maxTurns: 1'), 'utf8');
  install(['--target', 'claude', repo], home);
  check('scout nosso desatualizado é atualizado pela reinstalação', fs.readFileSync(agentPath, 'utf8') === agent);

  fs.writeFileSync(agentPath, '---\nname: scout\ndescription: meu\n---\n# meu scout\n', 'utf8');
  install(['--target', 'claude', repo], home);
  check('agente homônimo do usuário é preservado', fs.readFileSync(agentPath, 'utf8').includes('# meu scout'));

  const cmd = install(['--target', 'claude', '--command-hooks', repo], home);
  check('modo comando sai 0', cmd.status === 0, cmd.stderr);
  const back = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const mine2 = (back.hooks.SubagentStart || []).filter((e) => JSON.stringify(e).includes('token-guard'));
  check('modo comando mantém exatamente 1 SubagentStart do token-guard', mine2.length === 1 && mine2[0].matcher === '^scout$', JSON.stringify(back.hooks.SubagentStart));

  for (const d of [repo, home]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n  [alvo repo (Copilot)]');
{
  const repo = tmp('repo-target');
  const home = tmp('repo-home');
  const r = install(['--target', 'repo', repo], home);
  const agent = path.join(repo, '.github', 'agents', 'scout.agent.md');
  const text = fs.existsSync(agent) ? fs.readFileSync(agent, 'utf8') : '';
  check('alvo repo instala o scout em .github/agents', r.status === 0 && /^name: scout$/m.test(text), r.stderr);
  check('o scout do alvo repo não leva os campos que só o Claude Code entende',
    !/^(?:disallowedTools|maxTurns|effort):/m.test(text) && /^description: /m.test(text) && /# Scout/.test(text), text.slice(0, 300));
  for (const d of [repo, home]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
