/* Runs both end-to-end suites. Usage: npm test
 * Starts a tiny static server on port 8765 (needed by tests/e2e.js), runs
 * tests/e2e.js and tests/e2e-flows.js one after the other, and exits with
 * code 1 if either suite fails. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const run = (file, env) => new Promise(resolve => {
  const c = spawn(process.execPath, [path.join(root, file)], { stdio: 'inherit', env, cwd: root });
  c.on('close', code => resolve(code));
});

server.listen(8765, async () => {
  const env = Object.assign({}, process.env);
  const local = path.join(root, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js');
  if (!env.PDFLIB_PATH && fs.existsSync(local)) env.PDFLIB_PATH = local; // lets the preview test run without internet
  let failed = 0;
  for (const f of ['tests/e2e.js', 'tests/e2e-flows.js']) {
    console.log('\n=== ' + f + ' ===');
    const code = await run(f, env); // async spawn, so this server keeps answering the browser
    if (code !== 0) { failed++; console.log('FAILED: ' + f); }
  }
  server.close();
  process.exit(failed ? 1 : 0);
});
