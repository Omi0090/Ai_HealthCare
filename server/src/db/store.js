/**
 * store.js
 * --------
 * Chooses the data backend at boot:
 *   1. MongoDB via Mongoose when MONGO_URI is reachable (production path)
 *   2. The JSON-backed MemoryStore otherwise (demo/reviewer path)
 *
 * Both satisfy the same async interface, so no route or service needs to know
 * which one is live. `store.kind` reports it to /api/health.
 */
const path = require('path');
const mongoose = require('mongoose');
const { createMongoStore } = require('./mongoStore');
const { MemoryStore } = require('./memoryStore');

let store = null;

async function initStore() {
  const uri = process.env.MONGO_URI;
  if (uri && process.env.FORCE_MEMORY !== 'true') {
    try {
      mongoose.set('strictQuery', true);
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
        maxPoolSize: 20,
      });
      store = createMongoStore();
      store.kind = 'mongodb';
      store.persistSync = () => {};
      console.log(`[db] connected to MongoDB at ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
      return store;
    } catch (err) {
      console.warn(`[db] MongoDB unavailable (${err.message}). Falling back to local JSON store.`);
    }
  }
  const file = process.env.DATA_FILE || path.join(__dirname, '..', '..', '.data', 'db.json');
  store = new MemoryStore(file);
  console.log(`[db] using local JSON document store at ${file}`);
  console.log('[db] note: set MONGO_URI in .env to run against real MongoDB');
  return store;
}

function getStore() {
  if (!store) throw new Error('store not initialised - call initStore() first');
  return store;
}

async function closeStore() {
  if (store && store.kind === 'mongodb') await mongoose.disconnect();
  if (store && store.persistSync) store.persistSync();
}

module.exports = { initStore, getStore, closeStore };
