/**
 * Mongoose schemas for the MedGuard AI fraud-detection platform.
 *
 * These models are the source of truth used by `db/mongoStore.js` whenever a
 * MongoDB instance is reachable (MONGO_URI). When it is not - e.g. a reviewer
 * cloning the repo without MongoDB installed - `db/memoryStore.js` serves the
 * same documents from a JSON file with the same query semantics, so every
 * route, service and test behaves identically. Both stores implement the
 * interface in `db/store.js`.
 */
const mongoose = require('mongoose');

const { Schema, model, models } = mongoose;

/* ------------------------------------------------------------------ User */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'investigator', 'analyst', 'viewer'], default: 'analyst', index: true },
    department: { type: String, default: 'Special Investigation Unit' },
    phone: { type: String, default: '' },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------- Provider */
const providerSchema = new Schema(
  {
    providerId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    specialty: { type: String, required: true, index: true },
    city: String,
    state: { type: String, index: true },
    licenseNumber: String,
    licenseAgeYears: Number,
    inNetwork: { type: Boolean, default: true },
    fraudHistory: { type: Number, default: 0 },
    peerAvgBilled: Number,
    benchmarkCost: Number,
    ringMember: { type: Boolean, default: false },
    onWatchlist: { type: Boolean, default: false },
    riskScore: { type: Number, default: 0, index: true },
    claimsCount: { type: Number, default: 0 },
    flaggedCount: { type: Number, default: 0 },
    billedTotal: { type: Number, default: 0 },
    approvedTotal: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* ---------------------------------------------------------------- Member */
const memberSchema = new Schema(
  {
    memberId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    age: Number,
    gender: String,
    city: String,
    state: { type: String, index: true },
    planType: { type: String, index: true },
    policyAgeMonths: Number,
    chronicConditions: Number,
    annualPremium: Number,
    ringMember: { type: Boolean, default: false },
    riskScore: { type: Number, default: 0 },
    claimsCount: { type: Number, default: 0 },
    flaggedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* ----------------------------------------------------------------- Claim */
const claimSchema = new Schema(
  {
    claimId: { type: String, required: true, unique: true, index: true },
    providerId: { type: String, required: true, index: true },
    providerName: String,
    memberId: { type: String, required: true, index: true },
    memberName: String,

    claimType: { type: String, index: true },
    specialty: { type: String, index: true },
    procedureCode: String,
    diagnosisCode: String,
    diagnosisName: String,
    planType: String,
    state: { type: String, index: true },

    serviceDate: { type: Date, index: true },
    admissionDate: Date,
    dischargeDate: Date,
    submissionDate: Date,

    amountBilled: { type: Number, required: true },
    amountApproved: { type: Number, default: 0 },
    unitsClaimed: { type: Number, default: 1 },
    serviceDays: { type: Number, default: 1 },
    nightsInHospital: { type: Number, default: 0 },
    numProcedures: { type: Number, default: 1 },

    priorClaims30d: { type: Number, default: 0 },
    memberClaims12m: { type: Number, default: 0 },
    providerClaims30d: { type: Number, default: 0 },
    sameDayClaims: { type: Number, default: 0 },

    duplicateSimilarity: { type: Number, default: 0 },
    diagProcMatch: { type: Number, default: 1 },
    ageServiceMismatch: { type: Number, default: 0 },
    diagnosisSeverity: { type: Number, default: 0.4 },
    submissionLagDays: { type: Number, default: 3 },
    isWeekendSubmission: { type: Number, default: 0 },

    providerLicenseAgeYears: Number,
    providerFraudHistory: { type: Number, default: 0 },
    providerInNetwork: { type: Number, default: 1 },
    providerAvgBilled: Number,
    distanceKm: Number,

    memberAge: Number,
    chronicConditions: Number,
    policyAgeMonths: Number,
    annualPremium: Number,
    isEmergency: { type: Number, default: 0 },
    pharmacyQty: { type: Number, default: 1 },
    pharmacyRefillDays: { type: Number, default: 30 },

    specialtyAmountMean: Number,
    specialtyAmountStd: Number,

    // ---- model output -----------------------------------------------------
    riskScore: { type: Number, default: 0, index: true },
    fraudProbability: { type: Number, default: 0 },
    riskLevel: { type: String, default: 'minimal', index: true },
    isFlagged: { type: Boolean, default: false, index: true },
    anomalyScore: { type: Number, default: 0 },
    ruleScore: { type: Number, default: 0 },
    triggeredRules: { type: Array, default: [] },
    explanation: { type: Schema.Types.Mixed },
    modelScores: { type: Schema.Types.Mixed },
    modelVersion: { type: String, default: 'v1.0.0' },
    scoredAt: Date,
    scoringSource: { type: String, enum: ['ml-service', 'fallback-linear'], default: 'ml-service' },

    // ---- workflow ---------------------------------------------------------
    status: {
      type: String,
      enum: ['pending', 'flagged', 'under_review', 'approved', 'rejected', 'paid'],
      default: 'pending',
      index: true,
    },
    assignedTo: { type: String, default: null },
    notes: { type: Array, default: [] },

    // ---- ground truth (from the synthetic generator; in production this is
    //      the SIU outcome recorded after investigation) ---------------------
    groundTruth: {
      isFraud: { type: Boolean, default: null },
      archetype: { type: String, default: null },
      severity: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

claimSchema.index({ providerId: 1, serviceDate: -1 });
claimSchema.index({ memberId: 1, serviceDate: -1 });
claimSchema.index({ riskScore: -1, status: 1 });

/* ------------------------------------------------------------------ Case */
const caseSchema = new Schema(
  {
    caseNumber: { type: String, required: true, unique: true, index: true },
    claimId: { type: String, required: true, index: true },
    providerId: String,
    memberId: String,
    amountBilled: Number,
    riskScore: Number,
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium', index: true },
    status: {
      type: String,
      enum: ['open', 'investigating', 'escalated', 'closed'],
      default: 'open',
      index: true,
    },
    assignedTo: { type: String, default: null, index: true },
    decision: {
      type: String,
      enum: ['pending', 'confirmed_fraud', 'false_positive', 'insufficient_evidence'],
      default: 'pending',
    },
    recoverableAmount: { type: Number, default: 0 },
    findings: { type: String, default: '' },
    timeline: { type: Array, default: [] },
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
  },
  { timestamps: true }
);

/* -------------------------------------------------------------- AuditLog */
const auditSchema = new Schema(
  {
    actor: String,
    actorRole: String,
    action: { type: String, index: true },
    targetType: String,
    targetId: String,
    meta: { type: Schema.Types.Mixed },
    ip: String,
  },
  { timestamps: true }
);

/* ------------------------------------------------------------ AlertRule */
const ruleSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: String,
    description: String,
    category: String,
    enabled: { type: Boolean, default: true },
    weight: { type: Number, default: 10 },
    lift: { type: Number, default: 1 },
    hitRate: { type: Number, default: 0 },
    claimsFlagged: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const User = models.User || model('User', userSchema);
const Provider = models.Provider || model('Provider', providerSchema);
const Member = models.Member || model('Member', memberSchema);
const Claim = models.Claim || model('Claim', claimSchema);
const Case = models.Case || model('Case', caseSchema);
const AuditLog = models.AuditLog || model('AuditLog', auditSchema);
const AlertRule = models.AlertRule || model('AlertRule', ruleSchema);

module.exports = { User, Provider, Member, Claim, Case, AuditLog, AlertRule };
