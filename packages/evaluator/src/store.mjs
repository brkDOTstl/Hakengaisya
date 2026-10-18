import { DatabaseSync } from 'node:sqlite';
import { createPublicKey } from 'node:crypto';
import { assert, canonical, identifier, sha256 } from './contract.mjs';
import { buildProfiles } from './profiles.mjs';

export class Store {
  constructor(filename, registry = []) {
    this.db = new DatabaseSync(filename);
    this.registry = structuredClone(registry);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, model TEXT NOT NULL, public_key TEXT NOT NULL, enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, collection_id TEXT NOT NULL, report_id TEXT NOT NULL, client_id TEXT NOT NULL, digest TEXT NOT NULL, json TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(collection_id, report_id)); CREATE TABLE IF NOT EXISTS nonces (client_id TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(client_id, nonce));');
  }
  enroll({ id, collection_id, model, public_key }) {
    identifier(id); identifier(collection_id); identifier(model);
    assert(createPublicKey(public_key).asymmetricKeyType === 'ed25519', 'Use an Ed25519 public key');
    const prior = this.client(id);
    if (prior) { assert(prior.collection_id === collection_id && prior.model === model && prior.public_key === public_key, 'Client identity is already enrolled', 409); return; }
    this.db.prepare('INSERT INTO clients VALUES (?, ?, ?, ?, 1)').run(id, collection_id, model, public_key);
  }
  client(id) { return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id); }
  disable(id) { this.db.prepare('UPDATE clients SET enabled = 0 WHERE id = ?').run(id); }
  append(client, nonce, report, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM nonces WHERE expires < ?').run(now);
      assert(!this.db.prepare('SELECT nonce FROM nonces WHERE client_id = ? AND nonce = ?').get(client.id, nonce), 'Request already used', 409);
      const hash = sha256(canonical(report));
      const prior = this.db.prepare('SELECT digest FROM reports WHERE collection_id = ? AND report_id = ?').get(client.collection_id, report.report_id);
      assert(!prior || prior.digest === hash, 'Report identifier has conflicting content', 409);
      this.db.prepare('INSERT INTO nonces VALUES (?, ?, ?)').run(client.id, nonce, now + 600000);
      if (!prior) this.db.prepare('INSERT INTO reports (collection_id, report_id, client_id, digest, json, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(client.collection_id, report.report_id, client.id, hash, canonical(report), new Date(now).toISOString());
      this.db.exec('COMMIT');
      return !prior;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  projection() {
    const rows = this.db.prepare('SELECT collection_id, json FROM reports ORDER BY seq').all().map(row => ({ collection_id: row.collection_id, report: JSON.parse(row.json) }));
    return buildProfiles(rows, this.registry);
  }
  count() { return this.db.prepare('SELECT count(*) AS n FROM reports').get().n; }
  close() { this.db.close(); }
}
