import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../lib/api';
import { dateStr, inr, num, pct, riskMeta, RISK_COLORS, titleize } from '../lib/format';
import { Card, CardHeader, EmptyState, InfoTip, Loading, PageHeader, Progress, RiskBadge, Stat, StatusBadge } from '../components/ui';

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-ink-850/95 px-3 py-2 shadow-xl backdrop-blur">
      {label && <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-xs text-slate-200">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-slate-400">{p.name}:</span>
          <span className="font-mono font-semibold">
            {typeof p.value === 'number' && p.name?.toLowerCase().includes('₹') ? inr(p.value, { compact: true }) : num(p.value)}
          </span>
        </p>
      ))}
    </div>
  );
};

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [topClaims, setTopClaims] = useState([]);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/dashboard/overview'),
      api.get('/claims', { params: { limit: 6, sort: 'riskScore', order: 'desc', flagged: 'true' } }),
      api.get('/claims', { params: { limit: 6, sort: 'createdAt', order: 'desc' } }),
    ])
      .then(([ov, top, rec]) => {
        setData(ov.data);
        setTopClaims(top.data.claims || []);
        setRecent(rec.data.claims || []);
      })
      .catch((e) => setError(e.friendlyMessage || 'Could not load dashboard'));
  }, []);

  if (error) return <EmptyState title="Dashboard unavailable" message={error} />;
  if (!data) return <Loading rows={8} />;

  const { kpis, riskDistribution, trend, statusDistribution, dataAsOf } = data;
  const riskPie = riskDistribution.filter((r) => r.value > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fraud Intelligence Dashboard"
        subtitle={`Live portfolio monitoring across ${num(kpis.totalClaims)} claims · ledger data as of ${dateStr(dataAsOf)}`}
        actions={
          <>
            <Link to="/score" className="btn-primary">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg>
              Score a claim
            </Link>
            <Link to="/analytics" className="btn-ghost">Analytics</Link>
          </>
        }
      />

      {/* ----------------------------------------------------------- KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Total claims" value={num(kpis.totalClaims)}
          sub={`${inr(kpis.totalBilled, { compact: true })} billed · ${inr(kpis.totalApproved, { compact: true })} approved`}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>}
          tone="info" />

        <Stat label="Flagged for review" value={num(kpis.flaggedClaims)}
          sub={`${pct(kpis.flagRate)} of portfolio · avg risk ${kpis.avgRiskScore}`}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0Z" /></svg>}
          tone="danger" />

        <Stat label="Exposure at risk" value={inr(kpis.exposureAtRisk, { compact: true })}
          sub={`${inr(kpis.preventedLossEstimate, { compact: true })} estimated preventable`}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}
          tone="warn" />

        <Stat label="Model precision" value={kpis.modelPrecision != null ? `${kpis.modelPrecision}%` : '—'}
          sub={kpis.modelRecall != null ? `Recall ${kpis.modelRecall}% · ${num(kpis.openCases)} open cases` : `${num(kpis.openCases)} open cases`}
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1" /><path d="m9 11 3 3L22 4" /></svg>}
          tone="brand" />
      </div>

      {/* --------------------------------------------------------- charts row */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Claims vs flagged — rolling 120 days"
            subtitle="Volume of submitted claims against those the ensemble escalated for investigation"
            action={<span className="chip border-white/10 bg-white/[.04] text-slate-400">Daily</span>} />
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gClaims" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gFlagged" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={(d) => d.slice(5)} minTickGap={40} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="claims" name="Claims" stroke="#3b82f6" strokeWidth={2} fill="url(#gClaims)" />
                <Area type="monotone" dataKey="flagged" name="Flagged" stroke="#f43f5e" strokeWidth={2} fill="url(#gFlagged)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Risk distribution" subtitle="Portfolio share by risk band"
            action={<InfoTip text="Risk bands come from the fused score: 60% ML ensemble, 30% rule engine, 10% anomaly detection." />} />
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={riskPie} dataKey="value" nameKey="name" innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none">
                  {riskPie.map((entry) => <Cell key={entry.name} fill={riskMeta(entry.name).solid} />)}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {riskDistribution.map((r) => (
              <div key={r.name} className="flex items-center justify-between rounded-lg bg-white/[.03] px-2.5 py-1.5">
                <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: riskMeta(r.name).solid }} />
                  {riskMeta(r.name).label}
                </span>
                <span className="font-mono text-[11px] font-semibold text-slate-200">{num(r.value)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------- exposure + queue */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Highest-risk claims awaiting action"
            subtitle="Composite risk ≥ 60 — these are the claims costing money if ignored"
            action={<Link to="/claims?riskLevel=critical" className="text-xs font-semibold text-brand-400 hover:text-brand-300">View all →</Link>} />
          <div className="table-wrap">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Claim</th>
                  <th className="th">Provider</th>
                  <th className="th text-right">Billed</th>
                  <th className="th">Risk</th>
                  <th className="th">Top signal</th>
                </tr>
              </thead>
              <tbody>
                {topClaims.map((c) => (
                  <tr key={c.claimId} className="row">
                    <td className="td">
                      <Link to={`/claims/${c.claimId}`} className="font-mono text-xs text-brand-400 hover:underline">{c.claimId}</Link>
                      <p className="text-[10px] text-slate-500">{titleize(c.claimType)} · {dateStr(c.serviceDate)}</p>
                    </td>
                    <td className="td">
                      <p className="max-w-[190px] truncate text-xs text-slate-200">{c.providerName}</p>
                      <p className="text-[10px] text-slate-500">{c.specialty}</p>
                    </td>
                    <td className="td text-right font-mono text-xs">{inr(c.amountBilled, { compact: true })}</td>
                    <td className="td"><RiskBadge level={c.riskLevel} score={c.riskScore} /></td>
                    <td className="td">
                      <span className="max-w-[190px] truncate text-[11px] text-slate-400">
                        {c.triggeredRules?.[0]?.name || 'Model pattern only'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Review queue efficiency" subtitle="Automation impact this cycle" />
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-xs text-slate-400">Claims auto-cleared</span>
                  <span className="font-mono text-sm font-bold text-brand-400">{num(kpis.autoCleared)}</span>
                </div>
                <Progress value={(kpis.autoCleared / Math.max(kpis.totalClaims, 1)) * 100} tone="brand" />
              </div>
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-xs text-slate-400">Routed to investigation</span>
                  <span className="font-mono text-sm font-bold text-danger-400">{num(kpis.flaggedClaims)}</span>
                </div>
                <Progress value={kpis.flagRate} tone="danger" />
              </div>
              <div className="rounded-xl border border-brand-500/20 bg-brand-500/[.07] p-3">
                <p className="text-[11px] text-slate-400">Analyst hours saved</p>
                <p className="mt-0.5 text-xl font-bold text-brand-400">{num(kpis.hoursSaved, 1)} h</p>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  ≈ {inr(kpis.hoursSaved * 1200, { compact: true })} at ₹1,200/hour of investigator time
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Workflow status" subtitle="Where claims sit right now" />
            <div className="space-y-2">
              {statusDistribution.map((s) => (
                <div key={s.name} className="flex items-center justify-between gap-3">
                  <StatusBadge status={s.name} />
                  <div className="flex flex-1 items-center gap-2">
                    <Progress value={(s.value / Math.max(kpis.totalClaims, 1)) * 100}
                      tone={s.name === 'flagged' ? 'danger' : s.name === 'approved' ? 'brand' : s.name === 'under_review' ? 'warn' : 'info'} />
                    <span className="w-12 text-right font-mono text-[11px] text-slate-400">{num(s.value)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* ----------------------------------------------------- recent claims */}
      <Card>
        <CardHeader title="Recently submitted claims" subtitle="Newest arrivals in the adjudication pipeline"
          action={<Link to="/claims" className="text-xs font-semibold text-brand-400 hover:text-brand-300">Open claims explorer →</Link>} />
        <div className="table-wrap">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Claim ID</th>
                <th className="th">Provider</th>
                <th className="th">Member</th>
                <th className="th">Type</th>
                <th className="th text-right">Billed</th>
                <th className="th">Rules</th>
                <th className="th">Risk</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.claimId} className="row">
                  <td className="td"><Link to={`/claims/${c.claimId}`} className="font-mono text-xs text-brand-400 hover:underline">{c.claimId}</Link></td>
                  <td className="td"><span className="max-w-[170px] truncate text-xs">{c.providerName}</span></td>
                  <td className="td"><span className="max-w-[140px] truncate text-xs text-slate-400">{c.memberName}</span></td>
                  <td className="td text-xs text-slate-400">{titleize(c.claimType)}</td>
                  <td className="td text-right font-mono text-xs">{inr(c.amountBilled)}</td>
                  <td className="td"><span className="font-mono text-xs text-warn-400">{c.triggeredRules?.length || 0}</span></td>
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
