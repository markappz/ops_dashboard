# FitScript Ops Dashboard

## What this is
Internal admin dashboard for FitScript. Reads from the same RDS as the main app, plus its own first-party tracking pixel (`/api/t/*`) and OAuth-stored Google data (GA4, GSC). Lives at **ops.fitscript.me**.

## Stack
- **Frontend:** React 18, Vite, Tailwind, Recharts, wouter, @tanstack/react-query
- **Backend:** Express + TS
- **DB:** raw SQL via `pg` pool — **no Drizzle** in this repo (it crashes on this env, see DECISIONS.md)
- **Auth:** Google OAuth login + HMAC-signed session cookie (server/admin-auth.ts), `ADMIN_EMAILS` allowlist
- **Integrations:** Stripe (read-only + actions), Google OAuth → GA4 + GSC
- **Infra:** ECS Fargate, ECR, ALB host-routing on `ops.fitscript.me`, Cloudflare DNS, wildcard cert

## Commands
- `npm run dev` — dev server on port 5001
- `npm run build` — vite build + esbuild server bundle
- `npm run start` — run production build

## Required env (.env, symlinked from main checkout when running)
- `DATABASE_URL` — same RDS as fitscript
- `STRIPE_SECRET_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `OPS_GOOGLE_REDIRECT_URI` — for GA4/GSC connector callback
- `OPS_ADMIN_REDIRECT_URI` — for admin-login callback (e.g. `https://ops.fitscript.me/api/ops/auth/callback`)
- `OPS_SESSION_SECRET` — random 32+ byte secret for cookie signing
- `ADMIN_EMAILS` — comma-separated allowlist (e.g. `paulclotar@gmail.com,michael@...`)
- `OPS_PORT` — defaults to 5001
- `NODE_ENV=production` in deploys

## Structure
- `server/index.ts` — bootstraps express, mounts auth gate, registers routes
- `server/admin-auth.ts` — Google OAuth login + session cookie + `requireAdmin` / `opsGate` middleware
- `server/google-auth.ts` — separate OAuth for GA4/GSC data connectors (stores tokens in `ops_google_connection`)
- `server/routes.ts` — protected `/api/ops/*` (snapshot, members, orders, marketing, etc.)
- `server/tracking.ts` — public `/api/t/*` ingest from FitScript site (pixel)
- `client/src/App.tsx` — auth gate (renders Login when unauthenticated)
- `client/src/pages/login.tsx` — Google sign-in button

## Auth model
- Public: `/api/health`, `/api/t/*`, `/api/ops/auth/*`
- Gated: every other `/api/ops/*` — middleware in `admin-auth.ts` (`opsGate`)
- Cookie: `ops_session` httpOnly, signed JSON `{email, exp}` with HMAC-SHA256
- Logout: `POST /api/ops/auth/logout` clears cookie

## Notes
- This repo is **separate** from the main FitScript repo (`markappz/Humn-Health`). It's `markappz/ops_dashboard`.
- Use raw SQL (`pool.query`) for everything. Drizzle ORM crashes here.
- Tracking tables are auto-created at startup from `server/tracking-schema.sql`.
