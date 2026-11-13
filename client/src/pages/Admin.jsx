import { useEffect, useState } from 'react';
import clsx from 'clsx';
import api from '../lib/api';
import { dateTimeStr, num, relativeTime, titleize } from '../lib/format';
import { Card, CardHeader, Loading, PageHeader, Stat } from '../components/ui';
import { useAuth } from '../context/AuthContext';

export default function Admin() {
  const { can, user } = useAuth();
  const [system, setSystem] = useState(null);
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const load = async () => {
    const [sys, usr, audit] = await Promise.allSettled([
      api.get('/admin/system'),
      api.get('/auth/users'),
      api.get('/admin/audit', { params: { limit: 60 } }),
    ]);
    if (sys.status === 'fulfilled') setSystem(sys.value.data);
    if (usr.status === 'fulfilled') setUsers(usr.value.data.users || []);
    if (audit.status === 'fulfilled') setLogs(audit.value.data.logs || []);
  };

  useEffect(() => { load(); }, []);

  const rescoreAll = async () => {
    setBusy('rescore');
    try {
      const r = await api.post('/admin/rescore-all', { limit: 500 });
      setToast(`Re-scored ${r.data.updated} claims via ${r.data.source}`);
      load();
    } catch (e) { setToast(e.friendlyMessage || 'Re-score failed'); } finally { setBusy(''); }
  };

  const toggleUser = async (u) => {
    try {
      await api.patch(`/auth/users/${u.id}`, { active: !u.active });
      load();
    } catch (e) { setToast(e.friendlyMessage || 'Update failed'); }
  };

  if (!system) return <Loading rows={10} />;

  const { database, ml } = system;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Platform Administration"
        subtitle="Runtime health, user management and the immutable audit trail."
        actions={
          can(['analyst']) && (
            <button className="btn-primary" onClick={rescoreAll} disabled={busy === 'rescore'}>
              {busy === 'rescore' ? 'Re-scoring…' : 'Re-score latest 500 claims'}
            </button>
          )
        }
      />

      {toast && (
        <div className="rounded-xl border border-brand-500/25 bg-brand-500/[.08] px-4 py-2.5 text-xs text-brand-300">
          {toast}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Database" value={database.kind === 'mongodb' ? 'MongoDB' : 'JSON store'}
          sub={database.kind === 'mongodb' ? 'Mongoose connected' : 'Local fallback (demo mode)'} tone="info" />
        <Stat label="Claims scored" value={num(database.counts?.claims || 0)} sub={`${num(database.counts?.cases || 0)} cases open`} tone="brand" />
        <Stat label="API uptime" value={`${Math.floor((system.uptimeSeconds || 0) / 60)} min`}
          sub={`Node ${system.node} · ${system.memoryMb} MB RSS`} tone="slate" />
        <Stat label="ML service" value={ml.reachable ? 'Online' : 'Fallback'}
          sub={ml.trained_at ? `trained ${relativeTime(ml.trained_at)}` : ml.error} tone={ml.reachable ? 'brand' : 'warn'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Collection counts" subtitle="Documents per collection" />
          <div className="space-y-1.5">
            {Object.entries(database.counts || {}).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between rounded-lg bg-white/[.03] px-3 py-2">
                <span className="text-xs capitalize text-slate-300">{k}</span>
                <span className="font-mono text-xs text-slate-200">{num(v)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Model runtime" subtitle="What the inference service reports" />
          <pre className="overflow-x-auto rounded-xl border border-white/[.07] bg-ink-950/70 p-3 font-mono text-[10px] leading-relaxed text-slate-400">
{JSON.stringify({ reachable: ml.reachable, champion: ml.champion, models: ml.models, features: ml.features, trainedAt: ml.trained_at, url: system.ml.url, fallback: system.ml.fallbackAvailable }, null, 2)}
          </pre>
        </Card>
      </div>

      <Card className="p-0">
        <div className="border-b border-white/[.07] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-white">User accounts</h3>
          <p className="text-xs text-slate-400">Role-based access control — admin, investigator, analyst, viewer</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr>
              <th className="th">Name</th><th className="th">Email</th><th className="th">Role</th>
              <th className="th">Department</th><th className="th">Last login</th><th className="th">Status</th><th className="th" />
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="row">
                  <td className="td text-xs text-slate-200">{u.name}{u.id === user?.id && <span className="ml-1.5 text-[9px] text-brand-400">you</span>}</td>
                  <td className="td font-mono text-[11px] text-slate-400">{u.email}</td>
                  <td className="td">
                    <span className={clsx('chip text-[9px] capitalize',
                      u.role === 'admin' ? 'border-danger-500/25 bg-danger-500/10 text-danger-400'
                        : u.role === 'investigator' ? 'border-warn-500/25 bg-warn-500/10 text-warn-400'
                          : u.role === 'analyst' ? 'border-info-500/25 bg-info-500/10 text-info-400'
                            : 'border-white/10 bg-white/5 text-slate-400')}>
                      {u.role}
                    </span>
                  </td>
                  <td className="td text-[11px] text-slate-400">{u.department}</td>
                  <td className="td text-[11px] text-slate-400">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'never'}</td>
                  <td className="td">
                    <span className={clsx('chip text-[9px]', u.active
                      ? 'border-brand-500/25 bg-brand-500/10 text-brand-400'
                      : 'border-white/10 bg-white/5 text-slate-500')}>
                      {u.active ? 'active' : 'disabled'}
                    </span>
                  </td>
                  <td className="td">
                    {can(['admin']) && u.id !== user?.id && (
                      <button onClick={() => toggleUser(u)} className="text-[11px] font-semibold text-slate-400 hover:text-brand-400">
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-0">
        <div className="border-b border-white/[.07] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-white">Audit trail</h3>
          <p className="text-xs text-slate-400">Every privileged action is logged with actor, target and IP</p>
        </div>
        <div className="max-h-96 divide-y divide-white/[.05] overflow-y-auto">
          {logs.map((l, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-2.5">
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full',
                l.action?.includes('login') ? 'bg-info-400'
                  : l.action?.includes('case') ? 'bg-warn-400'
                    : l.action?.includes('rescore') ? 'bg-brand-400' : 'bg-slate-500')} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-slate-300">
                  <span className="font-mono text-brand-400">{l.action}</span>
                  <span className="ml-2 text-slate-500">{l.targetType} {l.targetId}</span>
                </p>
                <p className="text-[10px] text-slate-500">{l.actor} ({l.actorRole})</p>
              </div>
              <span className="shrink-0 text-[10px] text-slate-500">{dateTimeStr(l.createdAt)}</span>
            </div>
          ))}
          {!logs.length && <p className="px-5 py-8 text-center text-xs text-slate-500">No audit entries yet.</p>}
        </div>
      </Card>
    </div>
  );
}
