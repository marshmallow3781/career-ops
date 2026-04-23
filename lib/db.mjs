/**
 * lib/db.mjs — MongoDB persistence layer for career-ops.
 *
 * Connection: lazy singleton MongoClient with Stable API v1 (strict +
 * deprecationErrors). Credentials assembled at runtime from env parts
 * so the full URI never lives on disk.
 *
 * All DB calls wrap in withRetry(): 3 attempts with exponential backoff
 * (1s, 5s, 30s). Transient network errors retry; non-retryable errors
 * (duplicate key, validation) fail fast.
 *
 * CRUD groups per collection: jobs, scan_runs, applications, reports,
 * cv_artifacts. See docs/superpowers/specs/2026-04-23-mongodb-persistence-design.md
 * for the document schemas.
 */
import { MongoClient, ServerApiVersion } from 'mongodb';

const REQUIRED_ENV = ['MONGODB_USER', 'MONGODB_PASSWORD', 'MONGODB_CLUSTER'];

/**
 * Assemble a mongodb+srv:// URI from env parts. Password URL-encoded so
 * any special chars (`@`, `/`, `:`) survive the URI parse.
 */
export function buildMongoUri(env = process.env) {
  for (const k of REQUIRED_ENV) {
    if (!env[k]) throw new Error(`buildMongoUri: missing env var ${k}`);
  }
  const user = encodeURIComponent(env.MONGODB_USER);
  const pass = encodeURIComponent(env.MONGODB_PASSWORD);
  const host = env.MONGODB_CLUSTER;
  const appName = env.MONGODB_APP_NAME || 'career-ops';
  return `mongodb+srv://${user}:${pass}@${host}/?retryWrites=true&w=majority&appName=${appName}`;
}
