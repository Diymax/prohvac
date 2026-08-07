/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors:{
        'main':'#2C3442',
        'secondary':'#485872',
        'primary':'#FCE8BD',
        'primary-light':'#E2D2AA'
      },
      boxShadow:{
        "card":"rgba(0, 0, 0, 0.35) 0px 5px 15px"
      }
    },
  },
  plugins: [],
};