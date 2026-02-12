import type { Config } from 'tailwindcss'

export default {
    darkMode: ["class"],
    content: [
    './configure/src/**/*.{js,ts,jsx,tsx}',
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    // --- ADD TREMOR PATH ---
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}', 
   ],
  theme: {
    transparent: "transparent",
    current: "currentColor",
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)',
            'tremor-small': '0.375rem',
            'tremor-default': '0.5rem',
            'tremor-full': '9999rem',
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
            // ... keep your existing colors ...
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
            
            // --- ADD TREMOR SPECIFIC COLORS ---
            // These map to your existing HSL variables for automatic Dark Mode support
            tremor: {
				brand: { faint: "hsl(var(--primary) / 0.1)", muted: "hsl(var(--primary) / 0.2)", subtle: "hsl(var(--primary) / 0.5)", default: "hsl(var(--primary))", emphasis: "hsl(var(--primary))", inverted: "hsl(var(--background))" },
				background: { muted: "hsl(var(--muted))", subtle: "hsl(var(--muted))", default: "hsl(var(--background))", emphasis: "hsl(var(--foreground))" },
				border: { default: "hsl(var(--border))" },
				ring: { default: "hsl(var(--ring))" },
				content: { subtle: "hsl(var(--muted-foreground))", default: "hsl(var(--muted-foreground))", emphasis: "hsl(var(--foreground))", strong: "hsl(var(--foreground))", inverted: "hsl(var(--background))" },
			  },
			  "dark-tremor": {
				brand: { faint: "#0B1229", muted: "hsl(var(--primary) / 0.2)", subtle: "hsl(var(--primary) / 0.5)", default: "hsl(var(--primary))", emphasis: "hsl(var(--primary))", inverted: "hsl(var(--background))" },
				background: { muted: "hsl(var(--muted))", subtle: "hsl(var(--muted))", default: "hsl(var(--background))", emphasis: "hsl(var(--foreground))" },
				border: { default: "hsl(var(--border))" },
				ring: { default: "hsl(var(--ring))" },
				content: { 
				  subtle: "#9ca3af", // This forces the X-axis labels to be light gray
				  default: "#d1d5db", 
				  emphasis: "#f3f4f6", 
				  strong: "#ffffff", 
				  inverted: "#000000" 
				},
			  },
  		},
        boxShadow: {
            // Tremor UI shadows
            'tremor-input': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
            'tremor-card': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
            'tremor-dropdown': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        },
        fontSize: {
            'tremor-label': ['0.75rem', { lineHeight: '1rem' }],
            'tremor-default': ['0.875rem', { lineHeight: '1.25rem' }],
            'tremor-title': ['1.125rem', { lineHeight: '1.75rem' }],
            'tremor-metric': ['1.875rem', { lineHeight: '2.25rem' }],
        },
  		keyframes: {
  			'accordion-down': {
  				from: { height: '0' },
  				to: { height: 'var(--radix-accordion-content-height)' }
  			},
  			'accordion-up': {
  				from: { height: 'var(--radix-accordion-content-height)' },
  				to: { height: '0' }
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
  // tailwind.config.ts
  safelist: [
		{
		pattern: /^(bg|text|border|stroke|fill)-(blue|emerald|rose|cyan|orange|pink|amber|purple|indigo|lime|slate)-(50|100|200|300|400|500|600|700|800|900|950)$/,
		variants: ['hover', 'ui-selected'],
		},
  ],
} satisfies Config