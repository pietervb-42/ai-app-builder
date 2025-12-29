const express = require('express');
const { listUsers, createUser } = require('./db');

const app = express();
const port = process.env.PORT || 3000;

/**
 * Middleware
 */
app.use(express.json());

// Simple request logger
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });

  next();
});

/**
 * Base routes
 */
app.get('/', (req, res) => {
  res.type('text').send('User API v1 is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

/**
 * Versioned API routes
 */
const routerV1 = express.Router();

routerV1.get('/ping', (req, res) => {
  res.json({
    ok: true,
    message: 'pong',
    timestamp: new Date().toISOString()
  });
});

/**
 * USERS (DB-backed)
 */

// GET /api/v1/users (from SQLite)
routerV1.get('/users', (req, res, next) => {
  try {
    const users = listUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/users (insert into SQLite)
routerV1.post('/users', (req, res, next) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!name) {
      return res.status(400).json({ error: 'name is required (string)' });
    }

    if (!email) {
      return res.status(400).json({ error: 'email is required (string)' });
    }

    const created = createUser({ name, email });
    return res.status(201).json(created);
  } catch (err) {
    // Handle UNIQUE constraint (duplicate email)
    if (err && typeof err.message === 'string' && err.message.toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'email already exists' });
    }
    return next(err);
  }
});

app.use('/api/v1', routerV1);

/**
 * 404 handler (must be after routes)
 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl
  });
});

/**
 * Error handler (must be last)
 */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

/**
 * Start server
 */
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/health`);
  console.log(`Ping:   http://localhost:${port}/api/v1/ping`);
  console.log(`Users:  http://localhost:${port}/api/v1/users`);
});
