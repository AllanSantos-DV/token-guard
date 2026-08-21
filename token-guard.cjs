#!/usr/bin/env node
'use strict';
/**
 * token-guard.cjs — shim de compatibilidade.
 *
 * A implementação vive em adapters/hook-cmd.cjs desde a 2.0.0. Este arquivo é
 * mantido porque instalações antigas registraram literalmente
 * `node .github/token-guard/token-guard.cjs` no hooks.json, e um upgrade não
 * pode quebrar quem já estava rodando.
 */

require('./adapters/hook-cmd.cjs');
