/** @type {import('tailwindcss').Config} */
module.exports = {
  // 1. Enable class-based dark mode
  darkMode: ["class"],
  
  // 2. Make sure the content path includes the configure directory
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    './configure/src/**/*.{js,ts,jsx,tsx}', // Your path is correct here
  ],
  // Ensure dynamically generated classes are not purged
  safelist: [
    // text colors used dynamically by getMetricColor
    'text-green-600',
    'text-yellow-600',
    'text-orange-600',
    'text-red-600',
    // background tiles used in provider/secondary sections
    'bg-green-50',
    'bg-blue-50',
    'bg-yellow-50',
    'bg-orange-50',
    'bg-red-50',
    // dark mode counterparts
    'dark:text-green-300',
    'dark:text-blue-300',
    'dark:text-yellow-300',
    'dark:text-orange-300',
    'dark:text-red-300',
    'dark:bg-green-950',
    'dark:bg-blue-950',
    'dark:bg-yellow-950',
    'dark:bg-orange-950',
    'dark:bg-red-950'
  ],
  prefix: "", // You can add a prefix if needed, but empty is standard
  
  // 3. Define the theme with all the necessary CSS variables from shadcn/ui
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  
  // 4. Add the tailwindcss-animate plugin
  plugins: [require("tailwindcss-animate")],
}
