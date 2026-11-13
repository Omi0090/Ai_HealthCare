import clsx from 'clsx';

/**
 * Renders a Shapley attribution as a horizontal waterfall.
 *
 * `top_features[].contribution` is in log-odds. We draw each feature as a bar
 * from the running total to the total after that feature, exactly like the
 * SHAP force/waterfall plots in the literature, so an investigator can read
 * "start at the population baseline, this feature pushed it up, that one pulled
 * it down, land on the final score".
 */
export default function ShapWaterfall({ explanation, compact = false }) {
  if (!explanation?.top_features?.length) {
    return (
      <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
        No explanation stored for this claim. Use “Re-run AI analysis” to generate one.
      </p>
    );
  }

  const feats = explanation.top_features;
  const base = Number(explanation.base_value ?? explanation.expected_logit ?? 0);
  const claimLogit = Number(explanation.claim_logit ?? 0);
  const totalAbs = feats.reduce((s, f) => s + Math.abs(f.contribution), 0) || 1;

  // Build cumulative steps
  let running = base;
  const steps = feats.map((f) => {
    const from = running;
    running += f.contribution;
    return { ...f, from, to: running };
  });

  const lo = Math.min(base, running, ...steps.map((s) => Math.min(s.from, s.to)));
  const hi = Math.max(base, running, ...steps.map((s) => Math.max(s.from, s.to)));
  const pad = (hi - lo) * 0.12 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const pctOf = (v) => ((v - min) / (max - min)) * 100;

  const odds = (l) => Math.exp(l);
  const toProb = (l) => 1 / (1 + Math.exp(-l));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-danger-500" /> increases risk
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-brand-500" /> decreases risk
          </span>
        </div>
        <span className="font-mono text-slate-500">
          log-odds {claimLogit >= 0 ? '+' : ''}{claimLogit.toFixed(2)}
        </span>
      </div>

      {/* axis */}
      <div className="relative h-6 rounded-lg bg-white/[.03]">
        <div className="absolute inset-y-0 left-0 rounded-l-lg bg-brand-500/[.06]" style={{ width: `${pctOf(0)}%` }} />
        <div className="absolute inset-y-0 rounded-r-lg bg-danger-500/[.06]" style={{ left: `${pctOf(0)}%`, right: 0 }} />
        <div className="absolute inset-y-0 w-px bg-white/20" style={{ left: `${pctOf(0)}%` }} />
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-brand-400/70">lower risk</span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-danger-400/70">higher risk</span>
      </div>

      <div className={clsx('space-y-1.5', compact && 'max-h-[300px] overflow-y-auto pr-1')}>
        {steps.map((s) => {
          const increasing = s.contribution > 0;
          const left = pctOf(Math.min(s.from, s.to));
          const width = Math.max(0.6, Math.abs(pctOf(s.to) - pctOf(s.from)));
          return (
            <div key={s.feature} className="group grid grid-cols-[minmax(0,1fr)_200px_84px] items-center gap-2.5 sm:grid-cols-[minmax(0,1.4fr)_240px_88px]">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-slate-300">{s.label}</p>
                <p className="font-mono text-[10px] text-slate-500">
                  value {Number(s.value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </p>
              </div>

              <div className="relative h-5 rounded bg-white/[.03]">
                <div className="absolute inset-y-0 w-px bg-white/10" style={{ left: `${pctOf(0)}%` }} />
                <div
                  className={clsx('absolute inset-y-0.5 rounded-sm transition-all duration-500',
                    increasing ? 'bg-danger-500/80 group-hover:bg-danger-400' : 'bg-brand-500/80 group-hover:bg-brand-400')}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${s.contribution.toFixed(3)} log-odds`}
                />
              </div>

              <div className="text-right">
                <span className={clsx('font-mono text-[11px] font-semibold', increasing ? 'text-danger-400' : 'text-brand-400')}>
                  {increasing ? '+' : ''}{s.contribution.toFixed(2)}
                </span>
                <p className="text-[9px] text-slate-500">{s.weight_pct?.toFixed(0)}% share</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* summary strip */}
      <div className="grid gap-2 rounded-xl border border-white/[.07] bg-ink-950/50 p-3 sm:grid-cols-4">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Baseline</p>
          <p className="font-mono text-sm font-semibold text-slate-300">{(toProb(base) * 100).toFixed(1)}%</p>
          <p className="text-[9px] text-slate-600">population prior</p>
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">This claim</p>
          <p className="font-mono text-sm font-semibold text-white">{(toProb(claimLogit) * 100).toFixed(1)}%</p>
          <p className="text-[9px] text-slate-600">model output</p>
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Odds</p>
          <p className="font-mono text-sm font-semibold text-danger-400">{odds(claimLogit - base).toFixed(1)}×</p>
          <p className="text-[9px] text-slate-600">vs baseline</p>
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Method</p>
          <p className="truncate text-[11px] font-semibold capitalize text-slate-300">
            {(explanation.method || 'shapley').replace(/_/g, ' ')}
          </p>
          <p className="text-[9px] text-slate-600">
            {explanation.permutations ? `${explanation.permutations} permutations` : explanation.stability ? `stability ${(explanation.stability * 100).toFixed(0)}%` : 'exact'}
          </p>
        </div>
      </div>
    </div>
  );
}
