# Family Pick’em

A private, self-hosted NFL pick’em pool for the 2026 season. It runs on Cloudflare Workers + D1 and uses ESPN’s public scoreboard feed for automated schedules and results.

## Features

- Username/password accounts with no email or personal information required
- Private pools with invite codes and automatic kickoff locks
- Cached ESPN schedules, live scores, and final results
- Live weekly leaderboard, weekly-winner history, and season standings
- Admin password resets, pick corrections, and game lock overrides with audit logs
- ESPN logos by default, with a user-controlled custom badge fallback
- Personal AFC East-inspired color themes

## Setup

1. Run `npm install`.
2. Run `npx wrangler d1 create football-pool` and put its database ID in `wrangler.jsonc`.
3. Run `npm run db:local` for local development or `npm run db:remote` for production.
4. Copy `.dev.vars.example` to `.dev.vars` and add a long random `AUTH_PEPPER`.
5. Run `npm run build`, then `npm run dev:worker`. Wrangler serves both the site and API.

The first account registered becomes the administrator. Deploy with `npm run deploy` after running `npx wrangler secret put AUTH_PEPPER`.

Team names, logos, and related marks belong to their respective owners. This independent, noncommercial family pool is not affiliated with or endorsed by the NFL, its teams, ESPN, or Disney.
