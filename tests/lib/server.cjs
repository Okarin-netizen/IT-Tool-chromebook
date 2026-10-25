// Static file server for the tests. Serves the repository under /IT-Tool-chromebook/, the same
// path as GitHub Pages, so service worker scopes match the real site.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = "/IT-Tool-chromebook/";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".pfb": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// The tools only register their service worker on https. localhost is just as secure,
// so the check is switched off here (the files in the repository are not changed).
const patchJs = (text) => text.replaceAll('location.protocol === "https:"', "true");

function startServer(root, { port = 0 } = {}) {
  let offline = false;
  const server = http.createServer((req, res) => {
    // "Offline": drop the connection so fetch() fails like it does without a network.
    if (offline) return req.socket.destroy();
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(302, { Location: BASE });
      return res.end();
    }
    let file = path.join(root, decodeURIComponent(url.pathname.slice(BASE.length)));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { Location: `${url.pathname}/` });
        return res.end();
      }
      file = path.join(file, "index.html");
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(file);
    let body = fs.readFileSync(file);
    if (ext === ".js" || ext === ".mjs" || ext === ".html") body = Buffer.from(patchJs(body.toString("utf8")));
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://localhost:${server.address().port}${BASE}`,
        port: server.address().port,
        setOffline: (value) => { offline = value; },
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

module.exports = { startServer, BASE };
