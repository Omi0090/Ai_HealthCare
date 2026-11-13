import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Radar, RadarChart,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../lib/api';
import { ARCHETYPE_LABELS, inr, num, pct, titleize } from '../lib/format';
import { Card, CardHeader, InfoTip, Loading, PageHeader, Progress } from '../components/ui';

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-ink-850/95 px-3 py-2 shadow-xl">
      {label && <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-xs text-slate-200">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-slate-400">{p.name}:</span>
          <span className="font-mono font-semibold">
            {p.dataKey === 'billed' || p.dataKey === 'exposure' ? inr(p.value, { compact: true }) : num(p.value)}
          </span>
        </p>
      ))}
    </div>
  );
};

export default function Analytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard/analytics')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.friendlyMessage || 'Failed to load analytics'));
  }, []);

  if (error) return <p className="text-sm text-danger-400">{error}</p>;
  if (!data) return <Loading rows={10} />;

  const schemes = data.archetypes.filter((a) => a.archetype !== 'legitimate');
  const maxExposure = Math.max(...data.byState.map((s) => s.exposure), 1);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Portfolio Analytics"
        subtitle="Where fraud concentrates, which schemes the models catch, and how the portfolio behaves across specialties, geographies and risk bands."
      />

      {/* -------------------------------------------------- scheme detection */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Fraud scheme detection rate"
            subtitle="Every synthetic claim carries a ground-truth scheme label. This is the system's true per-scheme performance."
            action={<InfoTip text="Detection rate = share of claims of that scheme which the ensemble escalated for review. Precision is not measured per-scheme because flagged claims may match multiple schemes." />} />
          <div className="space-y-3">
            {schemes.sort((a, b) => b.detectionRate - a.detectionRate).map((s) => (
              <div key={s.archetype}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-slate-300">{ARCHETYPE_LABELS[s.archetype] || titleize(s.archetype)}</span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-400">
                    {s.detected}/{s.claims} · <span className={s.detectionRate >= 60 ? 'text-brand-400' : s.detectionRate >= 40 ? 'text-warn-400' : 'text-danger-400'}>
                      {pct(s.detectionRate, 0)}
                    </span>
                  </span>
                </div>
                <Progress value={s.detectionRate}
                  tone={s.detectionRate >= 60 ? 'brand' : s.detectionRate >= 40 ? 'warn' : 'danger'} />
                <p className="mt-0.5 text-[10px] text-slate-500">{inr(s.exposure, { compact: true })} exposure</p>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Risk score distribution"
            subtitle="How well the composite score separates fraudulent from legitimate claims" />
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.histogram} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="claims" name="All claims" fill="#334155" radius={[3, 3, 0, 0]} />
                <Bar dataKey="fraud" name="Fraudulent" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                <Line type="monotone" dataKey="fraud" name="Fraud rate" stroke="#1eb774" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            A well-calibrated model concentrates the red bars at the high end. Note the long tail below 30 —
            that is the “needle in haystack” problem fraud analytics actually faces.
          </p>
        </Card>
      </div>

      {/* ------------------------------------------------------- specialty */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Flagged volume by specialty"
            subtitle="Which clinical departments generate the most investigation work" />
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.bySpecialty} margin={{ top: 8, right: 8, left: -18, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="specialty" tick={{ fill: '#94a3b8', fontSize: 9 }} angle={-32} textAnchor="end"
                  height={70} interval={0} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="claims" name="Claims" fill="#1e293b" radius={[3, 3, 0, 0]} />
                <Bar dataKey="flagged" name="Flagged" fill="#f59e0b" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Average risk by claim type" subtitle="Outpatient dominates volume — pharmacy dominates risk" />
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={data.byClaimType} outerRadius="72%">
                <PolarGrid stroke="rgba(255,255,255,.1)" />
                <PolarAngleAxis dataKey="claimType" tick={{ fill: '#94a3b8', fontSize: 9 }} />
                <PolarRadiusAxis tick={{ fill: '#475569', fontSize: 8 }} angle={30} />
                <Radar dataKey="avgRisk" name="Avg risk" stroke="#1eb774" fill="#1eb774" fillOpacity={0.35} />
                <Tooltip content={<Tip />} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* ----------------------------------------------------------- state */}
      <Card>
        <CardHeader title="Geographic exposure" subtitle="Flagged billed amount by state — where the SIU should focus field audits" />
        <div className="grid gap-2 sm:grid-cols-2">
          {data.byState.map((s) => (
            <div key={s.state} className="flex items-center gap-3 rounded-xl border border-white/[.05] bg-white/[.02] px-3 py-2">
              <span className="w-28 shrink-0 truncate text-xs text-slate-300">{s.state}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[.06]">
                <div className="h-full rounded-full bg-gradient-to-r from-info-500 to-danger-500"
                  style={{ width: `${(s.exposure / maxExposure) * 100}%` }} />
              </div>
              <span className="w-24 shrink-0 text-right font-mono text-[11px] text-slate-400">
                {inr(s.exposure, { compact: true })}
              </span>
              <span className="w-12 shrink-0 text-right font-mono text-[10px] text-slate-500">{s.flagged}f</span>
            </div>
          ))}
        </div>
      </Card>

      {/* -------------------------------------------------------- tables */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Highest-risk providers" subtitle="SIU provider audit shortlist"
            action={<Link to="/providers" className="text-xs font-semibold text-brand-400 hover:underline">All providers →</Link>} />
          <div className="table-wrap">
            <table className="w-full">
              <thead><tr>
                <th className="th">Provider</th><th className="th">Claims</th><th className="th">Flagged</th>
                <th className="th">Flag rate</th><th className="th text-right">Billed</th><th className="th">Avg risk</th>
              </tr></thead>
              <tbody>
                {data.topProviders.slice(0, 8).map((p) => (
                  <tr key={p.providerId} className="row">
                    <td className="td">
                      <Link to={`/providers/${p.providerId}`} className="max-w-[170px] truncate text-xs text-slate-200 hover:text-brand-400">{p.providerName}</Link>
                      <p className="text-[10px] text-slate-500">{p.specialty}</p>
                    </td>
                    <td className="td font-mono text-xs">{p.claims}</td>
                    <td className="td font-mono text-xs text-danger-400">{p.flagged}</td>
                    <td className="td font-mono text-xs">{p.flagRate}%</td>
                    <td className="td text-right font-mono text-xs">{inr(p.billed, { compact: true })}</td>
                    <td className="td">
                      <span className={`font-mono text-xs font-semibold ${p.avgRisk >= 50 ? 'text-danger-400' : p.avgRisk >= 30 ? 'text-warn-400' : 'text-slate-400'}`}>
                        {p.avgRisk}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Detected red-flag rules" subtitle="Observed lift of each deterministic rule over the portfolio base rate" />
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {(data.rulePerformance || []).map((r) => (
              <div key={r.rule} className="flex items-center gap-3 rounded-lg border border-white/[.05] bg-white/[.02] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-slate-300">{r.rule}</p>
                  <p className="text-[10px] text-slate-500">
                    {num(r.claims_flagged)} claims · hit rate {pct(r.hit_rate * 100, 1)} · captures {pct(r.fraud_capture * 100, 1)} of fraud
                  </p>
                </div>
                <span className={`shrink-0 font-mono text-xs font-bold ${r.lift >= 5 ? 'text-danger-400' : r.lift >= 2 ? 'text-warn-400' : 'text-slate-400'}`}>
                  {r.lift.toFixed(1)}×
                </span>
              </div>
            ))}
            {!data.rulePerformance?.length && (
              <p className="py-6 text-center text-xs text-slate-500">Rule analytics require the ML service to be running.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
