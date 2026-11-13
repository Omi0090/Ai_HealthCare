import axios from 'axios';

/**
 * Single axios instance for the whole app.
 * In dev, Vite proxies /api -> http://localhost:5000 so the browser only needs
 * a relative URL (this also makes the sandboxed live preview work).
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 45000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('medguard.token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error.response?.status;
    // A 401 on the sign-in endpoints means "wrong credentials", not "session
    // expired" — redirecting there would reload the page and wipe what the user
    // just typed, destroying the error message we are about to show them.
    const url = error.config?.url || '';
    const isAuthAttempt = url.includes('/auth/login') || url.includes('/auth/register');
    if (status === 401 && !isAuthAttempt && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem('medguard.token');
      localStorage.removeItem('medguard.user');
      window.location.href = '/login';
    }
    const message = error.response?.data?.error || error.message || 'Request failed';
    return Promise.reject(Object.assign(error, { friendlyMessage: message }));
  }
);

export default api;
