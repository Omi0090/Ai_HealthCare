/**
 * memoryStore.js
 * --------------
 * A dependency-free, MongoDB-compatible document store backed by a JSON file.
 *
 * Why it exists: MongoDB is not always installed on a reviewer's machine, and a
 * final-year project must run with `npm install && npm start`. This store keeps
 * the exact same collection/document shapes as the Mongoose models and
 * implements the same query operators we use ($gte/$lte/$in/$regex/$or), so
 * every route and service is identical on both backends.
 *
 * Data is persisted to server/.data/db.json (debounced) so restarts keep state.
 *
 * NOT a replacement for MongoDB in production - it is a demo/sandbox fallback,
 * explicitly documented as such in the README.
 */
const fs = require('fs');
const path = require('path');

const COLLECTIONS = ['users', 'providers', 'members', 'claims', 'cases', 'auditlogs', 'alertrules'];

/**
 * The unique index of each collection, mirroring the Mongoose `unique: true`
 * declarations in models/index.js. Only these fields are checked for conflicts
 * (every other field, e.g. providerId on a claim, may legitimately repeat).
 */
const UNIQUE_KEYS = {
  users: ['email'],
  providers: ['providerId'],
  members: ['memberId'],
  claims: ['claimId'],
  cases: ['caseNumber'],
  alertrules: ['code'],
  auditlogs: [],
};

/** 24-char hex id, same shape as a MongoDB ObjectId, so the API is identical. */
function objectId() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return ts + rand;
}

