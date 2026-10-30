(function () {
  "use strict";

  /* ---------- copiar comandos ---------- */
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-c");
      function done() {
        var old = btn.textContent;
        btn.textContent = "copiado";
        setTimeout(function () { btn.textContent = old; }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else { done(); }
    });
  });

  /* ---------- capítulos do vídeo ---------- */
  document.querySelectorAll("[data-seek]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var v = document.querySelector("video");
      if (!v) return;
      v.currentTime = parseFloat(btn.getAttribute("data-seek"));
      v.scrollIntoView({ block: "center" });
      v.focus();
    });
  });

  /* ---------- apresentar ---------- */
  var SCENES = [
    { kicker: "economia de contexto", titulo: "A janela do seu agente não é lixeira",
      texto: "O token-guard mede o custo real do repositório em tokens e barra a chamada que estoura a janela.",
      audio: "audio/cena-1.m4a" },
    { kicker: "o problema", titulo: "Cada linha é faturada",
      texto: "Busca sem escopo, arquivo gigante lido inteiro, pasta de dependências na janela. Tudo é relido a cada chamada.",
      audio: "audio/cena-2.m4a" },
    { kicker: "como barra", titulo: "Todo bloqueio ensina",
      texto: "O token-guard devolve a alternativa barata, pronta para reexecutar. Nunca um não sem saída.",
      linhas: "Read BigService.java\nDENY blindRead: 200 KB, sem faixa de linhas\nFAÇA ISTO: grep -n e leia 80 linhas\nRead BigService.java offset=40 limit=80\nALLOW",
      audio: "audio/cena-3.m4a" },
    { kicker: "configuração", titulo: "Uma tela para decidir",
      texto: "Liga ou desliga o bloqueio em tudo, ou só em um IDE, e mostra o que já foi poupado.",
      audio: "audio/cena-4.m4a" },
    { kicker: "onde funciona", titulo: "Funciona onde você trabalha",
      texto: "Claude Code, Copilot, Codex, Cursor e, por MCP, os demais editores.",
      audio: "audio/cena-5.m4a" },
    { kicker: "medido", titulo: "Medido, não prometido",
      texto: "No replay de 371 sessões reais, 190 chamadas caras foram barradas. No Claude Code, cada decisão leva 1,4 ms.",
      audio: "audio/cena-6.m4a" },
    { kicker: "instalar", titulo: "Zero dependências. Se algo falha, libera.",
      texto: "npx @allansantos-dev/token-guard init",
      audio: "audio/cena-7.m4a" }
  ];

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var btn = document.getElementById("present-btn");
  if (!btn) return;

  var root = document.createElement("div");
  root.className = "pres";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Apresentação do token-guard");
  root.innerHTML =
    '<div class="pres-stage" aria-live="polite"></div>' +
    '<div class="pres-bar">' +
    '<button type="button" data-a="prev" aria-label="Cena anterior">&#9664;</button>' +
    '<button type="button" data-a="play" aria-label="Pausar ou continuar">pausar</button>' +
    '<button type="button" data-a="next" aria-label="Próxima cena">&#9654;</button>' +
    '<button type="button" data-a="close" aria-label="Fechar apresentação">fechar (Esc)</button>' +
    '<span class="pres-count"></span></div>';
  document.body.appendChild(root);

  var stage = root.querySelector(".pres-stage");
  var count = root.querySelector(".pres-count");
  var playBtn = root.querySelector('[data-a="play"]');
  var audio = new Audio();
  var idx = 0;
  var playing = true;
  var lastFocus = null;

  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function show(i) {
    idx = Math.max(0, Math.min(SCENES.length - 1, i));
    var s = SCENES[idx];
    stage.innerHTML =
      '<div class="' + (reduced ? "" : "pres-scene") + '">' +
      '<div class="pres-kicker">' + esc(s.kicker) + '</div>' +
      '<div class="pres-title">' + esc(s.titulo) + '</div>' +
      '<p class="pres-text">' + esc(s.texto) + '</p>' +
      (s.linhas ? '<div class="pres-lines">' + esc(s.linhas) + '</div>' : '') +
      '</div>';
    count.textContent = (idx + 1) + " / " + SCENES.length;
    audio.src = s.audio;
    if (playing) { var p = audio.play(); if (p && p.catch) p.catch(function () { setPlaying(false); }); }
  }

  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? "pausar" : "continuar";
    if (!on) audio.pause();
    else { var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
  }

  audio.addEventListener("ended", function () {
    if (idx < SCENES.length - 1) show(idx + 1); else setPlaying(false);
  });

  function open() {
    lastFocus = document.activeElement;
    root.classList.add("on");
    playing = true;
    playBtn.textContent = "pausar";
    show(0);
    playBtn.focus();
  }
  function close() {
    root.classList.remove("on");
    audio.pause();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  btn.addEventListener("click", open);
  root.addEventListener("click", function (e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
    if (a === "prev") show(idx - 1);
    else if (a === "next") show(idx + 1);
    else if (a === "play") setPlaying(!playing);
    else if (a === "close") close();
  });
  document.addEventListener("keydown", function (e) {
    if (!root.classList.contains("on")) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(idx + 1);
    else if (e.key === "ArrowLeft") show(idx - 1);
    else if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); setPlaying(!playing); }
  });
})();
