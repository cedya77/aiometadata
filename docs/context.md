# AIOMetadata — AI Context Reference

This file gives a new Claude session everything it needs to understand this codebase without re-exploring it. Keep it up to date when architecture changes.

---

## Project Overview

**AIOMetadata** is an all-in-one metadata addon for [Stremio](https://www.stremio.com/). It fetches rich metadata (posters, descriptions, ratings, cast, etc.) from multiple providers (TMDB, TVDB, MAL, MDBList, etc.) and serves it via the Stremio addon protocol.

- **Fork**: this repo is a fork of the upstream AIOMetadata, maintained at `github.com/aghermida/aiometadata`
- **Multi-user**: each user registers with a UUID + password; the server owner controls the instance via `ADMIN_KEY`
- **Self-hosted**: designed to be deployed as a single Docker/Node process

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express 5, TypeScript (ts-node), Node 24+ |
| Database | SQLite (better-sqlite3), optional PostgreSQL (pg) |
| Cache | Redis (ioredis) |
| Frontend | React 19, Vite 8, Tailwind CSS 4 |
| UI Components | Radix UI primitives, shadcn/ui, Lucide icons |
| Data fetching | TanStack React Query 5 |
| Animation | Framer Motion 12 |
| Toasts | Sonner |
| Build output | `vite build` → `dist/client/` (git-ignored) |

---

## Directory Layout

```
addon/
  index.js          Main Express monolith (~6000+ lines) — all routes, middleware, API logic
  server.ts         Entry point — starts DB, Redis, mappers, then calls index.js
  lib/              Mappers, caching helpers, API clients
  types/            TypeScript type definitions
  utils/            Shared utility functions

configure/src/
  App.tsx           React entry — reads window flags, branches to the correct page component
  main.tsx          ReactDOM.render — wraps with QueryClientProvider → ThemeProvider → ConfigProvider → AdminProvider
  components/
    layout/
      Header.tsx    Top nav: logo, addon name editor, Dashboard button, user login/logout
    dashboard/
      Dashboard.tsx           Admin dashboard with tab navigation + its own AdminLoginModal
      DashboardOverview.tsx   System stats
      DashboardAnalytics.tsx  Request/perf analytics
      DashboardContent.tsx    Catalog management
      DashboardLogs.tsx       Server log viewer
      DashboardSystem.tsx     System info
      DashboardOperations.tsx Maintenance ops
      DashboardUsers.tsx      User management (admin only)
      DashboardSettings.tsx   Server settings
      DashboardPerformance.tsx Performance metrics
    LandingPage.tsx   Landing page (shown at /)
    AdminAuthGate.tsx Blocking auth modal for /configure and /dashboard
    LoadingScreen.tsx Skeleton loading screen
    SettingsLayout.tsx  Main configure layout (desktop tabs / mobile accordion)
    ui/               shadcn/ui primitive components (Button, Input, Dialog, Card, etc.)
  contexts/
    AdminContext.tsx  Admin auth state (ADMIN_KEY, guest mode, session)
    ConfigContext.tsx User config state (catalogs, API keys, auth)
  hooks/
    useDashboardQueries.ts  TanStack Query hooks for all dashboard API endpoints
    use-breakpoint.ts       Responsive breakpoint helper

public/             Static assets served at root: logo.png, favicon.png, streaming service images
dist/client/        Built frontend (git-ignored; produced by `npm run build`)
```

---

## Page Routing & Mode Flags

Express serves a **single React SPA** from `dist/client/index.html`. Different "pages" are implemented by injecting a `window.*` flag server-side before sending the HTML, then branching in `App.tsx`.

| Route | Server action | Flag injected | `App.tsx` branch |
|-------|--------------|---------------|-----------------|
| `GET /` | Read + modify HTML | `window.LANDING_MODE = true` | `<LandingPage />` |
| `GET /configure` | `express.static` | _(none)_ | full configure UI |
| `GET /dashboard` | Read + modify HTML | `window.DASHBOARD_MODE = true` | `<SettingsLayout />` → `<Dashboard />` |
| `GET /stremio/:uuid/configure` | `res.sendFile` | _(none)_ | configure UI (UUID pre-filled from URL) |
| `GET /stremio/:uuid/rating` | Read + modify HTML | `window.RATING_MODE = true` | rating UI |

**Pattern for adding a new page mode:**
1. Add an Express route in `addon/index.js` that reads `clientIndexPath`, injects `window.NEW_MODE = true` before `</head>`, and sends the result
2. Add `const isNewMode = !!(window as any).NEW_MODE;` near the top of `AppContent` in `App.tsx`
3. Early-return the new component when the flag is set
4. Create the component under `configure/src/components/`

---

## Authentication Layers

Two independent auth systems coexist and must not be confused:

### Admin auth — server-owner level

- **Env var**: `ADMIN_KEY`
- **State**: `AdminContext.tsx` exposes `{ isAdmin, isGuest, adminKey, adminKeyConfigured, guestModeEnabled, login, loginAsGuest, logout, isLoading }`
- **Session**: stored in `sessionStorage` under keys `admin-key`, `admin-session`, `guest-session`; persists until browser tab closes
- **Check endpoint**: `GET /api/dashboard/auth/check` — send `x-admin-key: <key>` header; returns `{ authenticated: true }` on success, `401` otherwise
- **Config endpoint**: `GET /api/dashboard/config` — public; returns `{ guestModeEnabled, adminKeyConfigured }`
- **Gate**: `AdminAuthGate.tsx` is rendered by `App.tsx` before any `/configure` or `/dashboard` content when `adminKeyConfigured && !isAdmin && !isGuest`
- **Stremio routes bypass this gate** — `App.tsx` checks `window.location.pathname.startsWith('/stremio/')` and skips auth for those paths
- **Guest mode**: controlled by `DISABLE_GUEST_MODE` env var; when not set (default), users can access dashboard without a key (read-only public metrics)

### User auth — per-user level

- Each user has a UUID + optional password stored in SQLite
- **Login**: `POST /api/config/load/:userUUID` with body `{ password, addonPassword? }` → returns the user's config JSON
- **State**: `ConfigContext.tsx` → `auth: { authenticated, userUUID, password }`
- **UI**: `Header.tsx` — contains the login dialog (UUID + password fields)
- Stremio-specific URLs (`/stremio/:uuid/configure`) pre-fill the UUID input in `Header.tsx` and auto-open the login dialog

---

## Key Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ADMIN_KEY` | Enables admin auth gate on `/configure` and `/dashboard` | _(unset = no gate)_ |
| `DISABLE_GUEST_MODE` | Set `true` to require admin key (no guest access to dashboard) | _(unset = guest allowed)_ |
| `ADDON_PASSWORD` | Global password required for all user configs | _(unset = no global pw)_ |
| `HOST_NAME` | Public hostname used in manifest and redirect URLs | required |
| `PORT` | HTTP server port | `3232` |
| `REDIS_URL` | Redis connection string | required |
| `DATABASE_URL` | PostgreSQL URL (if using pg instead of SQLite) | optional |

---

## Selected API Endpoints

### Public (no auth required)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/manifest.json` | Basic Stremio manifest |
| GET | `/stremio/:uuid/manifest.json` | User-specific Stremio manifest |
| GET | `/api/dashboard/config` | `{ guestModeEnabled, adminKeyConfigured }` |
| GET | `/api/config/addon-info` | `{ requiresAddonPassword }` |
| GET | `/api/config/is-trusted/:uuid` | `{ trusted, requiresAddonPassword }` |

### Admin key required (`x-admin-key` header)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard/auth/check` | Validate admin key |
| GET | `/api/dashboard/overview` | System overview stats |
| GET | `/api/dashboard/stats` | Quick performance stats |
| GET | `/api/dashboard/system` | System config + resource usage |
| GET | `/api/dashboard/operations` | Operations data |
| GET | `/api/dashboard/logs` | Server logs |
| GET | `/api/dashboard/analytics` | Analytics data |
| GET | `/api/dashboard/users` | List all users |
| DELETE | `/api/admin/users/:uuid` | Delete user |

### User password required
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/config/load/:uuid` | Load user config |
| POST | `/api/config/save/:uuid` | Save user config |

---

## Styling Conventions

- **Dark-first**: all top-level page wrappers use `className="dark min-h-screen w-full bg-background text-foreground"`
- **Color system**: HSL CSS variables defined in `configure/src/index.css` (`--background`, `--foreground`, `--primary`, `--card`, `--muted`, `--border`, `--ring`, etc.)
- **Cards**: `rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm`
- **Dialogs**: `rounded-2xl border border-white/[0.08] bg-card/95 backdrop-blur-xl`
- **Buttons**: shadcn `Button` — variants `default` (white bg), `outline` (transparent + border), `ghost` (no border)
- **Inputs**: `bg-muted/50 border border-white/[0.06] rounded-lg h-10`
- **Responsive**: mobile-first with `sm:` / `md:` / `lg:` breakpoints; `Header.tsx` and `SettingsLayout.tsx` have both mobile accordion and desktop tab layouts

---

## Backend Middleware Notes

- `requireDashboardAdmin(req, res, next)` — checks `x-admin-key` header against `process.env.ADMIN_KEY`; returns `401` if missing or wrong
- `requireAuthUnlessGuestMode(req, res, next)` — skips auth when `DISABLE_GUEST_MODE` is not set; otherwise delegates to `requireDashboardAdmin`
- `noCache` middleware is applied to `/dashboard` and `/api/dashboard` routes
- Static files are served in order: `favicon`, `/configure` → `dist/client/`, root `public/`, fallback `dist/client/` (SPA fallback)
