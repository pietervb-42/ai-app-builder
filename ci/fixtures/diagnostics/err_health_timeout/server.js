const http = require("http");
const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    // Intentionally never end response.
    res.setHeader("content-type","application/json");
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {});
