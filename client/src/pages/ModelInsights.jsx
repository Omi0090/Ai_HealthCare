import { useEffect, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../lib/api';
import { num, pct, titleize } from '../lib/format';
import { Card, CardHeader, InfoTip, Loading, PageHeader, Progress, Stat } from '../components/ui';

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-ink-850/95 px-3 py-2 shadow-xl">
      {label != null && <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-xs text-slate-200">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-slate-400">{p.name}:</span>
          <span className="font-mono font-semibold">{typeof p.value === 'number' ? p.value.toFixed(3) : p.value}</span>
        </p>
      ))}
    </div>
  );
};

const MODEL_META = {
  logistic_regression: { label: 'Logistic Regression', role: 'Interpretable baseline', color: '#60a5fa', desc: 'Linear decision boundary on standardised features. Weakest alone but fully explainable — its coefficients are exported to the Node server as the offline fallback.' },
  random_forest: { label: 'Random Forest', role: 'Bagged trees', color: '#a78bfa', desc: '500 trees with balanced sub-sampling. Captures non-linear interactions and is robust to outliers and feature scale.' },
  gradient_boosting: { label: 'Histogram Gradient Boosting', role: 'Boosted trees · champion', color: '#1eb774', desc: 'Sequentially boosted trees fitting the residual error of the previous stage. Best PR-AUC on this dataset and the model used for Shapley explanations.' },
  isolation_forest: { label: 'Isolation Forest', role: 'Unsupervised anomaly detection', color: '#f59e0b', desc: 'Trained without labels: isolates anomalies by random partitioning. Catches schemes that never appeared in the training labels.' },
  hybrid_ensemble: { label: 'Hybrid Ensemble', role: 'Production scorer', color: '#f43f5e', desc: 'Weighted fusion of the boosted champion, the linear model and the anomaly detector, with a rules floor. This is what actually scores claims.' },
};

