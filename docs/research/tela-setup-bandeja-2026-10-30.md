# Tela de setup e bandeja do daemon: escolha final

Data: 2026-10-30. Fontes lidas em 2026-10-30.

## Fontes

- NotifyIcon (ícone na área de notificação; precisa de `Icon` e `Visible = true`; `Text` é a dica):
  <https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon?view=windowsdesktop-8.0>.
  A página não informa o limite de `Text`; o código corta em 63 caracteres por prudência (⚠️ limite não verificado na fonte).
- Server-Sent Events (fluxo de texto UTF-8, `event:`/`data:`, reconexão automática, `retry`, comentário com `:`):
  <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>.
  A página não mostra header customizado no `EventSource`: por isso a tela usa cookie de sessão e o ícone (que não é navegador) usa o header de token.
- Cookie `HttpOnly` e `SameSite=Strict`: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies>.

## Decisão

1. **Ícone: helper PowerShell 5.1 com `NotifyIcon`.** Sem dependência (o Windows traz), sem binário no pacote. Alternativas descartadas:
   Electron/pacote npm de bandeja (viola "zero dependências em runtime"), executável .NET compilado (binário para assinar e distribuir).
2. **Tela: página servida pelo daemon existente, por http local**, no mesmo servidor do hook http. Alternativa descartada: app desktop próprio
   (segundo processo residente, segunda porta).
3. **Empurrado por SSE, não consultado.** A tela usa `EventSource`; o ícone lê o mesmo fluxo com `HttpWebRequest` numa thread de fundo.
4. **Entrada por bilhete de uso único + cookie**, porque o navegador não manda o header do token e o token não pode ir para a URL.

## Achados medidos nesta construção (não estavam nas fontes)

- `conhost.exe --headless` **não executa o filho quando o stdin é NUL** (`spawn` do Node com `stdio: 'ignore'`): o processo sai com 0 e nada roda.
  Com stdin em pipe roda. Medido com `cmd.exe /c echo` e com o próprio `tray.ps1`.
- O ícone novo do Windows 11 vai para o menu de ícones ocultos; ele não aparece em UI Automation nem na faixa visível da barra de tarefas.
  A verificação lê o que o ícone mostra por `-StatusFile` (estado, título, dica e o PNG entregue ao Windows).
- `$reader.Stop()` de um runspace preso em leitura de rede bloqueante só volta quando o daemon fecha o fluxo: "Fechar o ícone" deixava o processo vivo.
  O script termina com `[Environment]::Exit(0)`.
- `-WindowStyle Hidden` do PowerShell não impede o console de piscar; por isso `conhost --headless`.
