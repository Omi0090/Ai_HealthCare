import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Claims from './pages/Claims';
import ClaimDetail from './pages/ClaimDetail';
import ScoreClaim from './pages/ScoreClaim';
import Cases from './pages/Cases';
import Analytics from './pages/Analytics';
import Providers from './pages/Providers';
import Network from './pages/Network';
import ModelInsights from './pages/ModelInsights';
import Admin from './pages/Admin';
import About from './pages/About';
import NotFound from './pages/NotFound';

function Protected({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          <p className="text-xs text-slate-500">Restoring session…</p>
        </div>
      </div>
    );
  }
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const { isAuthenticated } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/" element={<Protected><AppLayout /></Protected>}>
        <Route index element={<Dashboard />} />
        <Route path="claims" element={<Claims />} />
        <Route path="claims/:id" element={<ClaimDetail />} />
        <Route path="score" element={<ScoreClaim />} />
        <Route path="cases" element={<Cases />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="providers" element={<Providers />} />
        <Route path="providers/:id" element={<Providers />} />
        <Route path="network" element={<Network />} />
        <Route path="model" element={<ModelInsights />} />
        <Route path="admin" element={<Admin />} />
        <Route path="about" element={<About />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
