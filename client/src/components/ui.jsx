import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { riskMeta, STATUS_COLORS, titleize } from '../lib/format';

/* ------------------------------------------------------------------ Card */
export function Card({ className, children, as: As = 'div', ...rest }) {
  return <As className={clsx('card p-5', className)} {...rest}>{children}</As>;
}

export function CardHeader({ title, subtitle, action, icon }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {icon && <div className="mt-0.5 text-brand-400">{icon}</div>}
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-white">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ Stat */
export function Stat({ label, value, sub, delta, icon, tone = 'brand', spark }) {
  const tones = {
    brand: 'text-brand-400 bg-brand-500/10 ring-brand-500/20',
    danger: 'text-danger-400 bg-danger-500/10 ring-danger-500/20',
    warn: 'text-warn-400 bg-warn-500/10 ring-warn-500/20',
    info: 'text-info-400 bg-info-500/10 ring-info-500/20',
    slate: 'text-slate-300 bg-white/5 ring-white/10',
  };
  return (
    <div className="card card-hover relative overflow-hidden p-5">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
          <p className="stat-value mt-2 truncate">{value}</p>
          {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
        </div>
        {icon && (
          <div className={clsx('grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1', tones[tone])}>
            {icon}
          </div>
        )}
      </div>
      {delta != null && (
        <p className={clsx('mt-3 text-xs font-medium', delta >= 0 ? 'text-brand-400' : 'text-danger-400')}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs previous period
        </p>
      )}
      {spark && <div className="pointer-events-none absolute -bottom-2 -right-2 opacity-40">{spark}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Badge */
export function RiskBadge({ level, score, size = 'sm' }) {
  const meta = riskMeta(level);
  return (
    <span className={clsx('chip',
      meta.bg, meta.text, meta.border,
      size === 'lg' ? 'text-xs px-3 py-1.5' : '')}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.solid }} />
      {meta.label}{score != null ? ` · ${score}` : ''}
    </span>
  );
}

export function StatusBadge({ status }) {
  return (
    <span className={clsx('chip', STATUS_COLORS[status] || 'bg-white/5 text-slate-300 border-white/10')}>
      {titleize(status)}
    </span>
  );
}

export function PriorityBadge({ priority }) {
  const map = {
    critical: 'bg-danger-500/15 text-danger-400 border-danger-500/30',
    high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    medium: 'bg-warn-500/15 text-warn-400 border-warn-500/30',
    low: 'bg-info-500/15 text-info-400 border-info-500/30',
  };
  return <span className={clsx('chip', map[priority] || map.low)}>{titleize(priority)}</span>;
}

/* ------------------------------------------------------------- Risk meter */
export function RiskMeter({ score = 0, size = 96, label }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  const offset = c - (clamped / 100) * c;
  const color = clamped >= 80 ? '#f43f5e' : clamped >= 60 ? '#fb923c' : clamped >= 35 ? '#f59e0b' : clamped >= 15 ? '#3b82f6' : '#1eb774';
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="8" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="8"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)' }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-xl font-bold text-white">{Math.round(clamped)}</div>
        {label && <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Progress */
export function Progress({ value, tone = 'brand', height = 'h-2', showLabel }) {
  const tones = {
    brand: 'bg-brand-500', danger: 'bg-danger-500', warn: 'bg-warn-500', info: 'bg-info-500', slate: 'bg-slate-500',
  };
  return (
    <div>
      <div className={clsx('w-full overflow-hidden rounded-full bg-white/[.07]', height)}>
        <div
          className={clsx('h-full rounded-full transition-all duration-700', tones[tone])}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      {showLabel && <p className="mt-1 text-xs text-slate-400">{Number(value).toFixed(1)}%</p>}
    </div>
  );
}

/* ------------------------------------------------------------- Skeleton */
export function Loading({ rows = 4, className }) {
  return (
    <div className={clsx('space-y-3', className)}>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-14 w-full" />)}
    </div>
  );
}

export function EmptyState({ title, message, action }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-white/10 px-6 py-14 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white/5 text-slate-400">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /><path d="M12 8v4M12 16h.01" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-white">{title}</p>
      {message && <p className="mt-1 max-w-sm text-xs text-slate-400">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {breadcrumb && <nav className="mb-1.5 flex items-center gap-1.5 text-xs text-slate-500">{breadcrumb}</nav>}
        <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- Tooltip */
export function InfoTip({ text }) {
  return (
    <span className="group relative inline-flex cursor-help items-center">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-500">
        <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
      </svg>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-56 -translate-x-1/2 rounded-lg border border-white/10 bg-ink-800 p-2.5 text-[11px] font-normal leading-relaxed text-slate-300 opacity-0 shadow-xl transition group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

/* --------------------------------------------------------- Claim link */
export function ClaimLink({ id, children }) {
  return (
    <Link to={`/claims/${id}`} className="font-mono text-xs text-brand-400 hover:text-brand-300 hover:underline">
      {children || id}
    </Link>
  );
}
