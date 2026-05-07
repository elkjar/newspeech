import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#050505',
        bone: '#e8e8e8',
      },
      fontFamily: {
        sans: ['zxx-sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        bold: ['zxx-bold-regular', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      gridTemplateColumns: {
        16: 'repeat(16, minmax(0, 1fr))',
      },
    },
  },
  plugins: [],
} satisfies Config;
