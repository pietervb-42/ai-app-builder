# Template: node-express-api-sqlite

## Purpose
A minimal Express API template with SQLite persistence.

## Includes
- Express server with middleware + logging
- Versioned routes: `/api/v1`
- Health endpoint: `/health`
- SQLite via `better-sqlite3`
- Users API:
  - GET `/api/v1/users`
  - POST `/api/v1/users`

## Database
- DB file created at `db/app.sqlite`
- Schema created on startup (users table)

## Run
```bash
npm install
npm start
