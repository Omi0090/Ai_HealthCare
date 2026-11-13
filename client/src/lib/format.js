/** Formatting + colour helpers shared by every screen. */

export const inr = (value, { compact = false } = {}) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '₹0';
  if (compact) {
    if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
    if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(1)} K`;
  }
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

export const num = (v, digits = 0) =>
  Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const pct = (v, digits = 1) => `${Number(v || 0).toFixed(digits)}%`;

export const dateStr = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(+date)) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const dateTimeStr = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(+date)) return '—';
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const relativeTime = (d) => {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 1) return 'just now';
  if (Math.abs(mins) < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days}d ago`;
  return dateStr(d);
};

export const RISK_COLORS = {
  critical: { text: 'text-danger-400', bg: 'bg-danger-500/15', border: 'border-danger-500/30', solid: '#f43f5e', label: 'Critical' },
  high: { text: 'text-orange-400', bg: 'bg-orange-500/15', border: 'border-orange-500/30', solid: '#fb923c', label: 'High' },
  medium: { text: 'text-warn-400', bg: 'bg-warn-500/15', border: 'border-warn-500/30', solid: '#f59e0b', label: 'Medium' },
  low: { text: 'text-info-400', bg: 'bg-info-500/15', border: 'border-info-500/30', solid: '#3b82f6', label: 'Low' },
  minimal: { text: 'text-brand-400', bg: 'bg-brand-500/15', border: 'border-brand-500/30', solid: '#1eb774', label: 'Minimal' },
  none: { text: 'text-slate-400', bg: 'bg-white/5', border: 'border-white/10', solid: '#64748b', label: 'None' },
};

export const riskMeta = (level) => RISK_COLORS[level] || RISK_COLORS.minimal;

export const STATUS_COLORS = {
  pending: 'bg-white/5 text-slate-300 border-white/10',
  flagged: 'bg-danger-500/15 text-danger-400 border-danger-500/30',
  under_review: 'bg-warn-500/15 text-warn-400 border-warn-500/30',
  approved: 'bg-brand-500/15 text-brand-400 border-brand-500/30',
  rejected: 'bg-danger-500/20 text-danger-400 border-danger-500/40',
  paid: 'bg-info-500/15 text-info-400 border-info-500/30',
  open: 'bg-info-500/15 text-info-400 border-info-500/30',
  investigating: 'bg-warn-500/15 text-warn-400 border-warn-500/30',
  escalated: 'bg-danger-500/15 text-danger-400 border-danger-500/30',
  closed: 'bg-white/5 text-slate-400 border-white/10',
};

export const ARCHETYPE_LABELS = {
  legitimate: 'Legitimate care',
  upcoding: 'Upcoding',
  phantom_billing: 'Phantom billing',
  duplicate_billing: 'Duplicate billing',
  unbundling: 'Unbundling',
  los_inflation: 'Length-of-stay inflation',
  collusion_ring: 'Collusion ring',
  identity_misuse: 'Identity misuse',
};

export const titleize = (s) =>
  String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const shortId = (id) => String(id || '').replace(/^(CLM|CASE)-/, '');
