const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { getStore } = require('../db/store');
const { ApiError, asyncHandler, signToken, authenticate, authorize, audit } = require('../middleware/auth');
const { User } = require('../models');

const router = express.Router();

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['admin', 'investigator', 'analyst', 'viewer']).optional(),
  department: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** POST /api/auth/register - admin creates accounts; first user becomes admin. */
router.post('/register', asyncHandler(async (req, res) => {
  const body = registerSchema.parse(req.body);
  const store = getStore();
  const existing = await store.findOne('users', { email: body.email.toLowerCase() });
  if (existing) throw new ApiError(409, 'An account with this email already exists');

  const userCount = await store.count('users', {});
  const role = userCount === 0 ? 'admin' : body.role || 'analyst';

  const doc = {
    name: body.name,
    email: body.email.toLowerCase(),
    passwordHash: await bcrypt.hash(body.password, 12),
    role,
    department: body.department || 'Special Investigation Unit',
    active: true,
    createdAt: new Date().toISOString(),
  };
  let created;
  if (store.kind === 'mongodb') {
    created = (await User.create(doc)).toObject();
  } else {
    created = (await store.insert('users', doc))[0];
  }
  const token = signToken(created);
  res.status(201).json({
    token,
    user: { id: String(created._id), name: created.name, email: created.email, role: created.role, department: created.department },
  });
}));

/** POST /api/auth/login */
router.post('/login', asyncHandler(async (req, res) => {
  const body = loginSchema.parse(req.body);
  const store = getStore();
  let user;
  if (store.kind === 'mongodb') {
    user = await User.findOne({ email: body.email.toLowerCase() }).select('+passwordHash').lean();
  } else {
    user = await store.findOne('users', { email: body.email.toLowerCase() });
  }
  if (!user || !user.passwordHash) throw new ApiError(401, 'Invalid email or password');
  const ok = await bcrypt.compare(body.password, user.passwordHash);
  if (!ok) throw new ApiError(401, 'Invalid email or password');
  if (user.active === false) throw new ApiError(403, 'Account disabled - contact the platform admin');

  await store.updateOne('users', { email: user.email }, { lastLoginAt: new Date().toISOString() });
  req.user = { email: user.email, role: user.role };
  await audit(req, 'auth.login', 'user', user._id);

  const token = signToken(user);
  res.json({
    token,
    user: { id: String(user._id), name: user.name, email: user.email, role: user.role, department: user.department },
  });
}));

/** GET /api/auth/me */
router.get('/me', authenticate, (req, res) => res.json({ user: req.user }));

/** GET /api/auth/users - admin only */
router.get('/users', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const store = getStore();
  const users = await store.find('users', {}, { limit: 200, sort: { createdAt: -1 } });
  res.json({
    users: users.map((u) => ({
      id: String(u._id), name: u.name, email: u.email, role: u.role,
      department: u.department, active: u.active !== false,
      lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
    })),
  });
}));

/** PATCH /api/auth/users/:id - toggle active / change role (admin) */
router.patch('/users/:id', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const store = getStore();
  const patch = {};
  if (typeof req.body.active === 'boolean') patch.active = req.body.active;
  if (req.body.role) patch.role = req.body.role;
  if (req.body.department) patch.department = req.body.department;
  const updated = await store.updateOne('users', { _id: req.params.id }, patch);
  if (!updated) throw new ApiError(404, 'User not found');
  await audit(req, 'user.update', 'user', req.params.id, patch);
  res.json({ user: { id: updated._id, name: updated.name, email: updated.email, role: updated.role, active: updated.active } });
}));

/** GET /api/auth/audit - audit trail (admin/investigator) */
router.get('/audit', authenticate, authorize('admin', 'investigator'), asyncHandler(async (req, res) => {
  const store = getStore();
  const logs = await store.find('auditlogs', {}, { limit: Number(req.query.limit) || 100, sort: { createdAt: -1 } });
  res.json({ logs });
}));

module.exports = router;
