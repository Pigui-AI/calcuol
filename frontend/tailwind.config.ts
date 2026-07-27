import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pigui: {
          50: "#f3f1ff",
          100: "#e9e5ff",
          200: "#d5cdff",
          300: "#b6a5ff",
          400: "#9273ff",
          500: "#713dff",
          600: "#6316f7",
          700: "#5409e3",
          800: "#4607bf",
          900: "#3b089c",
          950: "#22036a"
        }
      }
    }
  },
  plugins: []
};
export default config;
