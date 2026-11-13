/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#070b14', 900: '#0b1120', 850: '#0f172a', 800: '#131c31',
          700: '#1b2740', 600: '#26354f', 500: '#3a4a68',
        },
        brand: {
          50: '#eefbf4', 100: '#d5f5e3', 300: '#7ee2ab', 400: '#43d18a',
          500: '#1eb774', 600: '#12925c', 700: '#0f744b',
        },
        danger: { 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48' },
        warn: { 400: '#fbbf24', 500: '#f59e0b' },
        info: { 400: '#60a5fa', 500: '#3b82f6' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5)',
        glow: '0 0 0 1px rgba(30,183,116,.25), 0 8px 30px -10px rgba(30,183,116,.35)',
      },
      animation: {
        'fade-in': 'fadeIn .35s ease-out both',
        'slide-up': 'slideUp .4s ease-out both',
        pulseSlow: 'pulse 3s cubic-bezier(.4,0,.6,1) infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { opacity: 0, transform: 'translateY(10px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
};
