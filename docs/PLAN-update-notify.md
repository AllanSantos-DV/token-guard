# PLAN — Notificação de atualização disponível (update-notify)

```yaml
slug: update-notify
status: READY (implementado, 53 testes verdes, gate de revisão fechado — aguardando release v2.4.0)
request: (verbal, sem docs/REQUEST — feature pequena, contexto abaixo)
owner_scope: checagem explícita, sob demanda do usuário (cli.cjs status); NÃO toca hooks nem daemon
platform_target: win32 + POSIX, Node >=16 (matriz CI: 16/18/20/22 × ubuntu/windows)
semver_bump: minor (feature nova), 2.3.2 -> 2.4.0
```

---

## 1 · Contexto

**Pergunta que originou isto:** "usuario nao recebe informação pra atualizar??" —
confirmado por grep exaustivo: `cli.cjs` só imprime a versão local
(`--version`/`-v`/`version`, linhas 138-139); não existe em lugar nenhum do
código checagem de versão publicada no registry, nem aviso de drift. Três
cópias de token-guard já foram encontradas divergentes nesta máquina (registry
2.3.2, hook real instalado 2.3.0, global npm-link 2.2.2) sem qualquer sinal
visível ao usuário.

**Objetivo desta entrega:** dar ao usuário um sinal explícito, opt-out, de que
existe uma versão mais nova publicada — sem introduzir chamada de rede em
nenhum caminho quente (hooks, daemon). Checagem só roda quando o usuário
invoca `token-guard status` (ou `--version`), nunca em background.

**Reuso confirmado (lido antes de desenhar):**
- `lib/daemon-lifecycle.cjs` — padrão `REAL_DEPS`/`depsOverride` (fs/process
  injetáveis) já estabelecido e testado; replicado aqui para fs/http.
- `install.cjs:673` — `path.join(HOME, '.token-guard')` é o diretório global
  por-usuário já usado por `installMcp()`; reusado como base do cache, em vez
  do escopo por-repo `.token-guard` usado por `lib/audit.cjs`/`lib/config.cjs`/
  `lib/contract.cjs`/`lib/dupread.cjs`/`lib/postresult.cjs` (esses são
  per-repo, checagem de update é per-máquina).
- `test/dupread.test.cjs` — convenção de teste (helper `check(label, ok,
  detail)`, `fs.mkdtempSync`, cleanup `try{}catch{}`, resumo `pass/fail`,
  `process.exit`).
- `.github/workflows/ci.yml` — matriz `node: [16,18,20,22]` confirma: **sem
  `fetch` global** (instável/ausente <18), **sem dependência nova**
  (`package.json` não tem `dependencies`) → HTTP via módulo nativo `https`.
- `cli.cjs:42-65` (`status()`) — ponto de wiring: já imprime bloco formatado
  `console.log`, extensão natural sem quebrar layout existente.

**Fora de escopo (DECISION, registrado aqui, não em silêncio):**
- Checagem automática pelo daemon ou por qualquer um dos 3 hooks
  (`hook-cmd.cjs`, `prompt-hook.cjs`, `post-hook.cjs`) — isso introduziria
  I/O de rede não-determinística exatamente nos caminhos que hoje têm
  contrato de stdout byte-idêntico e testes de paridade/fault-tolerance
  extensos (F1-F7 do daemon-único). Fica de fora deliberadamente.
- Resolver a divergência das 3 cópias já instaladas nesta máquina (registry/
  hook-real/global-npm-link) — pergunta separada do usuário, ainda sem
  resposta; esta feature só torna essa divergência **visível**, não a corrige
  automaticamente.
- Auto-update / self-upgrade — fora de escopo total, feature é só de aviso.

---

## 2 · Desenho

### `lib/update-check.cjs` (núcleo puro + I/O injetável)

Funções puras (testáveis sem rede/disco):
- `compareVersions(a, b)` — comparação semver simples (major.minor.patch,
  sem pre-release/build metadata — suficiente pro registry npm). Retorna
  `-1|0|1`.
- `isStale(cache, now, ttlMs)` — decide se o cache em disco (ou ausente) já
  pode disparar nova consulta HTTP.
- `decide({localVersion, latestVersion})` — retorna
  `{updateAvailable:boolean, latestVersion}`.

I/O injetável via `REAL_DEPS` (mesmo padrão de `daemon-lifecycle.cjs`):
- `readCache(cacheFile)` / `writeCache(cacheFile, obj)` — fs síncrono,
  best-effort (falha de I/O aqui NUNCA deve quebrar `status`/`--version`).
- `fetchLatest(pkgName, timeoutMs)` — `https.get` no registry npm
  (`https://registry.npmjs.org/<pkg>/latest`), parseia `{version}`, timeout
  curto (2000ms padrão), qualquer erro (DNS, timeout, JSON inválido, 4xx/5xx)
  resolve `null` — nunca lança, nunca imprime stack pro usuário.

Função de orquestração (única impura exportada de alto nível):
```js
async function checkForUpdate({ localVersion, cacheFile, now = Date.now(), ttlMs = 86400000 } = {}, depsOverride) {
  const deps = { ...REAL_DEPS, ...depsOverride };
  if (process.env.TOKEN_GUARD_UPDATE_CHECK === 'off') return { checked: false, reason: 'disabled' };
  const cache = deps.readCache(cacheFile);
  if (cache && !isStale(cache, now, ttlMs)) {
    return decide({ localVersion, latestVersion: cache.latestVersion, ...(fromCache) });
  }
  const latestVersion = await deps.fetchLatest('@allansantos-dev/token-guard');
  if (!latestVersion) {
    // rede indisponível: devolve o cache antigo se existir (best-effort), senão "não checado"
    return cache ? decide({ localVersion, latestVersion: cache.latestVersion }) : { checked: false, reason: 'offline' };
  }
  deps.writeCache(cacheFile, { latestVersion, checkedAt: now });
  return decide({ localVersion, latestVersion });
}
```
(pseudocódigo do plano — implementação final ajusta nomes/shape conforme
teste, mas o contrato acima — fail-loud internamente via retorno explícito
`{checked:false, reason}`, nunca fallback mascarado — é vinculante.)

