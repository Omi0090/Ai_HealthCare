import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import { inr, num, riskMeta } from '../lib/format';
import { Card, CardHeader, EmptyState, Loading, PageHeader } from '../components/ui';

/**
 * Collusion-ring explorer.
 *
 * We render a bipartite provider ⇄ member graph of *flagged* claims. Repeated
 * edges between the same pair are the signature of a collusion ring: a provider
 * and a member transacting far more often than chance allows.
 *
 * Layout: a deterministic force simulation (repulsion + spring + centring)
 * implemented here rather than pulled from a library, so the visualisation has
 * no extra dependency and runs identically offline.
 */
function simulate(nodes, edges, iterations = 260) {
  const W = 1000;
  const H = 640;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const pos = nodes.map((n, i) => {
    // seed providers on the left half, members on the right — the structure of
    // the bipartite graph is then readable at a glance
    const angle = (i / nodes.length) * Math.PI * 2;
    return {
      x: n.type === 'provider' ? W * 0.3 + Math.cos(angle) * 130 : W * 0.7 + Math.cos(angle) * 130,
      y: H / 2 + Math.sin(angle) * 190,
      vx: 0,
      vy: 0,
    };
  });

  const link = edges
    .map((e) => ({ a: idx.get(e.source), b: idx.get(e.target), w: Math.min(3, 0.4 + e.weight / 4) }))
    .filter((l) => l.a != null && l.b != null);

  const deg = new Array(nodes.length).fill(0);
  for (const l of link) { deg[l.a] += l.w; deg[l.b] += l.w; }

  for (let it = 0; it < iterations; it += 1) {
    const alpha = 1 - it / iterations;
    // repulsion
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        let dx = pos[j].x - pos[i].x;
        let dy = pos[j].y - pos[i].y;
        let d2 = dx * dx + dy * dy || 1;
        if (d2 > 90000) continue;
        const f = (1600 * alpha) / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        pos[i].vx -= dx * f; pos[i].vy -= dy * f;
        pos[j].vx += dx * f; pos[j].vy += dy * f;
      }
    }
    // springs
    for (const l of link) {
      const a = pos[l.a]; const b = pos[l.b];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 150;
      const f = ((d - target) / d) * 0.055 * l.w * alpha;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    // centring + integrate
    for (let i = 0; i < pos.length; i += 1) {
      const p = pos[i];
      p.vx += (W / 2 - p.x) * 0.002;
      p.vy += (H / 2 - p.y) * 0.002;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.82; p.vy *= 0.82;
      p.x = Math.max(40, Math.min(W - 40, p.x));
      p.y = Math.max(30, Math.min(H - 30, p.y));
    }
  }
  return { pos, link, idx, W, H, deg };
}

