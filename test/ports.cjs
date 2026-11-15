'use strict';
/**
 * ports.cjs — porta livre para o daemon de teste subir nela.
 *
 * A porta 0 sai da faixa efêmera (Windows 49152+, Linux 32768+), que o sistema entrega em sequência
 * às conexões de saída de todos os processos da máquina: solta pelo teste e só reusada segundos depois
 * pelo daemon filho, outra conexão pode tomá-la antes e o daemon sobe em outra porta. Sorteando abaixo
 * das duas faixas, ninguém recebe essa porta sem pedi-la pelo número.
 */

const net = require('net');

const LOW = 20000;
const SPAN = 12000;

/** Devolve uma porta livre entre 20000 e 32000; lança se nenhuma tentativa achar uma. */
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const port = LOW + Math.floor(Math.random() * SPAN);
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error(`nenhuma porta livre entre ${LOW} e ${LOW + SPAN}`);
}

module.exports = { freePort };
