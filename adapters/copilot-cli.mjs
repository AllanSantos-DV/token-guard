import { joinSession } from "@github/copilot-sdk/extension";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * copilot-cli.mjs — adapter do GitHub Copilot CLI / Copilot App (modo PLUGIN).
 *
 * Roda a MESMA decisão do hook de comando, mas in-process: a extensão já está
 * viva, então não há spawn de Node a cada chamada de ferramenta. É a diferença
 * entre pagar ~300 ms por tool call e pagar praticamente zero.
 *
 * Envelope de entrada: { toolName, toolArgs, workingDirectory }  (SDK do Copilot)
 * Contrato de saída:   { permissionDecision, permissionDecisionReason }
 *
 * Escopo: esta máquina, todos os repositórios. Para que o time inteiro herde a
 * economia ao clonar, instale também no repositório: `npx token-guard init`.
 *
 * Este arquivo é APENAS tradução de envelope. Toda regra vive em lib/.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const { decide } = require("../lib/decide.cjs");
const CFG = require("../lib/config.cjs");
const AUDIT = require("../lib/audit.cjs");

let blocked = 0;
const byRule = Object.create(null);

const session = await joinSession({
  tools: [
    {
      name: "token_audit",
      description:
        "Mede o custo de contexto de um repositório: arquivos, volume, tokens, " +
        "quantas janelas de contexto ele ocupa, quanto é ruído de build/dependência " +
        "e quanto custa apenas listar os nomes dos arquivos. Também grava o cache que " +
        "calibra os guardrails do token-guard. Use quando quiser saber por que uma " +
        "sessão está cara, antes de explorar um repositório desconhecido, ou para " +
        "comparar o antes e o depois de uma mudança de configuração.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Caminho do repositório a auditar. Padrão: o diretório de trabalho atual.",
          },
          format: {
            type: "string",
            enum: ["texto", "markdown", "json"],
            description: "Formato do relatório. Padrão: markdown (bom para colar em documento).",
          },
        },
      },
      handler: async (args) => {
        const root = args?.path ? path.resolve(args.path) : process.cwd();
        if (!fs.existsSync(root)) {
          return { textResultForLlm: `Caminho não encontrado: ${root}`, resultType: "failure" };
        }
        // In-process: dentro de um harness empacotado, process.execPath é o binário
        // do harness — não o Node — então subprocesso não seria confiável aqui.
        const cfg = CFG.load(root);
        const result = AUDIT.scan(root, cfg, { top: 10 });
        AUDIT.writeCache(root, result);

        if (args?.format === "json") {
          return JSON.stringify({ ...result.stats, ...result.derived }, null, 2);
        }
        if (args?.format === "texto") {
          return AUDIT.renderText(result, cfg, { configSource: cfg._source });
        }
        return AUDIT.renderMarkdown(result, cfg);
      },
    },
    {
      name: "token_guard_status",
      description:
        "Mostra a configuração ativa do token-guard neste repositório (modo, regras " +
        "habilitadas, limites, origem do arquivo de config) e quantas chamadas de " +
        "ferramenta foram barradas nesta sessão, por regra. Use para descobrir por que " +
        "uma chamada foi bloqueada, ou para conferir se o guard está ligado.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repositório a inspecionar. Padrão: o diretório de trabalho atual.",
          },
        },
      },
      handler: async (args) => {
        const root = args?.path || process.cwd();
        const cfg = CFG.load(root);
        const stats = CFG.repoStats(root);
        const on = Object.entries(cfg.rules || {})
          .filter(([, v]) => v !== false)
          .map(([k]) => k);

        const lines = [
          `modo: ${cfg.mode}`,
          `config: ${cfg._source}`,
          `regras ativas: ${on.join(", ") || "(nenhuma)"}`,
          `limite de leitura sem faixa: ${cfg.limits.readBytesWithoutRange} bytes`,
          `guarda de varredura a partir de: ${cfg.limits.minRepoFilesForScanGuard} arquivos`,
          stats
            ? `cache do repositório: ${Number(stats.totalFiles).toLocaleString("pt-BR")} arquivos medidos`
            : "cache do repositório: ausente — rode token_audit para calibrar os limites",
          "",
          `barrado nesta sessão: ${blocked}`,
        ];
        for (const [rule, n] of Object.entries(byRule)) lines.push(`  ${rule}: ${n}`);
        if (cfg.mode === "off") {
          lines.push("", 'ATENÇÃO: o guard está DESLIGADO (mode "off" ou TOKEN_GUARD=off).');
        }
        return lines.join("\n");
      },
    },
  ],

  hooks: {
    /**
     * A decisão vive em lib/decide.cjs, compartilhada com o hook de comando.
     * Falha aqui NUNCA bloqueia: um guard de economia não pode derrubar a sessão.
     */
    onPreToolUse: async (input) => {
      try {
        const verdict = decide(input);
        if (!verdict) return;
        blocked += 1;
        byRule[verdict.rule] = (byRule[verdict.rule] || 0) + 1;
        return {
          permissionDecision: verdict.decision,
          permissionDecisionReason: verdict.reason,
        };
      } catch {
        return; // fail-open, sempre
      }
    },
  },
});

try {
  const cfg = CFG.load(process.cwd());
  if (cfg.mode !== "off") {
    await session.log(`token-guard ativo (modo: ${cfg.mode})`, { ephemeral: true });
  }
} catch { /* log é cortesia, não requisito */ }