export default function Network() {
  const [raw, setRaw] = useState(null);
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const [minWeight, setMinWeight] = useState(1);
  const svgRef = useRef(null);

  useEffect(() => {
    api.get('/dashboard/network')
      .then((r) => setRaw(r.data))
      .catch(() => setRaw({ nodes: [], edges: [] }));
  }, []);

  const graph = useMemo(() => {
    if (!raw?.nodes?.length) return null;
    const edges = raw.edges.filter((e) => e.weight >= minWeight);
    const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
    const nodes = raw.nodes
      .filter((n) => connected.has(n.id))
      .sort((a, b) => (a.type === 'provider' ? -1 : 1) - (b.type === 'provider' ? -1 : 1));
    if (!nodes.length) return null;
    return { nodes, edges, ...simulate(nodes, edges) };
  }, [raw, minWeight]);

  if (!raw) return <Loading rows={8} />;

  const neighbours = focus
    ? new Set(graph?.link.filter((l) => graph.nodes[l.a].id === focus || graph.nodes[l.b].id === focus)
      .flatMap((l) => [graph.nodes[l.a].id, graph.nodes[l.b].id]))
    : null;

  const focusedNode = focus ? graph?.nodes.find((n) => n.id === focus) : null;
  const focusedEdges = focus
    ? graph?.edges.filter((e) => e.source === focus || e.target === focus) || []
    : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Fraud Network Explorer"
        subtitle="Bipartite provider ⇄ member graph of flagged claims. Thick repeated edges are the signature of a collusion ring — a provider and member transacting far more often than chance."
        actions={
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-slate-400">Min link strength</label>
            <select className="input w-24 py-1.5 text-xs" value={minWeight} onChange={(e) => setMinWeight(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{w}+ claims</option>)}
            </select>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: 'Nodes in graph', value: num(graph?.nodes.length || 0) },
          { label: 'Provider–member links', value: num(graph?.edges.length || 0) },
          { label: 'Providers', value: num(graph?.nodes.filter((n) => n.type === 'provider').length || 0) },
          { label: 'Members', value: num(graph?.nodes.filter((n) => n.type === 'member').length || 0) },
        ].map((s) => (
          <div key={s.label} className="card p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{s.label}</p>
            <p className="mt-1 text-xl font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card className="p-2">
          {!graph ? (
            <EmptyState title="No connections at this threshold"
              message="Lower the minimum link strength to reveal weaker associations." />
          ) : (
            <div className="relative">
              <svg ref={svgRef} viewBox={`0 0 ${graph.W} ${graph.H}`} className="h-[560px] w-full">
                <defs>
                  <radialGradient id="glowP">
                    <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.85" />
                    <stop offset="100%" stopColor="#f43f5e" stopOpacity="0" />
                  </radialGradient>
                </defs>

                {graph.link.map((l, i) => {
                  const a = graph.pos[l.a];
                  const b = graph.pos[l.b];
                  const na = graph.nodes[l.a];
                  const nb = graph.nodes[l.b];
                  const dim = neighbours && !(neighbours.has(na.id) && neighbours.has(nb.id));
                  return (
                    <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={dim ? 'rgba(148,163,184,.08)' : 'rgba(244,63,94,.32)'}
                      strokeWidth={l.w}
                      onMouseEnter={() => setHover({ type: 'edge', a: na, b: nb, edge: graph.edges.find((e) => e.source === na.id && e.target === nb.id) })} />
                  );
                })}

                {graph.nodes.map((n, i) => {
                  const p = graph.pos[i];
                  const isProvider = n.type === 'provider';
                  const r = isProvider ? 5 + Math.min(9, n.claims / 3) : 3.5;
                  const dim = neighbours && !neighbours.has(n.id);
                  const color = riskMeta(isProvider ? (n.risk >= 70 ? 'critical' : n.risk >= 50 ? 'high' : n.risk >= 30 ? 'medium' : 'low') : 'info').solid;
                  return (
                    <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.15 : 1}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setFocus((f) => (f === n.id ? null : n.id))}
                      onMouseEnter={() => setHover({ type: 'node', node: n })}>
                      {isProvider && <circle r={r * 2.4} fill="url(#glowP)" opacity={n.risk / 140} />}
                      <circle r={r} fill={color}
                        stroke={focus === n.id ? '#fff' : 'rgba(255,255,255,.25)'} strokeWidth={focus === n.id ? 2 : 1}>
                        <title>{n.label} ({n.id}) · {n.claims} flagged claims · avg risk {n.risk}</title>
                      </circle>
                    </g>
                  );
                })}
              </svg>

              <div className="pointer-events-none absolute left-3 top-3 rounded-xl border border-white/10 bg-ink-950/80 px-3 py-2 text-[10px] backdrop-blur">
                <p className="flex items-center gap-1.5 text-slate-400"><span className="h-2 w-2 rounded-full bg-danger-500" /> provider</p>
                <p className="mt-1 flex items-center gap-1.5 text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-info-500" /> member</p>
                <p className="mt-1.5 text-slate-500">click a node to focus</p>
              </div>

              {hover && (
                <div className="pointer-events-none absolute bottom-3 left-3 max-w-xs rounded-xl border border-white/10 bg-ink-950/90 px-3 py-2 text-[11px] backdrop-blur">
                  {hover.type === 'node' ? (
                    <>
                      <p className="font-semibold text-white">{hover.node.label}</p>
                      <p className="font-mono text-[10px] text-slate-500">{hover.node.id} · {hover.node.type}</p>
                      <p className="mt-1 text-slate-400">{hover.node.claims} flagged claims · avg risk {hover.node.risk}</p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold text-white">{hover.a.label} ⇄ {hover.b.label}</p>
                      <p className="mt-1 text-slate-400">
                        {hover.edge?.weight} flagged claims · {inr(hover.edge?.amount, { compact: true })} billed
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title={focusedNode ? 'Focused entity' : 'Largest rings'}
              subtitle={focusedNode ? 'Connections for the selected node' : 'Provider ⇄ member pairs by repeat flagged claims'} />
            {focusedNode ? (
              <>
                <div className="rounded-xl border border-white/[.07] bg-white/[.02] p-3">
                  <p className="text-sm font-semibold text-white">{focusedNode.label}</p>
                  <p className="font-mono text-[10px] text-slate-500">{focusedNode.id} · {focusedNode.type}</p>
                  <p className="mt-1.5 text-xs text-slate-400">
                    {focusedNode.claims} flagged claims · avg risk <span className="font-mono text-slate-200">{focusedNode.risk}</span>
                  </p>
                  {focusedNode.type === 'provider' && (
                    <Link to={`/providers/${focusedNode.id}`} className="mt-2 inline-block text-[11px] font-semibold text-brand-400 hover:underline">
                      Open provider profile →
                    </Link>
                  )}
                </div>
                <div className="mt-2 max-h-60 space-y-1 overflow-y-auto">
                  {focusedEdges.slice(0, 30).map((e, i) => {
                    const other = e.source === focus ? e.target : e.source;
                    return (
                      <button key={i} onClick={() => setFocus(other)}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[.04]">
                        <span className="truncate font-mono text-[10px] text-slate-300">{other}</span>
                        <span className="shrink-0 font-mono text-[10px] text-danger-400">{e.weight}×</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                {[...(graph?.edges || [])].sort((a, b) => b.weight - a.weight).slice(0, 12).map((e, i) => (
                  <button key={i} onClick={() => setFocus(e.source)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/[.05] bg-white/[.02] px-2.5 py-1.5 text-left hover:bg-white/[.05]">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[10px] text-slate-300">{e.source}</p>
                      <p className="truncate font-mono text-[10px] text-slate-500">→ {e.target}</p>
                    </div>
                    <span className="shrink-0 rounded bg-danger-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-danger-400">
                      {e.weight}×
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <h4 className="text-sm font-semibold text-white">How to read this</h4>
            <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-slate-400">
              <li><b className="text-slate-200">Node size</b> scales with the number of flagged claims.</li>
              <li><b className="text-slate-200">Edge thickness</b> is how many flagged claims that pair shares.</li>
              <li><b className="text-slate-200">Repeated links</b> between one provider and one member (&gt;3 claims) are a
                strong collusion signal — legitimate care rarely clusters this tightly.</li>
              <li>Providers sit left, members right, so a <b className="text-slate-200">dense left cluster</b> means a
                single provider is pulling in many members.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
