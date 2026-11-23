# Zed: `context_servers` no settings.json (2026-11-23)

Fontes primárias, todas acessadas em 2026-11-23. Cada afirmação abaixo vem de uma delas.

## Onde fica o arquivo

Fonte: documentação "Configuring Zed", seção *User Settings*
(https://zed.dev/docs/configuring-zed, que hoje redireciona para https://zed.dev/docs/reference/all-settings;
o texto da seção está em
https://raw.githubusercontent.com/zed-industries/zed/main/docs/src/configuring-zed.md):

- macOS: `~/.config/zed/settings.json`
- Linux: `~/.config/zed/settings.json` (ou `$XDG_CONFIG_HOME/zed/settings.json`)
- Windows: `%APPDATA%\Zed\settings.json`

Confirmação no código: `config_dir()` e `settings_file()` em
https://raw.githubusercontent.com/zed-industries/zed/main/crates/paths/src/paths.rs
(macOS `~/.config/zed`; Linux `$XDG_CONFIG_HOME/zed`; Windows `%APPDATA%\Zed`; `settings_file()` é
`config_dir().join("settings.json")`). A página de atalhos (https://zed.dev/docs/key-bindings) dá o mesmo diretório
para o `keymap.json`: `~/.config/zed/` em macOS e Linux, `~\AppData\Roaming\Zed` no Windows.

O settings de projeto (`.zed/settings.json`) existe, mas fica fora do medidor, pelo mesmo motivo do
`.mcp.json` do projeto: medir executa servidores, e arquivo que viaja no repositório não pode escolher o que roda.

## Formato do arquivo

JSONC. A documentação diz "The syntax is JSON with support for `//` comments"
(configuring-zed.md, acima). O leitor real é permissivo além disso: `parse_json_with_comments` usa
`serde_json_lenient` (https://raw.githubusercontent.com/zed-industries/zed/main/crates/settings_json/src/settings_json.rs,
função em torno da linha 782; dependência declarada em
https://raw.githubusercontent.com/zed-industries/zed/main/crates/settings/Cargo.toml), que, segundo
https://docs.rs/serde_json_lenient/latest/serde_json_lenient/ (v0.2.4), aceita comentários `/* */` e `//` e vírgula
final em objetos e arrays. A página https://zed.dev/docs/languages/json descreve JSONC como superconjunto de JSON com
comentários de linha.

## Forma de uma entrada de `context_servers`

Documentação atual, "As Custom Servers" (https://zed.dev/docs/ai/mcp; fonte em
https://raw.githubusercontent.com/zed-industries/zed/main/docs/src/ai/mcp.md):

```json
{
  "context_servers": {
    "local-mcp-server": { "command": "some-command", "args": ["arg-1", "arg-2"], "env": {} },
    "remote-mcp-server": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer <token>" } },
    "remote-mcp-server-with-oauth": { "url": "https://mcp.example.com/mcp" }
  }
}
```

O esquema em
https://raw.githubusercontent.com/zed-industries/zed/main/crates/settings_content/src/project.rs
(`ContextServerSettingsContent`, enum `untagged`) tem três variantes, todas com `enabled` (padrão `true`):

- `Stdio`: `command` (string), `args` (padrão vazio), `env` opcional, `timeout`, `remote`. Forma plana.
- `Http`: `url`, `headers`, `timeout`, `oauth`.
- `Extension`: só `settings` (o comando vem da extensão, não do arquivo).

Forma antiga, ainda comum em settings de quem configurou há tempo: `command` como objeto
`{ "path", "args", "env" }`, com `"source": "custom"`. Aparece na documentação da v0.192.8
(https://raw.githubusercontent.com/zed-industries/zed/v0.192.8/docs/src/ai/mcp.md) e já está plana na v0.205.7
(https://raw.githubusercontent.com/zed-industries/zed/v0.205.7/docs/src/ai/mcp.md). A documentação atual não cita
a forma de objeto; o medidor a aceita porque o arquivo do usuário pode tê-la de antes da migração.

## Decisões que isto sustenta

- Caminhos relativos ao HOME, como os demais: `.config/zed/settings.json` e `AppData/Roaming/Zed/settings.json`
  (o padrão do `%APPDATA%`). Um `XDG_CONFIG_HOME` ou `%APPDATA%` redefinido fica de fora.
- Servidor com `enabled: false` não é listado: o Zed não o sobe, logo ele não custa preâmbulo e o medidor não deve
  executá-lo.
- Entrada de extensão (sem `command` nem `url`) aparece como transporte `desconhecido`: existe, mas o comando não
  está no arquivo.
