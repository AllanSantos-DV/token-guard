// run.mjs — repete os casos de equivalência contra um listener do slice e compara com o `decide` real.
//
//   node run.mjs <cases.jsonl> --port N --token T [--json]
//
// Obrigatório: status 200, `body` igual (JSON, ordem de chaves livre) ao envelope real, e cabeçalho
// x-tg-rule igual à regra. Mais 12 checagens de protocolo (auth, rota, JSON inválido, keep-alive).
import fs from 'node:fs';
import http from 'node:http';

const [file] = process.argv.slice(2);
const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const port = Number(opt('port'));
const token = opt('token');
const asJson = process.argv.includes('--json');
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method, agent, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const auth = { 'x-token-guard': token };

const cases = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let mismatches = 0;
let reasonOnly = 0;
const reasonIds = [];
const failures = [];
for (const c of cases) {
  let r;
  try { r = await call('POST', '/token-guard/pre', c.payload, auth); } catch (e) { mismatches++; failures.push({ id: c.id, label: c.label, error: String(e) }); continue; }
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* fica null */ }
  const ruleOk = (r.headers['x-tg-rule'] || null) === c.expect.rule;
  const decisionOk = (body && body.hookSpecificOutput ? body.hookSpecificOutput.permissionDecision : null) === c.expect.decision;
  const exact = body !== null && same(body, c.expect.body);
  if (r.status !== 200 || !ruleOk || !decisionOk) {
    mismatches++;
    failures.push({ id: c.id, label: c.label, status: r.status, rule: r.headers['x-tg-rule'] || null, expectRule: c.expect.rule, decision: body && body.hookSpecificOutput ? body.hookSpecificOutput.permissionDecision : null, expectDecision: c.expect.decision });
  } else if (!exact) {
    reasonOnly++; reasonIds.push(c.id);
  }
}

const proto = [];
const check = (name, ok, detail) => proto.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
const h1 = await call('GET', '/token-guard/health', undefined, auth);
check('health com token = 200 e ok', h1.status === 200 && JSON.parse(h1.text).ok === true, h1);
const h2 = await call('GET', '/token-guard/health');
check('health sem token = 401', h2.status === 401, h2);
const p1 = await call('POST', '/token-guard/pre', {});
check('pre sem token = 401', p1.status === 401, p1);
const p2 = await call('POST', '/token-guard/pre', {}, { 'x-token-guard': `${token}x` });
check('pre com token errado = 401', p2.status === 401, p2);
const p3 = await call('POST', '/token-guard/pre', {}, auth);
check('pre com {} = 200 e {}', p3.status === 200 && same(JSON.parse(p3.text), {}), p3);
const p4 = await call('POST', '/token-guard/pre', 'não é json', auth);
check('pre com corpo inválido = 400', p4.status === 400, p4);
const p5 = await call('POST', '/token-guard/nada', {}, auth);
check('rota desconhecida = 404', p5.status === 404, p5);
const p6 = await call('GET', '/token-guard/pre', undefined, auth);
check('GET em pre = 404', p6.status === 404, p6);
const p7 = await call('POST', '/token-guard/pre', [1, 2, 3], auth);
check('pre com array = 200 e {} (fail-open)', p7.status === 200 && same(JSON.parse(p7.text), {}), p7);
const p8 = await call('POST', '/token-guard/pre', 'null', auth);
check('pre com null = 200 e {}', p8.status === 200 && same(JSON.parse(p8.text), {}), p8);
const big = await call('POST', '/token-guard/pre', { tool_name: 'Bash', tool_input: { command: 'x'.repeat(3_000_000) } }, auth);
check('corpo de 3 MB = 200 e {}', big.status === 200 && same(JSON.parse(big.text), {}), { status: big.status });
const pids = new Set();
for (let i = 0; i < 20; i++) { const h = await call('GET', '/token-guard/health', undefined, auth); pids.add(JSON.parse(h.text).pid ?? 'x'); }
check('20 health seguidos na mesma conexão', pids.size === 1, [...pids]);

const protoFail = proto.filter((p) => !p.ok);
const summary = { cases: cases.length, mismatches, reason_text_differs: reasonOnly, reason_text_ids: reasonIds.slice(0, 20), protocol_checks: proto.length, protocol_failures: protoFail.length };
agent.destroy();
if (asJson) console.log(JSON.stringify({ ...summary, failures: failures.slice(0, 40), protocol: protoFail }));
else {
  console.log(JSON.stringify(summary));
  for (const f of failures.slice(0, 15)) console.log('  ✗', JSON.stringify(f));
  for (const p of protoFail) console.log('  ✗ protocolo:', p.name, JSON.stringify(p.detail).slice(0, 200));
}
process.exit(mismatches || reasonOnly || protoFail.length ? 1 : 0);
