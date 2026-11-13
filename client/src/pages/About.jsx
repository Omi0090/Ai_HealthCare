import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { num, pct } from '../lib/format';
import { Card, CardHeader, Loading, PageHeader } from '../components/ui';

/**
 * Project overview — written for the viva. It states, on one screen, what the
 * system is, how it works and what it measures, so the demo can start here.
 */
const PIPELINE = [
  { step: '1', title: 'Claim intake', body: 'A claim lands via POST /api/claims (or the simulator). Provider and member records are resolved, and the service date establishes 30-day and 12-month windows for behavioural features.' },
  { step: '2', title: 'Feature engineering', body: '32 features are derived from monetary, utilisation, integrity, temporal, provider and policy signals. Identical formulas in Python (training) and JavaScript (serving), pinned by an automated contract test.' },
  { step: '3', title: 'Ensemble scoring', body: 'Gradient boosting (champion), random forest, logistic regression and an unsupervised isolation forest score the claim. The logistic model is also exported to JSON so the API can score identically when Python is offline.' },
  { step: '4', title: 'Rule engine', body: '17 deterministic red-flag rules run in parallel. Each is auditable, weighted and mapped to the fraud scheme it targets.' },
  { step: '5', title: 'Risk fusion', body: 'risk = 0.60·model + 0.30·rules + 0.10·anomaly, plus a consensus bonus and a decisive-rule floor so hard evidence cannot be diluted by an unsure model.' },
  { step: '6', title: 'Explanation', body: 'Monte-Carlo Shapley values in log-odds space, so contributions are additive and the explanation is defensible in a dispute.' },
  { step: '7', title: 'Workflow', body: 'Flagged claims become cases. Investigators record findings and decisions; a confirmed-fraud decision feeds back into provider risk.' },
];