### Cache

`path.join(os.homedir(), '.token-guard', 'update-check.json')` — reusa o
diretório global já usado por `install.cjs`. Conteúdo:
```json
{ "latestVersion": "2.4.0", "checkedAt": 1758345600000 }
```
TTL padrão 24h (86400000 ms) — evita bater no registry a cada invocação de
`status`.

### Wiring em `cli.cjs`

- `status()` (linha 42-65): ao final do bloco atual, chama
  `checkForUpdate({localVersion: pkg.version, cacheFile})` de forma síncrona-
  bloqueante controlada (await no topo do handler — `status()` já não é hot
  path, é comando explícito do usuário). Se `updateAvailable`, imprime uma
  linha extra:
  ```
    atualização:    v2.4.0 disponível (você está na v2.3.2) — npm i -g @allansantos-dev/token-guard
  ```
  Se `checked:false` (offline, TTL não vencido sem novidade, ou
  `TOKEN_GUARD_UPDATE_CHECK=off`), NÃO imprime nada extra — silêncio, não
  erro, não placeholder.
- `--version`/`-v`/`version` (linha 138-141): mesma checagem, formato de uma
  linha extra só se `updateAvailable`:
  ```
  2.3.2 (nova versão disponível: 2.4.0 — npm i -g @allansantos-dev/token-guard)
  ```

### Escape hatch

`TOKEN_GUARD_UPDATE_CHECK=off` — mesma convenção de nome de
`TOKEN_GUARD_FORCE_PLATFORM` (prefixo `TOKEN_GUARD_`, valor `off` já é
convenção existente em `cfg.mode==='off'`/`TOKEN_GUARD=off`). Checado
primeiro, antes de qualquer I/O (nem lê cache, nem tenta rede).

---

## 3 · Testes — `test/update-check.test.cjs`

100% com deps mockadas — **zero chamada de rede real no `npm test`**. Estilo
`test/dupread.test.cjs`: helper `check()`, `fs.mkdtempSync`, resumo final.

Casos:
- A1 `compareVersions` — igual, local menor, local maior, cada posição
  (major/minor/patch).
- A2 `isStale` — cache ausente → stale; cache dentro do TTL → não-stale;
  cache expirado → stale.
- B1 cache ausente + fetch mock retorna versão nova → `updateAvailable:true`,
  cache é escrito.
- B2 cache válido (dentro do TTL) com versão igual à local → não bate rede
  (mock de fetch nunca chamado), `updateAvailable:false`.
- B3 cache expirado, fetch mock retorna versão igual à local →
  `updateAvailable:false`, cache reescrito com novo `checkedAt`.
- C1 fetch mock rejeita/erro (simula timeout/DNS) sem cache prévio →
  `{checked:false, reason:'offline'}`, sem lançar.
- C2 fetch mock rejeita, mas HÁ cache válido anterior → usa o cache antigo
  best-effort (`decide` com o `latestVersion` cacheado).
- D1 `TOKEN_GUARD_UPDATE_CHECK=off` → `{checked:false, reason:'disabled'}`,
  fetch mock e cache mock **nunca chamados** (assert de zero-invocação).
- E1 `writeCache`/`readCache` que lançam erro (disco cheio, permissão) não
  derrubam `checkForUpdate` — comportamento best-effort, resultado ainda
  coerente.

Wire em `package.json.scripts.test` (chain atual termina em
`daemon-faulttolerance.test.cjs`).

---

## 4 · Gate de revisão (regra CLAUDE.md #5)

Após implementação + testes verdes, rodada fresca e independente de:
- **reviewer** (coerência, referências fantasmas, ausência de fallback
  mascarado, uso correto do padrão `REAL_DEPS`).
- **tester** (testabilidade observável, casos de borda não cobertos,
  ambiguidade no contrato de retorno).

Loop até zero achado MAJOR+ — inclusive achados low/cosmético disparam NOVA
rodada após correção (regra ativa da sessão: nunca autocerrar tratando
correção como trivial).

---

## 5 · Release (v2.4.0)

Protocolo padrão (`plan-execution-discipline`), igual ao que fechou v2.3.2:
1. `chore(release): v2.4.0` — bump `package.json` + `CHANGELOG.md`, commit
   dedicado, último da versão.
2. `pack-smoke.mjs` (script curado) antes da tag.
3. Tag `v2.4.0` + push.
4. Acompanhar o workflow `Publish to npm` até sucesso real (linha
   `+ @allansantos-dev/token-guard@2.4.0` no log), não só `npm view`.
5. `README.md` — documentar o novo comportamento (`status`/`--version` agora
   avisam de update) e o opt-out `TOKEN_GUARD_UPDATE_CHECK=off`.

---

## 6 · Fora de escopo (repetido da seção 1, para rastreabilidade no fechamento)

- Auto-update.
- Checagem no daemon/hooks.
- Resolver a divergência das 3 cópias já instaladas nesta máquina — pendência
  separada do usuário.
