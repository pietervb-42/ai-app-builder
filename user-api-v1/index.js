const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(express.json());

// root
app.get("/", (req, res) => {
  res.type("text").send("Hello World!");
});

// health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "user-api-v1",
    timestamp: new Date().toISOString(),
  });
});

// versioned API route
app.get("/api/v1/ping", (req, res) => {
  res.json({
    ok: true,
    message: "pong",
    version: "v1",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler (so unknown routes return JSON instead of default HTML)
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not Found",
    path: req.path,
  });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/health`);
  console.log(`Ping:   http://localhost:${port}/api/v1/ping`);
});
