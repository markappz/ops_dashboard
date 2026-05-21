import type { Config } from "tailwindcss";

export default {
  content: ["./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // FitScript brand — navy + sky-blue system (matches marketing site)
        brand: {
          navy: {
            950: "#050D1A",
            900: "#0A1628",
            800: "#0E1B2E",
            700: "#16263E",
            600: "#1F3554",
          },
          blue: {
            600: "#1E4FE0",
            500: "#2E5BFF",
            400: "#5C7FFF",
            300: "#9FB6FF",
            200: "#C8D4F5",
            100: "#D4E3F4",
            50: "#E8F0FA",
          },
          sky: {
            100: "#E8F0FA",
            50: "#F2F6FC",
          },
        },
        // Legacy `fitscript.*` token kept and REMAPPED to brand-blue so existing
        // code rebrands automatically. New code should use `brand.*` directly.
        fitscript: {
          green: "#2E5BFF",
          "green-dark": "#1E4FE0",
          "green-light": "#E8F0FA",
        },
        // Semantic tokens (theme-aware via CSS vars)
        ops: {
          bg: "rgb(var(--ops-bg) / <alpha-value>)",
          surface: "rgb(var(--ops-surface) / <alpha-value>)",
          "surface-hover": "rgb(var(--ops-surface-hover) / <alpha-value>)",
          "surface-raised": "rgb(var(--ops-surface-raised) / <alpha-value>)",
          border: "rgb(var(--ops-border) / <alpha-value>)",
          "border-strong": "rgb(var(--ops-border-strong) / <alpha-value>)",
          text: "rgb(var(--ops-text) / <alpha-value>)",
          "text-muted": "rgb(var(--ops-text-muted) / <alpha-value>)",
          "text-subtle": "rgb(var(--ops-text-subtle) / <alpha-value>)",
          accent: "rgb(var(--ops-accent) / <alpha-value>)",
          "accent-hover": "rgb(var(--ops-accent-hover) / <alpha-value>)",
          "accent-soft": "rgb(var(--ops-accent-soft) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "-apple-system", "sans-serif"],
        display: ['"DM Sans"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "var(--ops-card-shadow)",
        "card-lg": "var(--ops-card-shadow-lg)",
        glow: "0 0 0 4px rgb(var(--ops-accent) / 0.12)",
      },
      backgroundImage: {
        "brand-hero":
          "linear-gradient(135deg, #E8F0FA 0%, #D4E3F4 45%, #FFFFFF 100%)",
        "brand-hero-dark":
          "linear-gradient(135deg, #0A1628 0%, #16263E 50%, #1F3554 100%)",
        "brand-cloud":
          "radial-gradient(1200px 500px at 0% 0%, rgba(46,91,255,0.10), transparent), radial-gradient(800px 400px at 100% 0%, rgba(159,182,255,0.18), transparent)",
        "brand-cloud-dark":
          "radial-gradient(1200px 500px at 0% 0%, rgba(46,91,255,0.18), transparent), radial-gradient(800px 400px at 100% 0%, rgba(31,53,84,0.45), transparent)",
      },
    },
  },
  plugins: [],
} satisfies Config;
