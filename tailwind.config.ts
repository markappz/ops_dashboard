import type { Config } from "tailwindcss";

export default {
  content: ["./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        fitscript: {
          green: "#0EA57A",
          "green-dark": "#0C8C68",
          "green-light": "#E6F7F1",
        },
        ops: {
          bg: "rgb(var(--ops-bg) / <alpha-value>)",
          surface: "rgb(var(--ops-surface) / <alpha-value>)",
          "surface-hover": "rgb(var(--ops-surface-hover) / <alpha-value>)",
          border: "rgb(var(--ops-border) / <alpha-value>)",
          "border-strong": "rgb(var(--ops-border-strong) / <alpha-value>)",
          text: "rgb(var(--ops-text) / <alpha-value>)",
          "text-muted": "rgb(var(--ops-text-muted) / <alpha-value>)",
          accent: "rgb(var(--ops-accent) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        card: "var(--ops-card-shadow)",
      },
    },
  },
  plugins: [],
} satisfies Config;