class MemoryStore {
  constructor(file) {
    this.file = file;
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const c of COLLECTIONS) if (Array.isArray(parsed[c])) this.data[c] = parsed[c];
      }
      this._lastSync = this._mtime();
    } catch (err) {
      console.warn('[memoryStore] could not read db file, starting empty:', err.message);
      this._lastSync = 0;
    }
  }

  _mtime() {
    try { return fs.statSync(this.file).mtimeMs; } catch { return 0; }
  }

  /**
   * Pick up out-of-band writes.
   *
   * `npm run seed` rewrites the whole file from a separate process. Without this
   * check a running API would keep serving its own in-memory snapshot (and would
   * eventually clobber the fresh seed with stale rows). We compare the file's
   * mtime against the moment of our last load/persist and reload when the file is
   * newer - at most once every 2 seconds, so the read path stays cheap.
   */
  _maybeReload() {
    const now = Date.now();
    if (now - (this._lastCheck || 0) < 2000) return;
    this._lastCheck = now;
    const m = this._mtime();
    if (m && m > (this._lastSync || 0) + 100) {
      console.log('[memoryStore] data file changed on disk - reloading');
      this._load();
    }
  }

  _persist() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data));
        this._lastSync = this._mtime();
      } catch (err) {
        console.warn('[memoryStore] persist failed:', err.message);
      }
    }, 400);
  }

  persistSync() {
    try {
      clearTimeout(this._timer);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this._lastSync = this._mtime();
    } catch (err) {
      console.warn('[memoryStore] persist failed:', err.message);
    }
  }

  /* ------------------------------------------------------- query engine */
  static matches(doc, filter = {}) {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$or') {
        if (!cond.some((sub) => MemoryStore.matches(doc, sub))) return false;
        continue;
      }
      if (key === '$and') {
        if (!cond.every((sub) => MemoryStore.matches(doc, sub))) return false;
        continue;
      }
      const value = key.split('.').reduce((o, p) => (o == null ? o : o[p]), doc);
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
        const ops = Object.keys(cond);
        const isOperator = ops.every((o) => o.startsWith('$'));
        if (isOperator) {
          for (const [op, target] of Object.entries(cond)) {
            const a = value instanceof Date ? value.getTime() : value;
            const b = target instanceof Date ? target.getTime() : target;
            switch (op) {
              case '$gte': if (!(a >= b)) return false; break;
              case '$lte': if (!(a <= b)) return false; break;
              case '$gt': if (!(a > b)) return false; break;
              case '$lt': if (!(a < b)) return false; break;
              case '$ne': if (a === b) return false; break;
              case '$in': if (!target.includes(value)) return false; break;
              case '$nin': if (target.includes(value)) return false; break;
              case '$exists': if ((value !== undefined) !== target) return false; break;
              case '$regex': if (!new RegExp(target, cond.$options || '').test(String(value))) return false; break;
              default: break;
            }
          }
          continue;
        }
      }
      if (cond instanceof RegExp) {
        if (!cond.test(String(value))) return false;
      } else if (value !== cond) return false;
    }
    return true;
  }

  static sortDocs(docs, sort = {}) {
    const entries = Object.entries(sort);
    if (!entries.length) return docs;
    return [...docs].sort((a, b) => {
      for (const [k, dir] of entries) {
        const av = k.split('.').reduce((o, p) => (o == null ? o : o[p]), a);
        const bv = k.split('.').reduce((o, p) => (o == null ? o : o[p]), b);
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        if (an === bn) continue;
        if (an === undefined || an === null) return 1;
        if (bn === undefined || bn === null) return -1;
        if (typeof an === 'string' || typeof bn === 'string') {
          return String(an).localeCompare(String(bn)) * dir;
        }
        return (an < bn ? -1 : 1) * dir;
      }
      return 0;
    });
  }

  _coll(name) {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  /* --------------------------------------------------------- interface */
  async insert(collection, docs) {
    const arr = (Array.isArray(docs) ? docs : [docs]).map((d) => ({
      _id: d._id || objectId(),
      ...d,
      createdAt: d.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const coll = this._coll(collection);
    const conflicts = [];
    for (const doc of arr) {
      const uniqueKeys = UNIQUE_KEYS[collection] || [];
      const hit = uniqueKeys
        .filter((k) => doc[k] !== undefined)
        .some((k) => coll.some((existing) => existing[k] === doc[k]));
      if (hit) { conflicts.push(doc); continue; }
      coll.push(doc);
    }
    this._persist();
    if (conflicts.length) {
      const err = new Error(`duplicate key on ${collection}`);
      err.duplicates = conflicts;
      // Mongo's insertMany({ordered:false}) inserts the rest and rejects;
      // mirror that so seeding is idempotent.
      err.inserted = arr.length - conflicts.length;
      if (conflicts.length === arr.length) throw err;
    }
    return arr;
  }

  async find(collection, filter = {}, opts = {}) {
    this._maybeReload();
    const { sort = { createdAt: -1 }, limit = 100, skip = 0 } = opts;
    let out = this._coll(collection).filter((d) => MemoryStore.matches(d, filter));
    out = MemoryStore.sortDocs(out, sort);
    return out.slice(skip, skip + limit).map((d) => ({ ...d }));
  }

  async findOne(collection, filter = {}) {
    this._maybeReload();
    const hit = this._coll(collection).find((d) => MemoryStore.matches(d, filter));
    return hit ? { ...hit } : null;
  }

  async count(collection, filter = {}) {
    this._maybeReload();
    return this._coll(collection).filter((d) => MemoryStore.matches(d, filter)).length;
  }

  async updateOne(collection, filter, patch) {
    const coll = this._coll(collection);
    const idx = coll.findIndex((d) => MemoryStore.matches(d, filter));
    if (idx < 0) return null;
    coll[idx] = { ...coll[idx], ...patch, updatedAt: new Date().toISOString() };
    this._persist();
    return { ...coll[idx] };
  }

  async pushToArray(collection, filter, field, value) {
    const coll = this._coll(collection);
    const idx = coll.findIndex((d) => MemoryStore.matches(d, filter));
    if (idx < 0) return null;
    coll[idx][field] = [...(coll[idx][field] || []), value];
    coll[idx].updatedAt = new Date().toISOString();
    this._persist();
    return { ...coll[idx] };
  }

  /** Tiny aggregation subset: $match, $group (sum/avg/min/max/count), $sort, $limit. */
  async aggregate(collection, pipeline) {
    this._maybeReload();
    let rows = this._coll(collection).map((d) => ({ ...d }));
    for (const stage of pipeline) {
      if (stage.$match) {
        rows = rows.filter((d) => MemoryStore.matches(d, stage.$match));
      } else if (stage.$group) {
        const { _id, ...acc } = stage.$group;
        const groups = new Map();
        const idOf = (d) => (typeof _id === 'string' && _id.startsWith('$')
          ? d[_id.slice(1)]
          : typeof _id === 'object' && _id !== null
            ? JSON.stringify(Object.fromEntries(Object.entries(_id).map(([k, v]) => [k, String(v).startsWith('$') ? d[String(v).slice(1)] : v])))
            : _id);
        for (const d of rows) {
          const key = idOf(d);
          if (!groups.has(key)) groups.set(key, { _id: JSON.parse(key && key.startsWith('{') ? key : JSON.stringify(key)), __rows: [] });
          groups.get(key).__rows.push(d);
        }
        rows = [...groups.values()].map(({ _id: gid, __rows }) => {
          const out = { _id: gid };
          for (const [field, spec] of Object.entries(acc)) {
            if (spec && spec.$sum !== undefined) {
              out[field] = __rows.reduce((s, d) => s + (typeof spec.$sum === 'number' ? spec.$sum : Number(d[String(spec.$sum).slice(1)]) || 0), 0);
            } else if (spec && spec.$avg !== undefined) {
              const vals = __rows.map((d) => Number(d[String(spec.$avg).slice(1)]) || 0);
              out[field] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
            } else if (spec && spec.$max !== undefined) {
              out[field] = Math.max(...__rows.map((d) => Number(d[String(spec.$max).slice(1)]) || 0));
            } else if (spec && spec.$min !== undefined) {
              out[field] = Math.min(...__rows.map((d) => Number(d[String(spec.$min).slice(1)]) || 0));
            }
          }
          return out;
        });
      } else if (stage.$sort) {
        rows = MemoryStore.sortDocs(rows, stage.$sort);
      } else if (stage.$limit) {
        rows = rows.slice(0, stage.$limit);
      }
    }
    return rows;
  }

  async deleteMany(collection, filter = {}) {
    const before = this._coll(collection).length;
    this.data[collection] = this._coll(collection).filter((d) => !MemoryStore.matches(d, filter));
    this._persist();
    return { deletedCount: before - this.data[collection].length };
  }

  async distinct(collection, field) {
    this._maybeReload();
    return [...new Set(this._coll(collection).map((d) => d[field]).filter((v) => v !== undefined))];
  }
}

module.exports = { MemoryStore };
