import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: '#07090d',
          900: '#090b10',
          850: '#0d1118',
          800: '#11151e',
          750: '#151b26',
          700: '#1b2230',
        },
        line: {
          DEFAULT: '#242b38',
          subtle: '#1a202c',
          strong: '#313b4e',
        },
        mint: {
          DEFAULT: '#77e0bd',
          dim: '#17382f',
          glow: '#18362f',
        },
        coral: {
          DEFAULT: '#ff7f86',
          dim: '#3a1d25',
        },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
