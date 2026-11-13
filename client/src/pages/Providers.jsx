import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import clsx from 'clsx';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../lib/api';
import { dateStr, inr, num, riskMeta, titleize } from '../lib/format';
import { Card, CardHeader, EmptyState, InfoTip, Loading, PageHeader, RiskBadge, RiskMeter, Stat, StatusBadge } from '../components/ui';

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-ink-850/95 px-3 py-2 shadow-xl">
      {label && <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="text-xs text-slate-200">
          <span className="text-slate-400">{p.name}: </span>
          <span className="font-mono">{p.dataKey === 'billed' ? inr(p.value, { compact: true }) : num(p.value)}</span>
        </p>
      ))}
    </div>
  );
};

export default function Providers() {
  const { id } = useParams();
  const [providers, setProviders] = useState(null);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('providerRiskScore');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard/providers')
      .then((r) => setProviders(r.data.providers || []))
      .catch((e) => setError(e.friendlyMessage || 'Failed to load providers'));
  }, []);

  useEffect(() => {
    if (!id) { setDetail(null); return; }
    api.get(`/dashboard/providers/${id}`).then((r) => setDetail(r.data)).catch(() => setDetail(null));
  }, [id]);

  if (error) return <p className="text-sm text-danger-400">{error}</p>;
  if (!providers) return <Loading rows={8} />;

  const filtered = providers
    .filter((p) => !search
      || p.name?.toLowerCase().includes(search.toLowerCase())
      || p.specialty?.toLowerCase().includes(search.toLowerCase())
      || p.providerId?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));

  if (id && detail) {
    const { provider, claims, monthly, summary } = detail;
    return (
      <div className="space-y-5">
        <PageHeader
          title={provider.name}
          breadcrumb={<><Link to="/providers" className="hover:text-brand-400">Providers</Link><span>/</span><span className="text-slate-400">{provider.providerId}</span></>}
          subtitle={`${provider.specialty} · ${provider.city}, ${provider.state} · ${provider.inNetwork ? 'in-network' : 'out-of-network'}`}
          actions={<Link to="/providers" className="btn-ghost">← All providers</Link>}
        />

        {provider.onWatchlist && (
          <div className="rounded-2xl border border-danger-500/25 bg-danger-500/[.07] px-4 py-3 text-xs text-danger-400">
            ⚠ This provider is on the SIU watchlist — {provider.fraudHistory} confirmed adverse finding(s) on record.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Stat label="Total claims" value={num(summary.claims)} tone="info" />
          <Stat label="Flagged" value={num(summary.flagged)} tone="danger"
            sub={`${((summary.flagged / Math.max(summary.claims, 1)) * 100).toFixed(1)}% flag rate`} />
          <Stat label="Billed" value={inr(summary.billed, { compact: true })} tone="warn" />
          <Stat label="Approved" value={inr(summary.approved, { compact: true })} tone="brand" />
          <Stat label="Avg risk score" value={summary.avgRisk} tone="slate" />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="Monthly billing pattern" subtitle="Claim volume and flagged volume over time" />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip />} />
                  <Bar dataKey="claims" name="Claims" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="flagged" name="Flagged" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card>
            <CardHeader title="Provider risk" subtitle="Composite of mean claim risk, 90th-percentile risk and flag volume" />
            <div className="flex flex-col items-center gap-3 py-3">
              <RiskMeter score={provider.riskScore} size={128} label="provider risk" />
              <div className="grid w-full grid-cols-2 gap-2 text-center">
                <div className="rounded-xl bg-white/[.03] p-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Licence age</p>
                  <p className="text-sm font-bold text-slate-200">{provider.licenseAgeYears} yr</p>
                </div>
                <div className="rounded-xl bg-white/[.03] p-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Prior findings</p>
                  <p className={clsx('text-sm font-bold', provider.fraudHistory ? 'text-danger-400' : 'text-brand-400')}>
                    {provider.fraudHistory}
                  </p>
                </div>
                <div className="rounded-xl bg-white/[.03] p-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Peer avg</p>
                  <p className="text-sm font-bold text-slate-200">{inr(provider.peerAvgBilled, { compact: true })}</p>
                </div>
                <div className="rounded-xl bg-white/[.03] p-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Licence</p>
                  <p className="font-mono text-xs font-bold text-slate-200">{provider.licenseNumber}</p>
                </div>
              </div>
            </div>
          </Card>
        </div>

        <Card className="p-0">
          <div className="border-b border-white/[.07] px-5 py-3.5">
            <p className="text-xs text-slate-400">Claim history ({claims.length})</p>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0"><tr>
                <th className="th">Claim</th><th className="th">Date</th><th className="th">Member</th>
                <th className="th">Type</th><th className="th text-right">Billed</th><th className="th">Risk</th><th className="th">Status</th>
              </tr></thead>
              <tbody>
                {claims.slice(0, 120).map((c) => (
                  <tr key={c.claimId} className="row">
                    <td className="td"><Link to={`/claims/${c.claimId}`} className="font-mono text-xs text-brand-400 hover:underline">{c.claimId}</Link></td>
                    <td className="td text-xs text-slate-400">{dateStr(c.serviceDate)}</td>
                    <td className="td text-xs">{c.memberName}</td>
                    <td className="td text-xs text-slate-400">{titleize(c.claimType)}</td>
                    <td className="td text-right font-mono text-xs">{inr(c.amountBilled)}</td>
                    <td className="td"><RiskBadge level={c.riskLevel} score={c.riskScore} /></td>
                    <td className="td"><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Provider Risk League"
        subtitle="Provider-level risk is not just the average claim risk — a provider with a few blatant claims among many normal ones is the classic fraud profile, so we weight the upper tail heavily."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Providers monitored</p>
          <p className="mt-1 text-xl font-bold text-white">{num(providers.length)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">On watchlist</p>
          <p className="mt-1 text-xl font-bold text-danger-400">{num(providers.filter((p) => p.onWatchlist).length)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Out-of-network</p>
          <p className="mt-1 text-xl font-bold text-warn-400">{num(providers.filter((p) => !p.inNetwork).length)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">High+ risk providers</p>
          <p className="mt-1 text-xl font-bold text-danger-400">
            {num(providers.filter((p) => ['critical', 'high'].includes(p.providerRiskLevel)).length)}
          </p>
        </Card>
      </div>

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[.07] px-5 py-3.5">
          <input className="input max-w-xs" placeholder="Search provider, specialty or ID…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input max-w-[200px]" value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
            <option value="providerRiskScore">Sort by provider risk</option>
            <option value="flaggedAmount">Sort by flagged amount</option>
            <option value="billedTotal">Sort by total billed</option>
            <option value="claimsCount">Sort by claim volume</option>
          </select>
          <span className="ml-auto text-xs text-slate-500">{filtered.length} providers</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr>
              <th className="th">Provider</th><th className="th">Specialty</th><th className="th">Network</th>
              <th className="th text-right">Claims</th><th className="th text-right">Flagged</th>
              <th className="th text-right">Billed</th><th className="th text-right">Flagged ₹</th>
              <th className="th">Risk</th><th className="th" />
            </tr></thead>
            <tbody>
              {filtered.slice(0, 80).map((p) => (
                <tr key={p.providerId} className="row">
                  <td className="td">
                    <Link to={`/providers/${p.providerId}`} className="max-w-[200px] truncate text-xs text-slate-200 hover:text-brand-400">
                      {p.name}
                    </Link>
                    <p className="font-mono text-[10px] text-slate-500">{p.providerId}</p>
                  </td>
                  <td className="td text-xs text-slate-400">{p.specialty}</td>
                  <td className="td">
                    <span className={clsx('chip text-[9px]', p.inNetwork
                      ? 'border-brand-500/25 bg-brand-500/10 text-brand-400'
                      : 'border-warn-500/25 bg-warn-500/10 text-warn-400')}>
                      {p.inNetwork ? 'In-network' : 'Out-of-network'}
                    </span>
                  </td>
                  <td className="td text-right font-mono text-xs">{num(p.claimsCount)}</td>
                  <td className="td text-right font-mono text-xs text-danger-400">{num(p.flaggedCount)}</td>
                  <td className="td text-right font-mono text-xs">{inr(p.billedTotal, { compact: true })}</td>
                  <td className="td text-right font-mono text-xs text-warn-400">{inr(p.flaggedAmount, { compact: true })}</td>
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold" style={{ color: riskMeta(p.providerRiskLevel).solid }}>
                        {p.providerRiskScore}
                      </span>
                      <div className="h-1 w-12 overflow-hidden rounded-full bg-white/[.07]">
                        <div className="h-full rounded-full" style={{ width: `${p.providerRiskScore}%`, background: riskMeta(p.providerRiskLevel).solid }} />
                      </div>
                    </div>
                  </td>
                  <td className="td">
                    <Link to={`/providers/${p.providerId}`} className="text-[11px] font-semibold text-slate-400 hover:text-brand-400">Profile →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
