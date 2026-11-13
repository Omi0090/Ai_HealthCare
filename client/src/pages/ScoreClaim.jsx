import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import api from '../lib/api';
import { inr, riskMeta, titleize } from '../lib/format';
import { Card, CardHeader, RiskBadge, RiskMeter, Loading } from '../components/ui';
import ShapWaterfall from '../components/ShapWaterfall';

/**
 * Live claim adjudication simulator.
 *
 * Two modes:
 *  - "Score only" calls POST /api/claims/preview (no persistence) so a user can
 *    iterate freely;
 *  - "Submit claim" persists through POST /api/claims and lands in the ledger.
 *
 * Four presets reproduce the documented fraud archetypes so a demo can walk the
 * examiner through upcoding, phantom billing, duplicate billing and a clean claim.
 */

/** Presets use *recent* service dates so the claim looks like a fresh
 *  submission rather than a 300-day-late one (which is itself a red flag). */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const PRESETS = {
  clean: {
    label: 'Legitimate claim',
    desc: 'Routine outpatient visit, in-network, plausible coding',
    tone: 'brand',
    data: {
      claimType: 'outpatient', amountBilled: 4200, amountApproved: 3300, unitsClaimed: 1,
      serviceDays: 1, nightsInHospital: 0, numProcedures: 1, isEmergency: 0,
      serviceDate: daysAgo(3),
    },
  },
  upcoding: {
    label: 'Upcoding',
    desc: 'A minor procedure billed as a major one — amount inflated, coding mismatch',
    tone: 'warn',
    data: {
      claimType: 'inpatient', amountBilled: 385000, amountApproved: 360000, unitsClaimed: 3,
      serviceDays: 2, nightsInHospital: 1, numProcedures: 4, isEmergency: 0,
      serviceDate: daysAgo(2),
    },
  },
  phantom: {
    label: 'Phantom billing',
    desc: 'Services never rendered — huge units, impossible volume, high approval',
    tone: 'danger',
    data: {
      claimType: 'pharmacy', amountBilled: 640000, amountApproved: 630000, unitsClaimed: 42,
      serviceDays: 1, nightsInHospital: 0, numProcedures: 14, isEmergency: 0,
      pharmacyQty: 60, pharmacyRefillDays: 30, serviceDate: daysAgo(4),
    },
  },
  los: {
    label: 'LOS inflation',
    desc: 'Length of stay stretched far beyond medical necessity',
    tone: 'danger',
    data: {
      claimType: 'inpatient', amountBilled: 720000, amountApproved: 690000, unitsClaimed: 6,
      serviceDays: 34, nightsInHospital: 33, numProcedures: 5, isEmergency: 1,
      serviceDate: daysAgo(5),
    },
  },
};

const emptyForm = {
  providerId: '', memberId: '', claimType: 'inpatient', procedureCode: 'Consultation',
  diagnosisCode: 'E11', serviceDate: new Date().toISOString().slice(0, 10),
  amountBilled: 25000, amountApproved: 19000, unitsClaimed: 1, serviceDays: 1,
  nightsInHospital: 0, numProcedures: 1, isEmergency: 0, pharmacyQty: 1,
  pharmacyRefillDays: 30, notes: '',
};

