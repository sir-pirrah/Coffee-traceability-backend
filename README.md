# Coffee Traceability System — Backend

Express + TypeScript + PostgreSQL (Prisma) + Blockchain abstraction layer,
built from the architecture in `Coffee_Traceability_Backend_Database_Guide.md`.

## 1. What's implemented

| Module | Status |
|---|---|
| Auth (register/login/refresh/logout) |  Full — bcrypt, JWT access+refresh, login lockout, token rotation |
| Users |  Full — profile, admin listing, status management |
| Cooperatives |  Full CRUD |
| Farmers |  Full CRUD, soft delete, auto-generated farmer codes |
| Deliveries |  Full — creation, listing, batch assignment |
| Coffee Batches |  Full — status state machine, QR token generation, blockchain hooks, **public QR verification endpoint** |
| Processing |  Functional — record creation, blockchain event |
| Warehouses |  Functional — storage, inventory tracking |
| Buyers |  Functional — registration, verification |
| Ownership Transfers |  Functional — initiate/confirm flow |
| Blockchain layer |  Abstraction implemented with a mock ledger (swap in Fabric/Ethereum later — see `src/blockchain/blockchain.service.ts`) |
| Notifications |  Basic — list, mark read (no email/SMS sender wired yet) |
| Reports |  Basic — cooperative summary, batch blockchain history |
| Audit Logs |  Automatic on every state-changing action |

Every module follows the same layered pattern from the guide:
**routes → controller → service → Prisma (repository layer)**, with Zod
validators and role-based `authorize()` guards.

## 2. Setup

```bash
npm install
cp .env.example .env        # then fill in real secrets — see below
npx prisma generate
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
```

Server starts on `http://localhost:4000`. Health check: `GET /health`.
Swagger stub: `http://localhost:4000/api-docs` (expand `swagger.yaml` as you add endpoints).

### Required `.env` values before first run

- `DATABASE_URL` / `DIRECT_URL` — your PostgreSQL connection string (Railway gives you both a pooled and direct URL — use the direct one for `DIRECT_URL`, needed for migrations)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — generate with `openssl rand -hex 32`, must be **different** values
- `CORS_ORIGIN` — your Angular dev server URL (`http://localhost:4200`) or deployed frontend URL

### Seeded default login

`admin@coffeetrace.example` / `ChangeMe!2026` — **rotate this immediately** after first login in any shared environment.

## 3. Database design decisions (why it's built this way)

- **UUID primary keys** everywhere — safer than sequential IDs for a
  system where batch/QR codes are externally exposed (no ID enumeration).
- **Soft deletes** (`isDeleted`) on Farmer and CoffeeBatch — traceability
  history must never disappear, even if a farmer leaves the cooperative.
- **Decimal, not Float**, for all weights/prices — avoids floating-point
  rounding errors in financial and weight calculations.
- **Enums at the DB level** (`BatchStatus`, `UserRole`, etc.) — invalid
  states are rejected by Postgres itself, not just application code.
- **Indexes** on every foreign key and every field used in `WHERE`/`ORDER BY`
  in the services (`status`, `email`, `qrCodeToken`, `createdAt`, etc.).
- **`citext` on `User.email`** — case-insensitive uniqueness (`Farmer@x.com`
  and `farmer@x.com` are the same account) without manual `.toLowerCase()`
  scattered through the codebase.
- **Batch status is a state machine**, enforced in `coffeeBatch.service.ts`
  (`ALLOWED_TRANSITIONS`) — the DB enum stops garbage values, but only the
  service layer stops garbage *transitions* (e.g. `SOLD → REGISTERED`).
- **Blockchain events are hash-chained** off the actual row data
  (`payloadHash = sha256(payload)`), stored alongside the mock/real tx hash
  in `blockchain_transactions` — this is what QR verification reads from,
  so switching the real ledger in later doesn't change any read path.

## 4. Security measures already in place

- Passwords: bcrypt, cost factor 12, strong password policy (Zod regex)
- JWT: short-lived access token (15 min) + rotating refresh token, refresh
  token stored **hashed** (sha256) — a DB leak doesn't hand out usable tokens
- Login lockout after 5 failed attempts (15 min cooldown)
- Helmet security headers, CORS allow-list, `express-rate-limit` (stricter
  limiter on `/auth/*`)
- Zod validation on every request body/query/params
- Centralized error handler that never leaks stack traces or internals in production
- Full audit log (`audit_logs` table) on every create/update/delete/login
- `trust proxy` set correctly for Railway/Vercel so rate limiting sees real client IPs

## 5. Recommended additional features (beyond the original guide)

Grouped by effort so you can slot them into your sprint plan:

**Low effort, high value**
- **Refresh-token-per-device tracking** (a `sessions` table instead of one
  hash on `User`) — lets a user log out of "all other devices"
- **CSV/PDF export** on the reports endpoints (you already have the data —
  add `json2csv` or reuse the `pdf` toolchain)
- **Idempotency keys** on `POST /deliveries` and `POST /batches` — prevents
  duplicate submissions from a flaky rural connection double-tapping "Save"
- **Soft-delete on Delivery and Cooperative too**, for consistency with Farmer/Batch

**Medium effort**
- **SMS notifications via Africa's Talking or Twilio** for farmers when
  their delivery is recorded or a batch sells — high perceived value for
  low-literacy users who won't check a dashboard
- **Offline-first delivery capture**: queue deliveries client-side (Angular
  IndexedDB) and sync via a `POST /deliveries/bulk-sync` endpoint — directly
  answers the "what if the internet is down" question from your presentation Q&A
- **Batch splitting/merging**: right now one batch is one QR code; real
  cooperatives often split a batch across two warehouses or merge small
  deliveries — worth a `parentBatchId` self-relation if you have time
- **Weather/harvest season metadata** on batches (already have `harvestSeason`
  field) tied to a simple external weather API — nice-to-have for buyer trust

**Larger, "if time allows"**
- **Multi-cooperative buyer marketplace view** — buyers browse available
  batches across cooperatives before initiating a transfer
- **Real Hyperledger Fabric integration** — replace the mock in
  `blockchain.service.ts`; the interface is already designed so this is a
  contained swap, not a rewrite
- **Quality grading workflow** with photo upload (Multer is already in the
  stack) attached to `ProcessingRecord`

## 6. Next steps in your workflow

1. `npm install` and get `npm run dev` running locally against a local or
   Railway Postgres instance.
2. `npx prisma studio` to visually confirm the schema and seed data.
3. Wire up the Angular frontend against `/api/v1/auth/login` first — get a
   working login screen before building out every module's UI.
4. Add tests per module following `src/tests/health.test.ts` as the pattern
   (Vitest + Supertest) — this satisfies your "Unit Testing: Jest" line from
   the proposal; Vitest is a drop-in modern alternative with the same API.
5. When ready for real blockchain integration, implement `submitToLedger()`
   in `src/blockchain/blockchain.service.ts` — nothing else needs to change.