export default function About() {
  const [sys, setSys] = useState(null);
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    Promise.all([api.get('/admin/system'), api.get('/dashboard/overview')])
      .then(([s, o]) => { setSys(s.data); setOverview(o.data); })
      .catch(() => {});
  }, []);

  if (!sys || !overview) return <Loading rows={8} />;

  const ds = sys.modelMetrics?.dataset || {};
  const champ = sys.models?.gradient_boosting;
  const k = overview.kpis;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Project Overview"
        subtitle="AI-Based Healthcare Insurance Fraud Detection — MERN stack with a scikit-learn inference service. B.Tech final year project."
        actions={<Link to="/score" className="btn-primary">Try the live simulator →</Link>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="What this system does" subtitle="One paragraph, no jargon" />
          <p className="text-xs leading-relaxed text-slate-300">
            Health insurers lose billions to fraudulent claims. Investigators cannot read every claim, so they
            sample — which leaves most fraud unnoticed. This platform scores <b className="text-white">every</b> claim
            at submission time, ranks the portfolio by risk, and explains each decision in terms an investigator can
            act on. It then carries the claim through a full investigation workflow, and feeds confirmed outcomes back
            into provider risk so the system learns who to watch.
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {[
              ['Detection models', '4 (3 supervised + 1 unsupervised)'],
              ['Engineered features', '32, shared by training and serving'],
              ['Deterministic rules', '17, auditable and weighted'],
              ['Fraud schemes modelled', '7 archetypes + legitimate care'],
              ['Explainability', 'Monte-Carlo Shapley, log-odds space'],
              ['Access control', 'JWT + 4 RBAC roles + audit trail'],
            ].map(([a, b]) => (
              <div key={a} className="rounded-xl border border-white/[.06] bg-white/[.02] px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{a}</p>
                <p className="text-[11px] text-slate-200">{b}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Live system state" subtitle="Read from the running services" />
          <dl className="space-y-2 text-xs">
            {[
              ['Database', sys.database.kind === 'mongodb' ? 'MongoDB (Mongoose)' : 'JSON document store'],
              ['Claims in ledger', num(sys.database.counts.claims)],
              ['Investigations', num(sys.database.counts.cases)],
              ['ML service', sys.ml.reachable ? 'online (FastAPI)' : 'offline — linear fallback'],
              ['Champion model', champ ? 'gradient boosting' : '—'],
              ['PR-AUC (champion)', champ ? champ.pr_auc : '—'],
              ['5-fold CV PR-AUC', sys.modelMetrics?.cv_pr_auc ? `${sys.modelMetrics.cv_pr_auc.mean} ± ${sys.modelMetrics.cv_pr_auc.std}` : '—'],
              ['Flag rate', `${pct(k.flagRate)} of portfolio`],
              ['Precision / recall', `${k.modelPrecision}% / ${k.modelRecall}%`],
              ['API uptime', `${Math.floor(sys.uptimeSeconds / 60)} min`],
            ].map(([a, b]) => (
              <div key={a} className="flex items-center justify-between gap-3 border-b border-white/[.04] pb-1.5">
                <dt className="text-slate-500">{a}</dt>
                <dd className="text-right font-medium text-slate-200">{b}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card>
        <CardHeader title="How a claim is scored" subtitle="The seven-stage pipeline, end to end" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {PIPELINE.map((p) => (
            <div key={p.step} className="rounded-xl border border-white/[.06] bg-white/[.02] p-3">
              <div className="mb-1.5 grid h-6 w-6 place-items-center rounded-lg bg-brand-500/15 text-[11px] font-bold text-brand-400">
                {p.step}
              </div>
              <p className="text-xs font-semibold text-white">{p.title}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{p.body}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Dataset" subtitle="Synthetic payer ledger — reproducible, no real patient data" />
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Claims', num(ds.rows)],
              ['Features', ds.features],
              ['Fraud prevalence', `${((ds.fraud_rate || 0) * 100).toFixed(1)}%`],
              ['Train / test rows', `${num(ds.train_rows)} / ${num(ds.test_rows)}`],
            ].map(([a, b]) => (
              <div key={a} className="rounded-xl bg-white/[.03] px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">{a}</p>
                <p className="text-sm font-bold text-slate-100">{b}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
            Seven fraud archetypes — upcoding, phantom billing, duplicate billing, unbundling, length-of-stay
            inflation, collusion rings and identity misuse — each generated with a graded severity and independent
            signal dropout, so the model cannot learn one deterministic rule per scheme.
          </p>
        </Card>

        <Card>
          <CardHeader title="Where to look first" subtitle="A suggested demo path" />
          <ol className="space-y-2">
            {[
              ['Dashboard', '/', 'Portfolio KPIs, exposure and the 120-day trend'],
              ['Claims Explorer', '/claims', 'Filter by risk band, inspect any claim'],
              ['Claim detail', '/claims', 'AI explanation waterfall, red flags, workflow actions'],
              ['Live simulator', '/score', 'Score a claim with the four presets'],
              ['Investigations', '/cases', 'Record findings, close a case, watch provider risk update'],
              ['Fraud Network', '/network', 'Collusion rings as a bipartite graph'],
              ['AI Model', '/model', 'PR/ROC curves, feature importance, operating points'],
            ].map(([label, to, why], i) => (
              <li key={label} className="flex gap-2.5">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-white/5 text-[10px] font-bold text-slate-400">
                  {i + 1}
                </span>
                <div>
                  <Link to={to} className="text-xs font-semibold text-brand-400 hover:underline">{label}</Link>
                  <p className="text-[11px] text-slate-500">{why}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card>
        <CardHeader title="Honest limitations" subtitle="Stated up front, as any real system should" />
        <div className="grid gap-3 text-[11px] leading-relaxed text-slate-400 md:grid-cols-3">
          <div>
            <p className="mb-1 font-semibold text-slate-200">Synthetic training data</p>
            <p>The absolute metrics are not a claim about real-world performance. Retraining on a de-identified payer
              extract is the natural next step.</p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-200">Subtle schemes are harder</p>
            <p>Detection of low-severity upcoding and duplicate billing sits near 20%. Catching those needs external
              signals (prior-authorisation records, clinical notes), not a better tabular model.</p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-200">Not a certified adjudicator</p>
            <p>Every automated decision is a recommendation to a human investigator. The workflow, audit trail and
              explanations exist precisely so a human stays in the loop.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
