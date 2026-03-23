/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        warm: {
          bg: '#FFF9F0',
          card: '#FFFFFF',
          brown: '#8B6F47',
          brownDark: '#6B5535',
          brownLight: '#C4A882',
          gold: '#C08A3E',
          cream: '#FFF4E6',
          border: '#E8E0D4',
          borderLight: '#F0EBE3',
        },
        accent: {
          green: '#4CAF50',
          greenLight: '#E8F5E9',
          red: '#E8443A',
          redLight: '#FDECEA',
        },
        textMain: '#2A2A2A',
        textSub: '#666666',
        textLight: '#999999',
      },
      fontFamily: {
        cute: ['Nunito', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
