const https = require('node:https');
const fs = require('node:fs');

const cert = fs.readFileSync(process.env.TLS_CERT, 'utf8');
const key = fs.readFileSync(process.env.TLS_KEY, 'utf8');

const server = https.createServer({ cert, key }, (req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        path: req.url,
        method: req.method,
        authorization: req.headers.authorization ?? null,
        apiKey: req.headers['x-api-key'] ?? null,
        body,
      }),
    );
  });
});

server.listen(443, '0.0.0.0', () => {
  process.stdout.write('test-upstream ready\n');
});