export default function ModelInsights() {
  const [info, setInfo] = useState(null);
  const [rules, setRules] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/admin/system'), api.get('/admin/rules')])
      .then(([sys, rl]) => { setInfo(sys.data); setRules(rl.data); })
      .catch((e) => setError(e.friendlyMessage || 'Failed to load model info'));
  }, []);

  if (error) return <p className="text-sm text-danger-400">{error}</p>;
  if (!info) return <Loading rows={10} />;

  const ml = info.ml;
  const modelInfo = info.modelMetrics || {};
  const metrics = info.models || {};

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Model Insights"
        subtitle="Full transparency into the detection stack: what was trained, how it performs, and which features drive decisions."
        actions={
          <span className={`chip ${ml.reachable
            ? 'border-brand-500/30 bg-brand-500/10 text-brand-400'
            : 'border-warn-500/30 bg-warn-500/10 text-warn-400'}`}>
            {ml.reachable ? 'Inference service online' : 'Offline — linear fallback active'}
          </span>
        }
      />

      {/* ------------------------------------------------------- runtime */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Inference service" value={ml.reachable ? 'Online' : 'Fallback'} tone={ml.reachable ? 'brand' : 'warn'}
          sub={ml.url} />
        <Stat label="Models loaded" value={num(ml.models?.length || 0)} tone="info" sub={ml.models?.join(', ')} />
        <Stat label="Fusion weights" value="60/30/10" tone="slate" sub="model · rules · anomaly" />
        <Stat label="Flag threshold" value={info.flagThreshold} tone="danger" sub="composite risk ≥ threshold is flagged" />
      </div>

      {/* -------------------------------------------------- model cards */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {Object.entries(MODEL_META).map(([key, meta]) => {
          const m = metrics?.[key];
          const weight = key === 'hybrid_ensemble' ? 1
            : info.ml?.champion === key ? 0.7 : key === 'isolation_forest' ? 0.1 : 0.2;
          return (
            <Card key={key} className={key === 'hybrid_ensemble' ? 'border-danger-500/25' : ''}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
                    <h3 className="text-sm font-semibold text-white">{meta.label}</h3>
                  </div>
                  <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">{meta.role}</p>
                </div>
                {key === 'gradient_boosting' && (
                  <span className="chip border-brand-500/30 bg-brand-500/10 text-[9px] text-brand-400">Champion</span>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{meta.desc}</p>

              {m ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    ['PR-AUC', m.pr_auc],
                    ['ROC-AUC', m.roc_auc],
                    ['F1', m.f1],
                    ['Precision', m.precision],
                    ['Recall', m.recall],
                    ['KS stat', m.ks],
                  ].map(([label, v]) => (
                    <div key={label} className="rounded-lg bg-white/[.03] px-2.5 py-1.5">
                      <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
                      <p className="font-mono text-sm font-semibold text-slate-100">{Number(v ?? 0).toFixed(3)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-slate-500">Metrics unavailable — run train_models.py.</p>
              )}

              <div className="mt-3 border-t border-white/[.06] pt-2">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-slate-500">Ensemble weight</span>
                  <span className="font-mono text-slate-300">{(weight * 100).toFixed(0)}%</span>
                </div>
                <Progress value={weight * 100} tone={key === 'hybrid_ensemble' ? 'danger' : 'brand'} height="h-1" />
              </div>
            </Card>
          );
        })}
      </div>

      {/* ------------------------------------------------------- curves */}
      {modelInfo?.curves && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Precision–Recall curve" subtitle="The honest curve for imbalanced fraud data (11% prevalence)"
              action={<InfoTip text="PR-AUC summarises performance when positives are rare. ROC-AUC is inflated here because the true-negative pool is huge." />} />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={modelInfo.curves.pr || []}
                  margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
                  <XAxis dataKey="recall" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                    label={{ value: 'recall', fill: '#64748b', fontSize: 10, position: 'insideBottom', offset: -2 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip />} />
                  <ReferenceLine y={0.11} stroke="#475569" strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="precision" name="precision" stroke="#1eb774" strokeWidth={2} fill="#1eb774" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">Dashed line = fraud prevalence (random-guess precision).</p>
          </Card>

          <Card>
            <CardHeader title="ROC curve" subtitle="True-positive rate vs false-positive rate" />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={modelInfo.curves.roc || []} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
                  <XAxis dataKey="fpr" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                    label={{ value: 'false positive rate', fill: '#64748b', fontSize: 10, position: 'insideBottom', offset: -2 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip />} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#475569" strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="tpr" name="true positive rate" stroke="#3b82f6" strokeWidth={2} fill="#3b82f6" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">Dashed diagonal = random classifier.</p>
          </Card>
        </div>
      )}

      {/* -------------------------------------------------- feature importance */}
      {info.featureImportance && (
        <Card>
          <CardHeader title="Permutation feature importance"
            subtitle="Mean drop in PR-AUC when each feature is randomly shuffled on the held-out test set"
            action={<InfoTip text="Permutation importance measures how much the model relies on a feature at inference time. It is model-agnostic and immune to the bias of impurity-based importance toward high-cardinality features." />} />
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={info.featureImportance.slice(0, 16)} layout="vertical"
                margin={{ top: 4, right: 24, left: 140, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="label" width={140} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="importance" name="importance" radius={[0, 3, 3, 0]}>
                  {info.featureImportance.slice(0, 16).map((f, i) => (
                    <Cell key={f.feature} fill={i < 5 ? '#1eb774' : i < 10 ? '#3b82f6' : '#475569'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* -------------------------------------------------- operating points */}
      {info.operatingPoints && (
        <Card>
          <CardHeader title="Operating points"
            subtitle="How the review queue scales with the recall you demand — this is the conversation an SIU actually has with finance" />
          <div className="table-wrap">
            <table className="w-full">
              <thead><tr>
                <th className="th">Recall target</th><th className="th">Threshold</th><th className="th">Achieved recall</th>
                <th className="th">Precision</th><th className="th">Alerts</th><th className="th">Alert rate</th><th className="th">Queue load</th>
              </tr></thead>
              <tbody>
                {info.operatingPoints.map((o) => (
                  <tr key={o.recall_target} className="row">
                    <td className="td font-mono text-xs">{pct(o.recall_target * 100, 0)}</td>
                    <td className="td font-mono text-xs text-slate-400">{o.threshold}</td>
                    <td className="td font-mono text-xs text-brand-400">{pct(o.recall * 100)}</td>
                    <td className="td font-mono text-xs text-info-400">{pct(o.precision * 100)}</td>
                    <td className="td font-mono text-xs">{num(o.alerts)}</td>
                    <td className="td font-mono text-xs">{pct(o.alert_rate * 100)}</td>
                    <td className="td">
                      <div className="w-28"><Progress value={o.alert_rate * 100} tone={o.alert_rate > 0.15 ? 'danger' : 'brand'} height="h-1.5" /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* --------------------------------------------------------- rules */}
      <Card>
        <CardHeader title="Deterministic rule catalogue"
          subtitle="Seventeen auditable red-flag rules run alongside the model. Their combined score carries 30% of the composite risk."
          action={<span className="chip border-white/10 bg-white/[.04] text-slate-400">{rules?.catalogue?.length || 0} rules</span>} />
        <div className="table-wrap">
          <table className="w-full">
            <thead><tr>
              <th className="th">Code</th><th className="th">Rule</th><th className="th">Category</th>
              <th className="th">Targets scheme</th><th className="th text-right">Weight</th><th className="th text-right">Observed lift</th>
            </tr></thead>
            <tbody>
              {(rules?.catalogue || []).map((r) => {
                const obs = (rules?.observed || []).find((o) => o.rule?.toLowerCase().includes(r.name.slice(0, 14).toLowerCase()));
                return (
                  <tr key={r.code} className="row">
                    <td className="td font-mono text-[10px] text-slate-500">{r.code}</td>
                    <td className="td text-xs text-slate-200">{r.name}</td>
                    <td className="td text-[11px] text-slate-400">{r.category}</td>
                    <td className="td text-[10px] text-slate-500">{r.targets}</td>
                    <td className="td text-right font-mono text-xs text-warn-400">{r.weight}</td>
                    <td className="td text-right font-mono text-xs">
                      {obs ? <span className={obs.lift >= 3 ? 'text-danger-400' : 'text-slate-400'}>{obs.lift}×</span> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Methodology notes" subtitle="What a viva examiner will ask" />
        <div className="grid gap-4 text-[11px] leading-relaxed text-slate-400 md:grid-cols-2">
          <div>
            <p className="mb-1 font-semibold text-slate-200">Why three supervised models?</p>
            <p>A linear baseline, a bagged ensemble and a boosted ensemble fail in different ways. Fusing
              them (with weights chosen by validation grid search) is more robust than picking one winner.</p>
            <p className="mt-2 font-semibold text-slate-200">Why an unsupervised model too?</p>
            <p>Supervised models can only detect schemes present in the labels. Isolation Forest scores
              novelty, so a brand-new fraud pattern still produces an alert.</p>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-200">Why PR-AUC and not accuracy?</p>
            <p>With 11% prevalence, a model that predicts “legitimate” always scores 89% accuracy and zero
              utility. PR-AUC only rewards finding positives.</p>
            <p className="mt-2 font-semibold text-slate-200">Why Shapley values?</p>
            <p>They are the only attribution method that satisfies local accuracy, missingness and
              consistency — which is what makes an explanation defensible in a dispute.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
