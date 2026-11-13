import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="text-center">
        <p className="text-6xl font-bold text-gradient">404</p>
        <p className="mt-2 text-lg font-semibold text-white">Page not found</p>
        <p className="mt-1 text-sm text-slate-400">That route is not part of the MedGuard workspace.</p>
        <Link to="/" className="btn-primary mt-6">Back to dashboard</Link>
      </div>
    </div>
  );
}
