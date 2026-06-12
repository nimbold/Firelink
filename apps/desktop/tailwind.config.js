/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sidebar: {
          bg: '#1C1C1E',
          glass: 'rgba(28, 28, 30, 0.7)',
        },
        main: {
          bg: '#000000',
        },
        accent: '#0A84FF',
        border: '#38383A',
        item: {
          hover: 'rgba(255, 255, 255, 0.1)',
          selected: 'rgba(10, 132, 255, 0.2)',
        }
      }
    },
  },
  plugins: [],
}
