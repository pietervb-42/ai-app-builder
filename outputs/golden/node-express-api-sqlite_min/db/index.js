const path = require('path');
const Database = require('better-sqlite3');

// DB file stored in this folder (user-api-v1/db/app.sqlite)
const dbPath = path.join(__dirname, 'app.sqlite');

// Create/open DB
const db = new Database(dbPath);

// Create table if it doesn't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// Read all users
function listUsers() {
  return db.prepare('SELECT id, name, email, created_at FROM users ORDER BY id ASC').all();
}

// Create a user
function createUser({ name, email }) {
  const stmt = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
  const result = stmt.run(name, email);

  return {
    id: result.lastInsertRowid,
    name,
    email
  };
}

module.exports = {
  db,
  listUsers,
  createUser
};
