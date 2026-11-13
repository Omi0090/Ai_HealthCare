import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const DEMO_ACCOUNTS = [
  { email: 'admin@medguard.ai', role: 'Admin', desc: 'Full platform control' },
  { email: 'investigator@medguard.ai', role: 'Investigator', desc: 'Case investigation' },
  { email: 'analyst@medguard.ai', role: 'Analyst', desc: 'Claims scoring & analytics' },
  { email: 'viewer@medguard.ai', role: 'Viewer', desc: 'Read-only compliance view' },
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@medguard.ai');
  const [password, setPassword] = useState('MedGuard@2024');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.friendlyMessage || 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* -------------------------------------------------- brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-white/[.07] bg-ink-900 p-12 lg:flex">
        <div className="absolute inset-0 grid-lines opacity-40" />
        <div className="absolute -left-24 -top-24 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute -bottom-32 -right-20 h-96 w-96 rounded-full bg-info-500/15 blur-3xl" />

        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 shadow-glow">
              <svg className="h-6 w-6 text-ink-950" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3Z" strokeLinejoin="round" />
                <path d="m9 12 2 2 4-4" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-bold tracking-tight text-white">MedGuard <span className="text-brand-400">AI</span></p>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">Fraud Intelligence Platform</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-4xl font-bold leading-[1.15] tracking-tight text-white">
            Every fraudulent claim, <span className="text-gradient">explained before it is paid.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            MedGuard AI scores healthcare insurance claims in real time using a hybrid
            ensemble of gradient boosting, random forests, logistic regression and
            unsupervised anomaly detection — then tells your investigators exactly
            which features drove each decision.
          </p>

          <dl className="mt-8 grid grid-cols-3 gap-3">
            {[
              { k: '32', v: 'Engineered features' },
              { k: '4', v: 'ML models fused' },
              { k: '7', v: 'Fraud schemes covered' },
            ].map((s) => (
              <div key={s.v} className="rounded-xl border border-white/[.07] bg-white/[.03] p-3">
                <dt className="text-2xl font-bold text-brand-400">{s.k}</dt>
                <dd className="text-[11px] leading-tight text-slate-400">{s.v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 flex flex-wrap gap-2">
            {['Upcoding', 'Phantom billing', 'Duplicate billing', 'Unbundling', 'LOS inflation', 'Collusion rings', 'Identity misuse'].map((t) => (
              <span key={t} className="chip border-white/10 bg-white/[.04] text-slate-400">{t}</span>
            ))}
          </div>
        </div>

        <p className="relative text-[11px] text-slate-600">
          Synthetic dataset · no real patient data · MERN stack + scikit-learn · B.Tech final year project
        </p>
      </div>

      {/* ----------------------------------------------------- login form */}
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-md animate-slide-up">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2.5">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-ink-950">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3Z" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="text-lg font-bold text-white">MedGuard <span className="text-brand-400">AI</span></p>
            </div>
          </div>

          <h2 className="text-2xl font-bold tracking-tight text-white">Sign in to the SIU workspace</h2>
          <p className="mt-1 text-sm text-slate-400">Use a demo account below or your own credentials.</p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div>
              <label className="label" htmlFor="email">Work email</label>
              <input id="email" type="email" required className="input" value={email}
                onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" type="password" required className="input" value={password}
                onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>

            {error && (
              <div className="rounded-xl border border-danger-500/30 bg-danger-500/10 px-3.5 py-2.5 text-xs text-danger-400">
                {error}
              </div>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full py-3">
              {busy ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950" />
                  Signing in…
                </>
              ) : 'Sign in'}
            </button>
          </form>

          <div className="mt-8">
            <div className="mb-3 flex items-center gap-3">
              <div className="h-px flex-1 bg-white/[.07]" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Demo accounts</span>
              <div className="h-px flex-1 bg-white/[.07]" />
            </div>
            <div className="grid gap-2">
              {DEMO_ACCOUNTS.map((a) => (
                <button key={a.email} type="button"
                  onClick={() => { setEmail(a.email); setPassword('MedGuard@2024'); }}
                  className="flex items-center justify-between rounded-xl border border-white/[.07] bg-white/[.02] px-3.5 py-2.5 text-left transition hover:border-brand-500/30 hover:bg-brand-500/[.06]">
                  <div>
                    <p className="text-xs font-semibold text-slate-200">{a.role}</p>
                    <p className="text-[10px] text-slate-500">{a.desc}</p>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">{a.email}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-center text-[11px] text-slate-600">
              Password for all demo accounts: <span className="font-mono text-slate-400">MedGuard@2024</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
