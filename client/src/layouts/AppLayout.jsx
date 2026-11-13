import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import api from '../lib/api';

const NAV = [
  { to: '/', label: 'Dashboard', end: true, icon: 'grid' },
  { to: '/claims', label: 'Claims', icon: 'file' },
  { to: '/score', label: 'Score a Claim', icon: 'zap' },
  { to: '/cases', label: 'Investigations', icon: 'folder' },
  { to: '/analytics', label: 'Analytics', icon: 'chart' },
  { to: '/providers', label: 'Providers', icon: 'hospital' },
  { to: '/network', label: 'Fraud Network', icon: 'network' },
  { to: '/model', label: 'AI Model', icon: 'cpu' },
  { to: '/admin', label: 'Administration', icon: 'shield' },
  { to: '/about', label: 'Project Overview', icon: 'info' },
];

const ICONS = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M9 13h6M9 17h4" /></>,
  zap: <><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M9 14l2 2 4-4" /></>,
  chart: <><path d="M3 3v18h18" /><path d="M7 15l4-6 4 4 4-7" /></>,
  hospital: <><path d="M4 21V7l8-4 8 4v14" /><path d="M9 21v-5h6v5M12 8v5M9.5 10.5h5" /></>,
  network: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M12 7.5 6.5 16.5M12 7.5l5.5 9M7.5 19h9" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  shield: <><path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3Z" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  menu: <><path d="M3 6h18M3 12h18M3 18h18" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  bell: <><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>,
};

function Icon({ name, className = 'h-[18px] w-[18px]' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [system, setSystem] = useState(null);
  const [showBell, setShowBell] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => { setOpen(false); setShowBell(false); }, [location.pathname]);

  useEffect(() => {
    const load = () => {
      api.get('/admin/system').then((r) => setSystem(r.data)).catch(() => setSystem(null));
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.get('/claims', { params: { riskLevel: 'critical', limit: 6, sort: 'riskScore', order: 'desc' } })
      .then((r) => setAlerts(r.data.claims || []))
      .catch(() => setAlerts([]));
  }, []);

  const mlOnline = system?.ml?.reachable;

  return (
    <div className="flex min-h-screen">
      {/* -------------------------------------------------------- sidebar */}
      <aside className={clsx(
        'fixed inset-y-0 left-0 z-40 w-[248px] transform border-r border-white/[.07] bg-ink-900/95 backdrop-blur-xl transition-transform duration-300 lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full'
      )}>
        <div className="flex h-16 items-center gap-2.5 border-b border-white/[.07] px-5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-ink-950 shadow-glow">
            <Icon name="shield" className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-bold leading-tight tracking-tight text-white">MedGuard<span className="text-brand-400">AI</span></p>
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Fraud Intelligence</p>
          </div>
        </div>

        <nav className="flex h-[calc(100%-4rem)] flex-col gap-1 overflow-y-auto p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => clsx(
                'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
                isActive
                  ? 'bg-brand-500/12 text-brand-300 ring-1 ring-inset ring-brand-500/25'
                  : 'text-slate-400 hover:bg-white/[.04] hover:text-slate-200'
              )}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}

          <div className="mt-auto space-y-3 pt-4">
            <div className="rounded-xl border border-white/[.07] bg-ink-950/50 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">System</span>
                <span className={clsx('chip px-1.5 py-0.5 text-[9px]', mlOnline
                  ? 'border-brand-500/30 bg-brand-500/10 text-brand-400'
                  : 'border-warn-500/30 bg-warn-500/10 text-warn-400')}>
                  <span className={clsx('h-1 w-1 rounded-full', mlOnline ? 'bg-brand-400' : 'bg-warn-400')} />
                  {mlOnline ? 'Live' : 'Fallback'}
                </span>
              </div>
              <dl className="mt-2 space-y-1.5 text-[11px]">
                <div className="flex justify-between"><dt className="text-slate-500">ML engine</dt><dd className="font-mono text-slate-300">{mlOnline ? 'ensemble' : 'linear'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Database</dt><dd className="font-mono text-slate-300">{system?.database?.kind || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Claims</dt><dd className="font-mono text-slate-300">{system?.database?.counts?.claims ?? '—'}</dd></div>
              </dl>
            </div>

            <div className="flex items-center gap-2.5 rounded-xl border border-white/[.07] bg-ink-950/50 p-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-info-500 to-brand-600 text-xs font-bold text-white">
                {(user?.name || 'U').split(' ').map((w) => w[0]).slice(0, 2).join('')}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-white">{user?.name}</p>
                <p className="truncate text-[10px] capitalize text-slate-500">{user?.role}</p>
              </div>
              <button onClick={() => { logout(); navigate('/login'); }}
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-danger-400" title="Sign out">
                <Icon name="logout" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </nav>
      </aside>

      {open && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />}

      {/* ----------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-white/[.07] bg-ink-950/80 px-4 backdrop-blur-xl lg:px-8">
          <div className="flex items-center gap-3">
            <button className="rounded-lg p-2 text-slate-400 hover:bg-white/5 lg:hidden" onClick={() => setOpen(true)}>
              <Icon name="menu" />
            </button>
            <div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
              <span className="chip border-brand-500/25 bg-brand-500/10 text-brand-400">SIU Workspace</span>
              <span>·</span>
              <span>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className={clsx('hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium sm:flex',
              mlOnline ? 'border-brand-500/25 bg-brand-500/10 text-brand-400' : 'border-warn-500/25 bg-warn-500/10 text-warn-400')}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', mlOnline ? 'animate-pulse bg-brand-400' : 'bg-warn-400')} />
              {mlOnline ? `${system?.ml?.models?.length || 4} models online` : 'ML offline · linear fallback'}
            </div>

            <div className="relative">
              <button onClick={() => setShowBell((s) => !s)}
                className="relative rounded-lg border border-white/10 bg-white/[.03] p-2 text-slate-400 transition hover:bg-white/[.07] hover:text-white">
                <Icon name="bell" />
                {alerts.length > 0 && (
                  <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger-500 px-1 text-[9px] font-bold text-white">
                    {alerts.length}
                  </span>
                )}
              </button>
              {showBell && (
                <div className="absolute right-0 top-12 z-50 w-80 overflow-hidden rounded-2xl border border-white/10 bg-ink-850 shadow-2xl">
                  <div className="border-b border-white/[.07] px-4 py-3">
                    <p className="text-xs font-semibold text-white">Highest-risk claims</p>
                    <p className="text-[10px] text-slate-500">Sorted by composite risk score</p>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {alerts.length === 0 && <p className="px-4 py-6 text-center text-xs text-slate-500">Nothing urgent.</p>}
                    {alerts.map((c) => (
                      <button key={c.claimId} onClick={() => navigate(`/claims/${c.claimId}`)}
                        className="flex w-full items-center gap-3 border-b border-white/[.04] px-4 py-2.5 text-left transition hover:bg-white/[.04]">
                        <span className="grid h-7 w-7 place-items-center rounded-lg bg-danger-500/15 text-[10px] font-bold text-danger-400">
                          {c.riskScore}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] font-medium text-slate-200">{c.providerName}</p>
                          <p className="truncate font-mono text-[10px] text-slate-500">{c.claimId}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 animate-fade-in px-4 py-6 lg:px-8">
          <Outlet />
        </main>

        <footer className="border-t border-white/[.05] px-4 py-4 text-center text-[11px] text-slate-600 lg:px-8">
          MedGuard AI · Healthcare Insurance Fraud Detection · B.Tech Final Year Project ·
          <span className="ml-1 font-mono">MERN + scikit-learn</span>
        </footer>
      </div>
    </div>
  );
}
