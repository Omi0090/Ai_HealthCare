/**
 * mongoStore.js
 * -------------
 * The production data access layer: thin wrappers over Mongoose models with a
 * uniform, promise-based interface (see db/store.js for the contract).
 */
const { User, Provider, Member, Claim, Case, AuditLog, AlertRule } = require('../models');

const MODELS = { users: User, providers: Provider, members: Member, claims: Claim,
  cases: Case, auditlogs: AuditLog, alertrules: AlertRule };

const clean = (doc) => (doc && doc.toObject ? doc.toObject({ virtuals: false }) : doc);

/** Very small Mongo query-translation for the filters our API exposes. */
function buildMatch(collection, filter = {}) {
  const q = {};
  const { search, from, to, ...rest } = filter;
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null || v === '') continue;
    if (['$gte', '$lte', '$gt', '$lt'].some((op) => v[op] !== undefined)) {
      q[k] = { ...(q[k] || {}), ...v };
    } else {
      q[k] = v;
    }
  }
  if (from || to) {
    q.serviceDate = q.serviceDate || {};
    if (from) q.serviceDate.$gte = new Date(from);
    if (to) q.serviceDate.$lte = new Date(to);
  }
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ claimId: rx }, { providerName: rx }, { memberName: rx },
      { providerId: rx }, { memberId: rx }, { diagnosisName: rx }, { procedureCode: rx }];
  }
  return q;
}

function createMongoStore() {
  return {
    kind: 'mongodb',

    async insert(collection, docs) {
      const Model = MODELS[collection];
      const arr = Array.isArray(docs) ? docs : [docs];
      const res = await Model.insertMany(arr, { ordered: false });
      return res.map(clean);
    },

    async find(collection, filter = {}, opts = {}) {
      const { sort = { createdAt: -1 }, limit = 100, skip = 0, projection } = opts;
      let q = MODELS[collection].find(buildMatch(collection, filter), projection);
      q = q.sort(sort).skip(skip).limit(limit);
      return (await q.lean()).map(clean);
    },

    async findOne(collection, filter = {}) {
      return clean(await MODELS[collection].findOne(buildMatch(collection, filter)).lean());
    },

    async count(collection, filter = {}) {
      return MODELS[collection].countDocuments(buildMatch(collection, filter));
    },

    async updateOne(collection, filter, patch) {
      return clean(
        await MODELS[collection].findOneAndUpdate(buildMatch(collection, filter),
          { $set: patch }, { new: true })
      );
    },

    async pushToArray(collection, filter, field, value) {
      return clean(
        await MODELS[collection].findOneAndUpdate(buildMatch(collection, filter),
          { $push: { [field]: value } }, { new: true })
      );
    },

    async aggregate(collection, pipeline) {
      return MODELS[collection].aggregate(pipeline);
    },

    async deleteMany(collection, filter = {}) {
      return MODELS[collection].deleteMany(buildMatch(collection, filter));
    },

    async distinct(collection, field) {
      return MODELS[collection].distinct(field);
    },
  };
}

module.exports = { createMongoStore, buildMatch };
