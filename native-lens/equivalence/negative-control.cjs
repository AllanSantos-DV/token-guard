'use strict';
/** Listener que responde sempre `{}`: o corredor de equivalência tem de reprová-lo. */
const http = require('http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"pid":1}'); }
  req.resume();
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
}).listen(port, '127.0.0.1', () => process.stdout.write(`READY port=${port} impl=always-empty\n`));