export default function ScoreClaim() {
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preset, setPreset] = useState('');

  useEffect(() => {
    api.get('/dashboard/providers', { params: { limit: 400 } })
      .then((r) => {
        const list = r.data.providers || [];
        setProviders(list);
        if (list.length) setForm((f) => ({ ...f, providerId: list[0].providerId, memberId: 'MEM00001' }));
      })
      .catch(() => {});
  }, []);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.providerId === form.providerId),
    [providers, form.providerId]
  );

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const applyPreset = (key) => {
    setPreset(key);
    const p = PRESETS[key];
    setForm((f) => ({ ...f, ...p.data }));
    setResult(null);
    setError('');
  };

  const run = async (persist = false) => {
    setBusy(persist ? 'submit' : 'score');
    setError('');
    try {
      const payload = {
        ...form,
        amountBilled: Number(form.amountBilled),
        amountApproved: Number(form.amountApproved),
        unitsClaimed: Number(form.unitsClaimed),
        serviceDays: Number(form.serviceDays),
        nightsInHospital: Number(form.nightsInHospital),
        numProcedures: Number(form.numProcedures),
        isEmergency: Number(form.isEmergency),
        pharmacyQty: Number(form.pharmacyQty),
        pharmacyRefillDays: Number(form.pharmacyRefillDays),
      };
      if (persist) {
        const res = await api.post('/claims', payload);
        setResult({ ...res.data.claim, persisted: true, narrative: res.data.narrative });
      } else {
        const res = await api.post('/claims/preview', payload);
        setResult(res.data);
      }
    } catch (e) {
      setError(e.friendlyMessage || 'Scoring failed');
    } finally {
      setBusy('');
    }
  };

  const meta = result ? riskMeta(result.riskLevel) : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Live Claim Adjudication</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Submit a claim and watch the full pipeline run: feature engineering → 4-model ensemble →
          rule engine → risk fusion → Shapley explanation. Nothing is persisted unless you click
          <span className="text-slate-200"> Submit to ledger</span>.
        </p>
      </div>

      {/* presets */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(PRESETS).map(([key, p]) => (
          <button key={key} onClick={() => applyPreset(key)}
            className={clsx('card card-hover p-4 text-left transition',
              preset === key && 'ring-2 ring-brand-500/50')}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-white">{p.label}</p>
              <span className={clsx('h-2 w-2 rounded-full',
                p.tone === 'brand' ? 'bg-brand-400' : p.tone === 'warn' ? 'bg-warn-400' : 'bg-danger-400')} />
            </div>
            <p className="mt-1 text-[11px] leading-snug text-slate-400">{p.desc}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
        {/* ------------------------------------------------------- form */}
        <Card className="h-fit">
          <CardHeader title="Claim details" subtitle="Adjust any field — the score updates live" />

          <div className="space-y-3">
            <div>
              <label className="label">Provider</label>
              <select className="input" value={form.providerId} onChange={(e) => set('providerId', e.target.value)}>
                {providers.map((p) => (
                  <option key={p.providerId} value={p.providerId}>
                    {p.name} — {p.specialty} ({p.providerId})
                  </option>
                ))}
              </select>
              {selectedProvider && (
                <p className="mt-1 text-[10px] text-slate-500">
                  Peer avg {inr(selectedProvider.peerAvgBilled, { compact: true })} ·
                  {' '}{selectedProvider.inNetwork ? 'in-network' : 'out-of-network'} ·
                  {' '}{selectedProvider.fraudHistory} prior finding(s)
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Member ID</label>
                <input className="input" value={form.memberId} list="member-options"
                  onChange={(e) => set('memberId', e.target.value)}
                  placeholder="MEM00001" />
                <datalist id="member-options">
                  {Array.from({ length: 8 }, (_, i) => `MEM0000${i + 1}`).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <p className="mt-1 text-[10px] text-slate-500">Any of MEM00001 … MEM01099</p>
              </div>
              <div>
                <label className="label">Claim type</label>
                <select className="input" value={form.claimType} onChange={(e) => set('claimType', e.target.value)}>
                  {['inpatient', 'outpatient', 'pharmacy', 'laboratory', 'dental', 'vision'].map((t) => (
                    <option key={t} value={t}>{titleize(t)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Procedure</label>
                <input className="input" value={form.procedureCode} onChange={(e) => set('procedureCode', e.target.value)} />
              </div>
              <div>
                <label className="label">Diagnosis</label>
                <input className="input" value={form.diagnosisCode} onChange={(e) => set('diagnosisCode', e.target.value)} />
              </div>
            </div>

            <div>
              <label className="label">Service date</label>
              <input type="date" className="input" value={form.serviceDate} onChange={(e) => set('serviceDate', e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[
                ['amountBilled', 'Amount billed (₹)', 1000, 5000000],
                ['amountApproved', 'Amount approved (₹)', 0, 5000000],
                ['unitsClaimed', 'Units claimed', 1, 80],
                ['numProcedures', 'Procedures', 1, 40],
                ['serviceDays', 'Service days', 0, 90],
                ['nightsInHospital', 'Nights in hospital', 0, 90],
              ].map(([key, label, min, max]) => (
                <div key={key}>
                  <label className="label">{label}</label>
                  <input type="number" min={min} max={max} className="input" value={form[key]}
                    onChange={(e) => set(key, e.target.value)} />
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4 rounded-xl border border-white/[.07] bg-white/[.02] px-3 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={Number(form.isEmergency) === 1}
                  onChange={(e) => set('isEmergency', e.target.checked ? 1 : 0)}
                  className="h-3.5 w-3.5 rounded border-white/20 bg-ink-950 accent-brand-500" />
                Emergency admission
              </label>
              {form.claimType === 'pharmacy' && (
                <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-400">
                  Qty
                  <input type="number" className="input w-16 px-2 py-1 text-xs" value={form.pharmacyQty}
                    onChange={(e) => set('pharmacyQty', e.target.value)} />
                  / 30d
                </div>
              )}
            </div>

            {error && (
              <div className="rounded-xl border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-400">{error}</div>
            )}

            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={() => run(false)} disabled={busy !== ''}>
                {busy === 'score' ? 'Scoring…' : 'Score claim'}
              </button>
              <button className="btn-ghost" onClick={() => run(true)} disabled={busy !== ''}>
                {busy === 'submit' ? 'Submitting…' : 'Submit to ledger'}
              </button>
            </div>
          </div>
        </Card>

        {/* ---------------------------------------------------- result */}
        <div className="space-y-4">
          {!result && (
            <Card className="grid min-h-[420px] place-items-center">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/10 text-brand-400">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-white">Ready to adjudicate</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  Pick a preset on the left to see how a specific fraud scheme is caught, or build
                  your own claim and press <b className="text-slate-200">Score claim</b>.
                </p>
              </div>
            </Card>
          )}

          {busy && <Card><Loading rows={3} /></Card>}

          {result && !busy && (
            <>
              <Card className={clsx('border-2', meta.border)}>
                <div className="flex flex-wrap items-center justify-between gap-5">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Decision</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <RiskBadge level={result.riskLevel} size="lg" />
                      <span className={clsx('chip',
                        result.isFlagged
                          ? 'border-danger-500/30 bg-danger-500/10 text-danger-400'
                          : 'border-brand-500/30 bg-brand-500/10 text-brand-400')}>
                        {result.isFlagged ? 'Referred to investigation' : 'Straight-through processing'}
                      </span>
                    </div>
                    <p className="mt-3 text-3xl font-bold text-white">{(result.fraudProbability * 100).toFixed(1)}%</p>
                    <p className="text-xs text-slate-400">probability of fraud · composite risk {result.riskScore}/100</p>
                  </div>

                  <RiskMeter score={result.riskScore} size={120} label="risk score" />
                </div>

                <div className="mt-5 grid gap-3 border-t border-white/[.07] pt-4 sm:grid-cols-4">
                  {[
                    { label: 'ML ensemble', value: result.fraudProbability, tone: 'bg-danger-500' },
                    { label: 'Rule engine', value: result.ruleScore, tone: 'bg-warn-500' },
                    { label: 'Anomaly', value: result.anomalyScore || 0, tone: 'bg-info-500' },
                    { label: 'Threshold', value: result.threshold || 0.62, tone: 'bg-slate-500', isThreshold: true },
                  ].map((s) => (
                    <div key={s.label}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{s.label}</p>
                      <p className="font-mono text-lg font-bold text-slate-100">{((s.value || 0) * 100).toFixed(1)}%</p>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[.07]">
                        <div className={clsx('h-full rounded-full', s.tone)} style={{ width: `${Math.min(100, (s.value || 0) * 100)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>

                {result.modelScores && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[.07] pt-3">
                    {Object.entries(result.modelScores).map(([name, v]) => (
                      <span key={name} className="chip border-white/10 bg-white/[.04] text-slate-400">
                        {titleize(name)} <span className="font-mono text-slate-200">{(v * 100).toFixed(1)}%</span>
                      </span>
                    ))}
                    {result.scoringSource && (
                      <span className="chip border-info-500/25 bg-info-500/10 text-info-400">
                        source: {result.scoringSource}
                      </span>
                    )}
                  </div>
                )}

                {result.narrative && (
                  <p className="mt-4 rounded-xl border border-white/[.07] bg-ink-950/40 p-3 text-[11px] leading-relaxed text-slate-300">
                    {result.narrative}
                  </p>
                )}

                {result.persisted && (
                  <div className="mt-3 flex items-center justify-between rounded-xl border border-brand-500/25 bg-brand-500/[.07] px-3 py-2">
                    <p className="text-[11px] text-brand-300">Claim saved to the ledger as <span className="font-mono">{result.claimId}</span></p>
                    <Link to={`/claims/${result.claimId}`} className="text-[11px] font-semibold text-brand-400 hover:underline">Open →</Link>
                  </div>
                )}
              </Card>

              {result.triggeredRules?.length > 0 && (
                <Card>
                  <CardHeader title="Red flags triggered" subtitle={`${result.triggeredRules.length} deterministic rule(s) fired`} />
                  <div className="space-y-1.5">
                    {result.triggeredRules.map((r) => (
                      <div key={r.code} className="flex items-start gap-2.5 rounded-lg border border-danger-500/15 bg-danger-500/[.04] px-3 py-2">
                        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-danger-500/20 text-[9px] font-bold text-danger-400">
                          {r.weight}
                        </span>
                        <div>
                          <p className="text-[11px] font-semibold text-slate-200">{r.name}</p>
                          <p className="text-[10px] text-slate-500">{r.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {result.explanation && (
                <Card>
                  <CardHeader title="Why? — Shapley attribution"
                    subtitle="Each bar is the log-odds contribution of one engineered feature for this specific claim" />
                  <ShapWaterfall explanation={result.explanation} />
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
