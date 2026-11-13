const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { getStore } = require('../db/store');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id || user.id), email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'Authentication required');
    const payload = jwt.verify(token, JWT_SECRET);
    const store = getStore();
    let user = null;
    if (store.kind === 'mongodb') {
      user = await User.findById(payload.sub).lean();
    } else {
      user = await store.findOne('users', { _id: payload.sub });
    }
    if (!user || user.active === false) throw new ApiError(401, 'Account inactive or not found');
    req.user = {
      id: String(user._id || user.id), name: user.name, email: user.email,
      role: user.role, department: user.department,
    };
    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return next(new ApiError(401, err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token'));
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new ApiError(403, `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.message || 'Internal server error',
    details: err.details,
    path: req.path,
  });
}

/** Writes an immutable audit trail entry for a privileged action. */
async function audit(req, action, targetType, targetId, meta = {}) {
  try {
    const store = getStore();
    await store.insert('auditlogs', {
      actor: req.user ? req.user.email : 'system',
      actorRole: req.user ? req.user.role : 'system',
      action,
      targetType,
      targetId: String(targetId || ''),
      meta,
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[audit] failed:', err.message);
  }
}

module.exports = { ApiError, asyncHandler, signToken, authenticate, authorize, errorHandler, audit, JWT_SECRET };
