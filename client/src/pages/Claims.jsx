import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { dateStr, inr, num, pct, titleize } from '../lib/format';
import { Card, EmptyState, Loading, PageHeader, RiskBadge, StatusBadge } from '../components/ui';

const RISK_LEVELS = ['', 'critical', 'high', 'medium', 'low', 'minimal'];
const STATUSES = ['', 'pending', 'flagged', 'under_review', 'approved', 'rejected', 'paid'];
const CLAIM_TYPES = ['', 'inpatient', 'outpatient', 'pharmacy', 'laboratory', 'dental', 'vision'];
const SORTS = [
  { value: 'riskScore', label: 'Risk score' },
  { value: 'amountBilled', label: 'Amount billed' },
  { value: 'serviceDate', label: 'Service date' },
  { value: 'submittedAt', label: 'Submission date' },
];

export default function Claims() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [specialties, setSpecialties] = useState([]);

  const filters = useMemo(() => ({
    search: params.get('search') || '',
    riskLevel: params.get('riskLevel') || '',
    status: params.get('status') || '',
    claimType: params.get('claimType') || '',
    specialty: params.get('specialty') || '',
    flagged: params.get('flagged') || '',
    minRisk: params.get('minRisk') || '',
    sort: params.get('sort') || 'riskScore',
    order: params.get('order') || 'desc',
    page: Number(params.get('page') || 1),
  }), [params]);

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    setParams(next, { replace: true });
  };

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    try {
      const q = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v != null));
      const res = await api.get('/claims', { params: { ...q, limit: 20 } });
      setData(res.data);
    } catch (err) {
      setData({ claims: [], total: 0, error: err.friendlyMessage });
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchClaims(); }, [fetchClaims]);

  useEffect(() => {
    api.get('/dashboard/analytics')
      .then((r) => setSpecialties((r.data.bySpecialty || []).map((s) => s.specialty)))
      .catch(() => {});
  }, []);

  const activeCount = Object.entries(filters).filter(([k, v]) => !['sort', 'order', 'page'].includes(k) && v).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Claims Explorer"
        subtitle="Search, filter and triage the entire claims ledger. Every row is scored by the ensemble at submission time."
        actions={
          <>
            {activeCount > 0 && (
              <button className="btn-ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                Clear {activeCount} filter{activeCount > 1 ? 's' : ''}
              </button>
            )}
            <Link to="/score" className="btn-primary">Score new claim</Link>
          </>
        }
      />

      {/* ------------------------------------------------------- filter bar */}
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <div className="xl:col-span-2">
            <label className="label">Search</label>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="input pl-9" placeholder="Claim ID, provider, member…"
                value={filters.search} onChange={(e) => setFilter('search', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Risk level</label>
            <select className="input" value={filters.riskLevel} onChange={(e) => setFilter('riskLevel', e.target.value)}>
              {RISK_LEVELS.map((r) => <option key={r} value={r}>{r ? titleize(r) : 'All levels'}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s ? titleize(s) : 'All statuses'}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Claim type</label>
            <select className="input" value={filters.claimType} onChange={(e) => setFilter('claimType', e.target.value)}>
              {CLAIM_TYPES.map((c) => <option key={c} value={c}>{c ? titleize(c) : 'All types'}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Specialty</label>
            <select className="input" value={filters.specialty} onChange={(e) => setFilter('specialty', e.target.value)}>
              <option value="">All specialties</option>
              {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Sort by</label>
            <div className="flex gap-1.5">
              <select className="input" value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <button className="btn-ghost shrink-0 px-2.5" title={filters.order === 'desc' ? 'Descending' : 'Ascending'}
                onClick={() => setFilter('order', filters.order === 'desc' ? 'asc' : 'desc')}>
                {filters.order === 'desc' ? '↓' : '↑'}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Quick:</span>
          {[
            { label: 'Flagged only', key: 'flagged', value: 'true' },
            { label: 'Critical', key: 'riskLevel', value: 'critical' },
            { label: 'High', key: 'riskLevel', value: 'high' },
            { label: 'Pending', key: 'status', value: 'pending' },
            { label: 'Must investigate (≥70)', key: 'minRisk', value: '70' },
          ].map((chip) => (
            <button key={chip.label}
              onClick={() => setFilter(chip.key, filters[chip.key] === chip.value ? '' : chip.value)}
              className={`chip transition ${filters[chip.key] === chip.value
                ? 'border-brand-500/40 bg-brand-500/15 text-brand-300'
                : 'border-white/10 bg-white/[.03] text-slate-400 hover:bg-white/[.06]'}`}>
              {chip.label}
            </button>
          ))}
        </div>
      </Card>

      {/* ------------------------------------------------------------ table */}
      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.07] px-5 py-3.5">
          <p className="text-xs text-slate-400">
            {data ? (
              <>
                Showing <span className="font-semibold text-white">{num(data.claims?.length)}</span> of{' '}
                <span className="font-semibold text-white">{num(data.total)}</span> matching claims
                {data.total > 0 && <span className="ml-1 text-slate-500">· {pct((data.claims?.length / data.total) * 100)} of results</span>}
              </>
            ) : 'Loading…'}
          </p>
          {data?.total > 0 && (
            <div className="flex items-center gap-1.5">
              <button className="btn-ghost px-2.5 py-1.5 text-xs" disabled={filters.page <= 1}
                onClick={() => setFilter('page', String(filters.page - 1))}>Previous</button>
              <span className="px-2 font-mono text-xs text-slate-400">
                {filters.page} / {data.pages}
              </span>
              <button className="btn-ghost px-2.5 py-1.5 text-xs" disabled={filters.page >= data.pages}
                onClick={() => setFilter('page', String(filters.page + 1))}>Next</button>
            </div>
          )}
        </div>

        {loading && !data ? <div className="p-5"><Loading rows={6} /></div>
          : !data?.claims?.length ? (
            <div className="p-5">
              <EmptyState title="No claims match these filters"
                message="Try clearing a filter or widening the risk band." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Claim</th>
                    <th className="th">Provider</th>
                    <th className="th">Member</th>
                    <th className="th">Type</th>
                    <th className="th text-right">Billed</th>
                    <th className="th text-right">Approved</th>
                    <th className="th">Signals</th>
                    <th className="th">Risk</th>
                    <th className="th">Status</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className={loading ? 'opacity-50 transition' : ''}>
                  {data.claims.map((c) => (
                    <tr key={c.claimId} className="row">
                      <td className="td">
                        <Link to={`/claims/${c.claimId}`} className="font-mono text-xs text-brand-400 hover:underline">{c.claimId}</Link>
                        <p className="text-[10px] text-slate-500">{dateStr(c.serviceDate)}</p>
                      </td>
                      <td className="td">
                        <p className="max-w-[180px] truncate text-xs text-slate-200">{c.providerName}</p>
                        <p className="text-[10px] text-slate-500">{c.specialty} · {c.state}</p>
                      </td>
                      <td className="td">
                        <p className="max-w-[130px] truncate text-xs text-slate-300">{c.memberName}</p>
                        <p className="font-mono text-[10px] text-slate-500">{c.memberId}</p>
                      </td>
                      <td className="td text-xs text-slate-400">{titleize(c.claimType)}</td>
                      <td className="td text-right font-mono text-xs text-slate-200">{inr(c.amountBilled)}</td>
                      <td className="td text-right font-mono text-xs text-slate-400">{inr(c.amountApproved)}</td>
                      <td className="td">
                        <div className="flex items-center gap-1">
                          <span className={`font-mono text-xs font-semibold ${(c.triggeredRules?.length || 0) >= 3 ? 'text-danger-400' : (c.triggeredRules?.length || 0) >= 1 ? 'text-warn-400' : 'text-slate-500'}`}>
                            {c.triggeredRules?.length || 0}
                          </span>
                          <span className="text-[10px] text-slate-500">rules</span>
                        </div>
                      </td>
                      <td className="td"><RiskBadge level={c.riskLevel} score={c.riskScore} /></td>
                      <td className="td"><StatusBadge status={c.status} /></td>
                      <td className="td">
                        <Link to={`/claims/${c.claimId}`} className="text-[11px] font-semibold text-slate-400 hover:text-brand-400">
                          Review →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </div>
  );
}
