import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import api from '../lib/api';
import { dateStr, dateTimeStr, inr, titleize } from '../lib/format';
import { Card, EmptyState, Loading, PageHeader, PriorityBadge, RiskBadge, StatusBadge } from '../components/ui';
import { useAuth } from '../context/AuthContext';

const STATUSES = ['', 'open', 'investigating', 'escalated', 'closed'];

export default function Cases() {
  const { user, can } = useAuth();
  const [cases, setCases] = useState(null);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ decision: 'pending', findings: '', recoverableAmount: 0 });

  const load = () => {
    api.get('/cases', { params: { status: status || undefined } })
      .then((r) => setCases(r.data.cases || []))
      .catch(() => setCases([]));
  };
  useEffect(load, [status]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    api.get(`/cases/${selected}`).then((r) => {
      setDetail(r.data);
      setForm({
        decision: r.data.case.decision || 'pending',
        findings: r.data.case.findings || '',
        recoverableAmount: r.data.case.recoverableAmount || 0,
      });
    });
  }, [selected]);

  const stats = useMemo(() => {
    const list = cases || [];
    return {
      total: list.length,
      open: list.filter((c) => c.status === 'open').length,
      investigating: list.filter((c) => c.status === 'investigating').length,
      critical: list.filter((c) => c.priority === 'critical').length,
      exposure: list.reduce((s, c) => s + (c.amountBilled || 0), 0),
      recovered: list.filter((c) => c.decision === 'confirmed_fraud').reduce((s, c) => s + (c.recoverableAmount || 0), 0),
    };
  }, [cases]);

  const update = async (patch) => {
    setBusy('update');
    try {
      await api.patch(`/cases/${selected}`, patch);
      const r = await api.get(`/cases/${selected}`);
      setDetail(r.data);
      load();
    } catch (e) { alert(e.friendlyMessage || 'Update failed'); } finally { setBusy(''); }
  };

  if (!cases) return <Loading rows={8} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Investigation Queue"
        subtitle="Every flagged claim with material exposure becomes a case. Investigators record findings, and confirmed fraud feeds back into provider risk."
        actions={
          <div className="flex gap-1.5">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={clsx('chip transition', status === s
                  ? 'border-brand-500/40 bg-brand-500/15 text-brand-300'
                  : 'border-white/10 bg-white/[.03] text-slate-400 hover:bg-white/[.06]')}>
                {s ? titleize(s) : 'All'}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: 'Total cases', value: stats.total, tone: 'text-white' },
          { label: 'Open', value: stats.open, tone: 'text-info-400' },
          { label: 'Investigating', value: stats.investigating, tone: 'text-warn-400' },
          { label: 'Critical priority', value: stats.critical, tone: 'text-danger-400' },
          { label: 'Recovered', value: inr(stats.recovered, { compact: true }), tone: 'text-brand-400' },
        ].map((s) => (
          <div key={s.label} className="card p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{s.label}</p>
            <p className={clsx('mt-1 text-xl font-bold', s.tone)}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
        <Card className="p-0">
          <div className="border-b border-white/[.07] px-5 py-3.5">
            <p className="text-xs text-slate-400">
              {stats.total} case{stats.total !== 1 ? 's' : ''} · {inr(stats.exposure, { compact: true })} total billed exposure
            </p>
          </div>
          {cases.length === 0 ? (
            <div className="p-5"><EmptyState title="No cases here" message="Open a case from any flagged claim to populate the queue." /></div>
          ) : (
            <div className="max-h-[720px] overflow-y-auto">
              {cases.map((c) => (
                <button key={c.caseNumber} onClick={() => setSelected(c.caseNumber)}
                  className={clsx('flex w-full items-center gap-3 border-b border-white/[.04] px-4 py-3 text-left transition hover:bg-white/[.03]',
                    selected === c.caseNumber && 'bg-brand-500/[.07]')}>
                  <div className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[11px] font-bold',
                    c.priority === 'critical' ? 'bg-danger-500/15 text-danger-400'
                      : c.priority === 'high' ? 'bg-orange-500/15 text-orange-400'
                        : 'bg-warn-500/15 text-warn-400')}>
                    {c.riskScore}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-[11px] font-semibold text-slate-200">{c.caseNumber}</p>
                      <PriorityBadge priority={c.priority} />
                    </div>
                    <p className="truncate text-[11px] text-slate-400">
                      {c.claimId} · {inr(c.amountBilled, { compact: true })}
                    </p>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={c.status} />
                    <p className="mt-1 text-[10px] text-slate-500">{c.assignedTo?.split(' ')[0] || '—'}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------ detail */}
        <div className="space-y-4">
          {!detail ? (
            <Card className="grid min-h-[300px] place-items-center">
              <div className="text-center">
                <p className="text-sm font-semibold text-white">Select a case</p>
                <p className="mt-1 max-w-[240px] text-xs text-slate-400">
                  Choose a case on the left to review the claim, record findings and close it out.
                </p>
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-mono text-xs text-slate-500">{detail.case.caseNumber}</p>
                    <h3 className="mt-0.5 text-lg font-bold text-white">{inr(detail.case.amountBilled)}</h3>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <PriorityBadge priority={detail.case.priority} />
                    <StatusBadge status={detail.case.status} />
                  </div>
                </div>

                <div className="mt-4 space-y-2 border-t border-white/[.07] pt-3 text-xs">
                  <Row label="Claim">
                    <Link to={`/claims/${detail.case.claimId}`} className="font-mono text-brand-400 hover:underline">
                      {detail.case.claimId}
                    </Link>
                  </Row>
                  <Row label="Provider">{detail.provider?.name || detail.case.providerId}</Row>
                  <Row label="Member">{detail.member?.name || detail.case.memberId}</Row>
                  <Row label="Risk score">
                    <RiskBadge level={detail.claim?.riskLevel} score={detail.case.riskScore} />
                  </Row>
                  <Row label="Assigned to">{detail.case.assignedTo || 'Unassigned'}</Row>
                  <Row label="Opened">{dateStr(detail.case.openedAt)}</Row>
                  {detail.case.closedAt && <Row label="Closed">{dateStr(detail.case.closedAt)}</Row>}
                </div>

                {detail.claim?.triggeredRules?.length > 0 && (
                  <div className="mt-3 border-t border-white/[.07] pt-3">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Top red flags</p>
                    <ul className="space-y-1">
                      {detail.claim.triggeredRules.slice(0, 4).map((r) => (
                        <li key={r.code} className="flex gap-1.5 text-[11px] text-slate-400">
                          <span className="text-danger-400">•</span>{r.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>

              <Card>
                <h4 className="mb-3 text-sm font-semibold text-white">Decision</h4>
                <div className="space-y-3">
                  <div>
                    <label className="label">Outcome</label>
                    <select className="input" value={form.decision}
                      onChange={(e) => setForm((f) => ({ ...f, decision: e.target.value }))}
                      disabled={!can(['investigator'])}>
                      <option value="pending">Pending review</option>
                      <option value="confirmed_fraud">Confirmed fraud</option>
                      <option value="false_positive">False positive</option>
                      <option value="insufficient_evidence">Insufficient evidence</option>
                    </select>
                  </div>
                  {form.decision === 'confirmed_fraud' && (
                    <div>
                      <label className="label">Recoverable amount (₹)</label>
                      <input type="number" className="input" value={form.recoverableAmount}
                        onChange={(e) => setForm((f) => ({ ...f, recoverableAmount: Number(e.target.value) }))} />
                    </div>
                  )}
                  <div>
                    <label className="label">Findings</label>
                    <textarea rows={3} className="input resize-none" placeholder="What did the investigation establish?"
                      value={form.findings} onChange={(e) => setForm((f) => ({ ...f, findings: e.target.value }))}
                      disabled={!can(['investigator'])} />
                  </div>
                  <div className="flex gap-2">
                    <button className="btn-primary flex-1" disabled={busy || !can(['investigator'])}
                      onClick={() => update(form)}>
                      {busy ? 'Saving…' : 'Save decision'}
                    </button>
                    <button className="btn-ghost" disabled={busy || !can(['investigator'])}
                      onClick={() => update({ status: detail.case.status === 'open' ? 'investigating' : 'escalated' })}>
                      {detail.case.status === 'open' ? 'Start' : 'Escalate'}
                    </button>
                    <button className="btn-ghost" disabled={busy || !can(['investigator'])}
                      onClick={() => update({ status: 'closed' })}>Close</button>
                  </div>
                  {!can(['investigator']) && (
                    <p className="text-[10px] text-slate-500">
                      Your role ({user?.role}) has read-only access to case decisions.
                    </p>
                  )}
                </div>
              </Card>

              <Card>
                <h4 className="mb-2 text-sm font-semibold text-white">Case timeline</h4>
                <ol className="space-y-2.5">
                  {(detail.case.timeline || []).map((t, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                      <div>
                        <p className="text-[11px] text-slate-300">{t.event}</p>
                        <p className="text-[10px] text-slate-500">{t.actor} · {dateTimeStr(t.at)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className="text-right text-[11px] font-medium text-slate-200">{children}</span>
    </div>
  );
}
