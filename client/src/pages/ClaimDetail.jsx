import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import api from '../lib/api';
import { ARCHETYPE_LABELS, dateStr, dateTimeStr, inr, pct, riskMeta, titleize } from '../lib/format';
import { Card, CardHeader, EmptyState, InfoTip, Loading, PageHeader, PriorityBadge, RiskBadge, RiskMeter, StatusBadge } from '../components/ui';
import ShapWaterfall from '../components/ShapWaterfall';
import { useAuth } from '../context/AuthContext';

function Field({ label, value, mono, tip }) {
  return (
    <div>
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}{tip && <InfoTip text={tip} />}
      </p>
      <p className={clsx('mt-0.5 text-[13px] text-slate-200', mono && 'font-mono')}>{value ?? '—'}</p>
    </div>
  );
}

export default function ClaimDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState('explanation');
  const [note, setNote] = useState('');
  const [explainState, setExplainState] = useState('');

  const load = () => {
    setLoading(true);
    api.get(`/claims/${id}`)
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(e.friendlyMessage || 'Claim not found'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  // Claims below the flag threshold are not pre-explained at seed time (that
  // would be 9,000 Shapley runs). Fetch the attribution on demand so the
  // explanation panel is never an empty box.
  useEffect(() => {
    const claim = data?.claim;
    if (!claim || claim.explanation || explainState === 'done' || explainState === 'loading') return;
    setExplainState('loading');
    api.get(`/claims/${id}/explain`)
      .then((r) => {
        setData((d) => (d ? { ...d, claim: { ...d.claim, explanation: r.data.explanation } } : d));
        setExplainState('done');
      })
      .catch(() => setExplainState('done'));
  }, [data?.claim, id, explainState]);

  const act = async (label, fn) => {
    setBusy(label);
    try { await fn(); load(); } catch (e) { alert(e.friendlyMessage || 'Action failed'); } finally { setBusy(''); }
  };

  const openCase = () => act('case', async () => {
    const res = await api.post('/cases', { claimId: id });
    navigate('/cases');
    return res;
  });

  const rescore = () => act('rescore', () => api.post(`/claims/${id}/rescore`));
  const setStatus = (status) => act(status, () => api.patch(`/claims/${id}/status`, { status }));
  const addNote = () => act('note', async () => {
    await api.post(`/claims/${id}/notes`, { text: note });
    setNote('');
  });

  if (error) return <EmptyState title="Claim unavailable" message={error} action={<Link to="/claims" className="btn-ghost">Back to claims</Link>} />;
  if (loading || !data) return <Loading rows={10} />;

  const { claim, provider, member, ruleEvaluation, relatedClaims, case: caseDoc, narrative, features } = data;
  const meta = riskMeta(claim.riskLevel);
  const gt = claim.groundTruth;
  const isResolved = ['approved', 'rejected', 'paid'].includes(claim.status);

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="font-mono">{claim.claimId}</span>}
        breadcrumb={<><Link to="/claims" className="hover:text-brand-400">Claims</Link><span>/</span><span className="text-slate-400">{claim.claimId}</span></>}
        subtitle={`${claim.providerName} · ${claim.specialty} · service ${dateStr(claim.serviceDate)}`}
        actions={
          <>
            <button className="btn-ghost" onClick={rescore} disabled={busy === 'rescore'}>
              {busy === 'rescore' ? 'Analysing…' : 'Re-run AI analysis'}
            </button>
            {!caseDoc && (
              <button className="btn-primary" onClick={openCase} disabled={busy === 'case'}>
                {busy === 'case' ? 'Opening…' : 'Open investigation'}
              </button>
            )}
            {caseDoc && <Link to="/cases" className="btn-primary">View case {caseDoc.caseNumber} →</Link>}
          </>
        }
      />

      {gt?.isFraud != null && (
        <div className={clsx('flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-xs',
          gt.isFraud ? 'border-danger-500/25 bg-danger-500/[.07]' : 'border-brand-500/25 bg-brand-500/[.07]')}>
          <span className={clsx('chip', gt.isFraud ? 'border-danger-500/30 bg-danger-500/15 text-danger-400' : 'border-brand-500/30 bg-brand-500/15 text-brand-400')}>
            Ground truth
          </span>
          <span className="text-slate-300">
            This synthetic claim <b>{gt.isFraud ? 'IS fraudulent' : 'is legitimate'}</b>
            {gt.archetype && gt.archetype !== 'legitimate' && <> — scheme: <b>{ARCHETYPE_LABELS[gt.archetype] || gt.archetype}</b></>}
            {gt.severity ? <> · severity {(gt.severity * 100).toFixed(0)}%</> : null}
          </span>
          <span className="ml-auto text-slate-500">
            {claim.isFlagged
              ? (gt.isFraud ? '✓ correctly flagged (true positive)' : '✗ flagged but legitimate (false positive)')
              : (gt.isFraud ? '✗ missed by the system (false negative)' : '✓ correctly cleared (true negative)')}
          </span>
        </div>
      )}

      {/* -------------------------------------------------------- top summary */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <RiskBadge level={claim.riskLevel} size="lg" />
                <StatusBadge status={claim.status} />
                {claim.isFlagged && <span className="chip border-danger-500/30 bg-danger-500/10 text-danger-400">Flagged for review</span>}
              </div>
              <p className="mt-3 text-2xl font-bold text-white">{inr(claim.amountBilled)}</p>
              <p className="text-xs text-slate-400">
                billed · {inr(claim.amountApproved)} approved ({pct((claim.amountApproved / Math.max(claim.amountBilled, 1)) * 100)})
              </p>
            </div>

            <div className="flex items-center gap-5">
              <RiskMeter score={claim.riskScore} label="risk" />
              <div className="space-y-2">
                {[
                  { label: 'ML ensemble', value: claim.fraudProbability, color: 'bg-danger-500' },
                  { label: 'Rule engine', value: claim.ruleScore, color: 'bg-warn-500' },
                  { label: 'Anomaly', value: claim.anomalyScore, color: 'bg-info-500' },
                ].map((s) => (
                  <div key={s.label} className="w-40">
                    <div className="flex items-baseline justify-between text-[10px]">
                      <span className="text-slate-400">{s.label}</span>
                      <span className="font-mono font-semibold text-slate-200">{((s.value || 0) * 100).toFixed(1)}%</span>
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/[.07]">
                      <div className={clsx('h-full rounded-full', s.color)} style={{ width: `${Math.min(100, (s.value || 0) * 100)}%` }} />
                    </div>
                  </div>
                ))}
                <div className="w-40 border-t border-white/[.07] pt-1.5">
                  <div className="flex items-baseline justify-between text-[10px]">
                    <span className="text-slate-300">Composite</span>
                    <span className="font-mono font-bold text-white">{(claim.riskScore / 100).toFixed(2)}</span>
                  </div>
                  <p className="text-[9px] text-slate-500">
                    weights 60 / 30 / 10
                    {claim.fusion?.decisiveRuleFloor && ` · floor ${claim.fusion.decisiveRuleFloor}`}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-x-6 gap-y-3 border-t border-white/[.07] pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Provider" value={<Link className="text-brand-400 hover:underline" to={`/providers/${claim.providerId}`}>{claim.providerName}</Link>} />
            <Field label="Provider ID" value={claim.providerId} mono />
            <Field label="Member" value={claim.memberName} />
            <Field label="Member ID" value={claim.memberId} mono />
            <Field label="Claim type" value={titleize(claim.claimType)} />
            <Field label="Procedure" value={claim.procedureCode} />
            <Field label="Diagnosis" value={claim.diagnosisCode} mono />
            <Field label="Plan" value={claim.planType} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Investigator briefing" subtitle="Auto-generated from the evidence"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v8M8 12h8" /><circle cx="12" cy="12" r="10" /></svg>} />
          <p className="text-xs leading-relaxed text-slate-300">{narrative}</p>

          <div className="mt-4 space-y-1.5 border-t border-white/[.07] pt-3">
            {claim.triggeredRules?.slice(0, 5).map((r) => (
              <div key={r.code} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-danger-400" />
                <div>
                  <p className="text-[11px] font-medium text-slate-200">{r.name}</p>
                  <p className="text-[10px] leading-snug text-slate-500">{r.detail}</p>
                </div>
              </div>
            ))}
            {!claim.triggeredRules?.length && <p className="text-[11px] text-slate-500">No red-flag rules fired.</p>}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/[.07] pt-3">
            <Field label="Submission lag" value={`${claim.submissionLagDays} days`} />
            <Field label="Service days" value={claim.serviceDays} />
            <Field label="Units" value={claim.unitsClaimed} />
            <Field label="Procedures" value={claim.numProcedures} />
            <Field label="Same-day claims" value={claim.sameDayClaims} />
            <Field label="Distance" value={`${Math.round(claim.distanceKm || 0)} km`} />
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------------------- tabs */}
      <div className="flex flex-wrap gap-1.5">
        {[
          { key: 'explanation', label: 'AI explanation', count: claim.explanation?.top_features?.length },
          { key: 'rules', label: 'Red flags', count: ruleEvaluation.triggered.length },
          { key: 'features', label: 'Model features', count: Object.keys(features).length },
          { key: 'context', label: 'Provider & member' },
          { key: 'history', label: 'Related claims', count: relatedClaims.length },
          { key: 'notes', label: 'Audit notes', count: claim.notes?.length },
        ].map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={clsx('chip transition', tab === t.key
              ? 'border-brand-500/40 bg-brand-500/15 text-brand-300'
              : 'border-white/10 bg-white/[.03] text-slate-400 hover:bg-white/[.06]')}>
            {t.label}{t.count != null ? ` (${t.count})` : ''}
          </button>
        ))}
      </div>

      {tab === 'explanation' && (
        <Card>
          <CardHeader
            title="Why did the model score this claim this way?"
            subtitle="Monte-Carlo Shapley attribution in log-odds space — contributions are additive and sum exactly to the model output"
            action={<span className="chip border-info-500/25 bg-info-500/10 text-info-400">Explainable AI</span>}
          />
          <ShapWaterfall explanation={claim.explanation} loading={explainState === 'loading'} />
          {claim.scoringSource === 'fallback-linear' && (
            <p className="mt-3 rounded-lg border border-warn-500/20 bg-warn-500/[.07] px-3 py-2 text-[11px] text-warn-400">
              Scored by the offline linear fallback — the Python inference service was unreachable. Contributions are the
              exact logistic-regression coefficients.
            </p>
          )}
        </Card>
      )}

      {tab === 'rules' && (
        <Card>
          <CardHeader title="Red-flag rule evaluation" subtitle="Deterministic, auditable checks that run alongside the model" />
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-white/[.07] bg-ink-950/40 p-3">
            <RiskMeter score={Math.round(ruleEvaluation.score * 100)} size={64} label="rules" />
            <div className="text-xs text-slate-400">
              <p>Rule score <span className="font-mono font-semibold text-white">{ruleEvaluation.rawScore}</span> raw points
                ({ruleEvaluation.triggered.length} of 17 rules fired)</p>
              <p className="mt-0.5">Normalised to <span className="font-mono font-semibold text-white">{(ruleEvaluation.score * 100).toFixed(0)}</span>/100 — this is the 30% weight in the composite score.</p>
            </div>
          </div>
          <div className="space-y-2">
            {(claim.triggeredRules || []).map((r) => (
              <div key={r.code} className="flex items-start gap-3 rounded-xl border border-danger-500/20 bg-danger-500/[.05] p-3">
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-danger-500/15 text-xs font-bold text-danger-400">
                  {r.weight}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold text-white">{r.name}</p>
                    <span className="chip border-white/10 bg-white/5 text-[9px] text-slate-400">{r.category}</span>
                    {r.targets && <span className="text-[9px] text-slate-500">↳ {r.targets}</span>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{r.detail}</p>
                  <p className="mt-0.5 font-mono text-[9px] text-slate-600">{r.code}</p>
                </div>
              </div>
            ))}
            {!claim.triggeredRules?.length && (
              <EmptyState title="No red flags" message="Every deterministic rule passed for this claim." />
            )}
          </div>
        </Card>
      )}

      {tab === 'features' && (
        <Card>
          <CardHeader title="Engineered feature vector" subtitle="Exactly what the 32-feature model consumed — the same numbers the Python service computed"
            action={<InfoTip text="Derived server-side by featureService.js. Values are the unstandardised features; the model standardises them internally." />} />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Object.entries(features).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-white/[.06] bg-white/[.02] px-3 py-2">
                <p className="truncate text-[10px] font-medium uppercase tracking-wider text-slate-500">{k.replace(/_/g, ' ')}</p>
                <p className="font-mono text-sm text-slate-200">{Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 })}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === 'context' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Provider profile" subtitle={provider?.providerId}
              action={<Link to={`/providers/${claim.providerId}`} className="text-xs font-semibold text-brand-400 hover:underline">Full profile →</Link>} />
            {provider ? (
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                <Field label="Name" value={provider.name} />
                <Field label="Specialty" value={provider.specialty} />
                <Field label="Location" value={`${provider.city}, ${provider.state}`} />
                <Field label="Licence" value={provider.licenseNumber} mono />
                <Field label="Network" value={provider.inNetwork ? 'In-network' : 'Out-of-network'} />
                <Field label="Licence age" value={`${provider.licenseAgeYears} years`} />
                <Field label="Prior findings" value={provider.fraudHistory} />
                <Field label="Peer avg billed" value={inr(provider.peerAvgBilled)} />
                <Field label="Total claims" value={provider.claimsCount} />
                <Field label="Flagged claims" value={provider.flaggedCount} />
              </div>
            ) : <p className="text-xs text-slate-500">Provider record not found.</p>}
            {provider?.onWatchlist && (
              <p className="mt-3 rounded-lg border border-danger-500/25 bg-danger-500/10 px-3 py-2 text-[11px] text-danger-400">
                ⚠ Provider is on the SIU watchlist following a confirmed adverse finding.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Member profile" subtitle={member?.memberId} />
            {member ? (
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                <Field label="Name" value={member.name} />
                <Field label="Age" value={member.age} />
                <Field label="Plan" value={member.planType} />
                <Field label="Policy age" value={`${member.policyAgeMonths} months`} />
                <Field label="Chronic conditions" value={member.chronicConditions} />
                <Field label="Annual premium" value={inr(member.annualPremium)} />
                <Field label="Total claims" value={member.claimsCount} />
                <Field label="Flagged claims" value={member.flaggedCount} />
                <Field label="Location" value={`${member.city}, ${member.state}`} />
                <Field label="Gender" value={member.gender} />
              </div>
            ) : <p className="text-xs text-slate-500">Member record not found.</p>}
          </Card>
        </div>
      )}

      {tab === 'history' && (
        <Card>
          <CardHeader title="Other claims by this member" subtitle="Repeat billing, same-day duplicates and ring activity show up here" />
          {relatedClaims.length ? (
            <div className="table-wrap">
              <table className="w-full">
                <thead><tr>
                  <th className="th">Claim</th><th className="th">Service date</th><th className="th">Provider</th>
                  <th className="th text-right">Billed</th><th className="th">Risk</th><th className="th">Status</th>
                </tr></thead>
                <tbody>
                  {relatedClaims.map((c) => (
                    <tr key={c.claimId} className="row">
                      <td className="td"><Link to={`/claims/${c.claimId}`} className="font-mono text-xs text-brand-400 hover:underline">{c.claimId}</Link></td>
                      <td className="td text-xs">{dateStr(c.serviceDate)}</td>
                      <td className="td text-xs">{c.providerName}</td>
                      <td className="td text-right font-mono text-xs">{inr(c.amountBilled)}</td>
                      <td className="td"><RiskBadge level={c.riskLevel} score={c.riskScore} /></td>
                      <td className="td"><StatusBadge status={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No sibling claims" message="This is the member's only claim in the ledger." />}
        </Card>
      )}

      {tab === 'notes' && (
        <Card>
          <CardHeader title="Investigator notes" subtitle="Immutable, timestamped audit trail" />
          <div className="space-y-2">
            {(claim.notes || []).map((n, i) => (
              <div key={i} className="rounded-xl border border-white/[.06] bg-white/[.02] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-200">{n.author}
                    {n.role && <span className="ml-2 text-[10px] capitalize text-slate-500">{n.role}</span>}</p>
                  <p className="text-[10px] text-slate-500">{dateTimeStr(n.at)}</p>
                </div>
                <p className="mt-1 text-xs text-slate-300">{n.text}</p>
              </div>
            ))}
            {!claim.notes?.length && <p className="text-xs text-slate-500">No notes yet.</p>}
          </div>
          <div className="mt-4 flex gap-2">
            <input className="input" placeholder="Add an investigation note…" value={note}
              onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.length > 2 && addNote()} />
            <button className="btn-primary shrink-0" disabled={note.length < 3 || busy === 'note'} onClick={addNote}>
              {busy === 'note' ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------- workflow actions */}
      <Card>
        <CardHeader title="Adjudication decision" subtitle={`Signed in as ${user?.name} (${user?.role})`} />
        <div className="flex flex-wrap gap-2">
          {[
            { status: 'under_review', label: 'Send to review', cls: 'btn-ghost' },
            { status: 'approved', label: 'Approve claim', cls: 'btn-ghost' },
            { status: 'rejected', label: 'Reject — fraud', cls: 'btn-danger' },
            { status: 'paid', label: 'Mark as paid', cls: 'btn-ghost' },
          ].map((a) => (
            <button key={a.status} className={a.cls} disabled={busy === a.status || (isResolved && claim.status === a.status)}
              onClick={() => setStatus(a.status)}>
              {busy === a.status ? 'Updating…' : a.label}
            </button>
          ))}
          <span className="ml-auto self-center text-[11px] text-slate-500">
            Last scored {dateTimeStr(claim.scoredAt)} · model {claim.modelVersion} · source {claim.scoringSource}
          </span>
        </div>
      </Card>
    </div>
  );
}
