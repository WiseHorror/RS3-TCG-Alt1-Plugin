const fs = require("fs");
const http = require("http");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8081;
const ROOT = path.resolve(__dirname, "..");
const CATALOGUE_PATH = path.join(ROOT, "src", "generated-cards.json");
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function respond(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  response.end(body);
}

function saveCatalogue(request, response) {
  let body = "";
  let bytes = 0;
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) {
      respond(response, 413, "Catalogue is too large.");
      request.destroy();
      return;
    }
    body += chunk;
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    try {
      const cards = JSON.parse(body);
      if (!Array.isArray(cards)) throw new Error("Catalogue must be an array.");
      if (cards.length === 0) throw new Error("Refusing to replace the catalogue with an empty array.");
      const temporaryPath = `${CATALOGUE_PATH}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(cards, null, 2)}\n`);
      fs.renameSync(temporaryPath, CATALOGUE_PATH);
      respond(response, 200, JSON.stringify({ saved: cards.length }), "application/json; charset=utf-8");
    } catch (error) {
      respond(response, 400, error.message || "Invalid catalogue JSON.");
    }
  });
}

function serveFile(request, response) {
  const requestPath = decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
  const relativePath = requestPath === "/" ? "card-editor.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    respond(response, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      respond(response, error.code === "ENOENT" ? 404 : 500, "Not found");
      return;
    }
    respond(response, 200, contents, MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  });
}

http.createServer((request, response) => {
  const origin = request.headers.origin || "";
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS" && request.url === "/api/cards") {
    response.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    respond(response, 204, "");
    return;
  }
  if (request.method === "PUT" && request.url === "/api/cards") saveCatalogue(request, response);
  else if (request.method === "GET" && request.url === "/api/status") respond(response, 200, JSON.stringify({ ready: true }), "application/json; charset=utf-8");
  else if (request.method === "GET" || request.method === "HEAD") serveFile(request, response);
  else respond(response, 405, "Method not allowed");
}).listen(PORT, HOST, () => {
  console.log(`RuneScape TCG Card Editor: http://${HOST}:${PORT}/card-editor.html`);
});
