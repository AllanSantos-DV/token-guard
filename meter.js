(function () {
  "use strict";

  /* ---------- medidor interativo ---------- */
  var WINDOW_SEGS = 24;
  var win = document.getElementById("window");
  for (var i = 0; i < WINDOW_SEGS; i++) {
    var s = document.createElement("div");
    s.className = "seg";
    win.appendChild(s);
  }
  var segs = win.querySelectorAll(".seg");
  var verdictBox = document.getElementById("verdict");

  var CASES = [
    {
      label: 'glob "**/*"',
      deny: true,
      rule: "broadScan",
      msg: 'o padr\u00e3o "**/*" \u00e9 ilimitado em amplitude e tipo: devolve o caminho de ~215.112 arquivos.\nFA\u00c7A ISTO: limite por tipo ("**/*.java"), por diret\u00f3rio (paths=["src"]) ou por nome ("**/*Service*").',
      cost: 18
    },
    {
      label: "Read arquivo de 200KB",
      deny: true,
      rule: "blindRead",
      msg: '"BigService.java" tem 200 KB (~51k tokens, 25% da janela) e foi pedido sem faixa de linhas.\nFA\u00c7A ISTO: localize com uma busca restrita e releia a faixa relevante (40\u201380 linhas bastam).',
      cost: 12
    },
    {
      label: "Read node_modules/x.js",
      deny: true,
      rule: "noisePath",
      msg: 'o caminho cruza "node_modules", diret\u00f3rio de depend\u00eancia.\nFA\u00c7A ISTO: leia a fonte que produz o artefato, ou a declara\u00e7\u00e3o de tipos com um range. Caso leg\u00edtimo? allowlist.',
      cost: 8
    },
    {
      label: "ls -R /",
      deny: true,
      rule: "shellDump",
      msg: '"ls -R" percorre a \u00e1rvore sem filtro nem teto, e cada linha impressa vira contexto faturado.\nFA\u00c7A ISTO: use a ferramenta de busca do harness, ou filtre e limite ("| head -50").',
      cost: 15
    },
    {
      label: "grep com head_limit",
      deny: false,
      rule: null,
      msg: "OK \u2014 busca em modo conte\u00fado COM teto de resultado e filtro: a sa\u00edda \u00e9 limitada por constru\u00e7\u00e3o.\nO scan \u00e9 barato; o que entra na janela \u00e9 o teto que voc\u00ea pediu.",
      cost: 3
    }
  ];

  function render(caseIdx) {
    var c = CASES[caseIdx];

    segs.forEach(function (seg) { seg.className = "seg"; });
    // janela "usada" de base: system + tools do harness
    var base = 4;
    for (var b = 0; b < base && b < segs.length; b++) segs[b].classList.add("used");

    if (c.deny) {
      // o desperdício NÃO entra: mostra só o custo da alternativa barata
      for (var w = base; w < base + 2 && w < segs.length; w++) segs[w].classList.add("used");
    } else {
      for (var u = base; u < base + c.cost / 4 && u < segs.length; u++) segs[u].classList.add("used");
    }

    verdictBox.className = "verdict " + (c.deny ? "deny" : "pass");
    verdictBox.innerHTML =
      '<span class="tag">' + (c.deny ? "DENY · " + c.rule : "ALLOW") + "</span>\n" +
      document.createTextNode(c.msg).textContent;
  }

  var buttons = document.querySelectorAll(".trigger");
  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      buttons.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      render(parseInt(btn.getAttribute("data-i"), 10));
    });
  });

})();
