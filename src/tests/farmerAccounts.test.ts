import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader } from "./helpers/auth";
import { describeIfDb, prisma, asSystem } from "./helpers/db";
import { runAsSystem } from "@/repositories/dbContext";
import { invalidate as invalidatePermissionCache } from "@/modules/permissions/permission.service";

const API = env.API_PREFIX;

/**
 * Farmer login accounts, end to end.
 *
 * A farmer's credential is issued by someone else, written on a slip of paper,
 * and handed over in person. Three things follow from that, and this suite is
 * organised around them:
 *
 *   - The password is shown exactly once. There is no channel to resend it on,
 *     so nothing may ever read it back — not a re-fetch, not the audit log.
 *   - Whoever issues it must not be able to issue more than a farmer login.
 *     Postgres will not stop them: `users_tenant` constrains the new row's
 *     `cooperative_id` and says nothing at all about its `role`, so the ceiling
 *     is application code and has to be asserted here.
 *   - Anyone who saw the slip can present it, so the account is not fully the
 *     farmer's until they replace the password. That block lives in middleware,
 *     not in a route guard, and the test that matters calls the API directly.
 *
 * The last case is the one the whole feature exists for: provision a farmer,
 * sign in as them with the code off their slip, change the password, and read
 * back only their own rows. It is the first account in the suite whose
 * `farmerId` is resolved from a real provisioning path rather than a fixture,
 * which is what makes it a check on the RLS scoping and not just on the HTTP.
 */
describeIfDb("farmer login accounts", () => {
  let app: Express;

  // Two cooperatives, because half of what is under test is a boundary.
  let coopA: string;
  let coopB: string;

  let adminAId: string;
  let staffAId: string;
  let adminBId: string;

  const stamp = Date.now();
  const strongPassword = "Nyeri-Coffee-2026!";

  const adminA = () => ({ id: adminAId, role: "COOPERATIVE_ADMIN" as const, cooperativeId: coopA });
  const staffA = () => ({ id: staffAId, role: "COOPERATIVE_STAFF" as const, cooperativeId: coopA });
  const adminB = () => ({ id: adminBId, role: "COOPERATIVE_ADMIN" as const, cooperativeId: coopB });

  /** Registers a farmer through the API and returns the created row's id. */
  async function registerFarmer(
    body: Record<string, unknown>,
    actor = adminA()
  ): Promise<request.Response> {
    return request(app)
      .post(`${API}/farmers`)
      .set(...authHeader(actor))
      .send({ cooperativeId: actor.cooperativeId, firstName: "Test", lastName: "Farmer", ...body });
  }

  beforeAll(
    asSystem(async () => {
      app = createApp();

      const a = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-ACCT-A" },
        update: {},
        create: { name: "Test Coop Accounts A", registrationNo: "TEST-COOP-ACCT-A", county: "Nyeri" },
      });
      coopA = a.id;

      const b = await prisma.cooperative.upsert({
        where: { registrationNo: "TEST-COOP-ACCT-B" },
        update: {},
        create: { name: "Test Coop Accounts B", registrationNo: "TEST-COOP-ACCT-B", county: "Kirinyaga" },
      });
      coopB = b.id;

      const admins = await Promise.all(
        [
          { email: "acct-admin-a@test.local", role: "COOPERATIVE_ADMIN" as const, cooperativeId: coopA },
          { email: "acct-staff-a@test.local", role: "COOPERATIVE_STAFF" as const, cooperativeId: coopA },
          { email: "acct-admin-b@test.local", role: "COOPERATIVE_ADMIN" as const, cooperativeId: coopB },
        ].map((u) =>
          prisma.user.upsert({
            where: { email: u.email },
            update: { cooperativeId: u.cooperativeId, role: u.role, status: "ACTIVE" },
            create: {
              email: u.email,
              passwordHash: "not-used-tokens-are-signed-directly",
              firstName: "Acct",
              lastName: "Actor",
              role: u.role,
              status: "ACTIVE",
              cooperativeId: u.cooperativeId,
            },
          })
        )
      );
      [adminAId, staffAId, adminBId] = admins.map((u) => u.id);

      // The matrix is read from the database, so the suite states the grants it
      // depends on rather than assuming a seeded environment.
      const grants: Array<[string, string]> = [
        ["COOPERATIVE_ADMIN", "farmers:view"],
        ["COOPERATIVE_ADMIN", "farmers:create"],
        ["COOPERATIVE_ADMIN", "farmers:manage-account"],
        ["COOPERATIVE_ADMIN", "users:manage"],
        ["COOPERATIVE_ADMIN", "deliveries:view"],
        ["COOPERATIVE_ADMIN", "batches:view"],
        ["COOPERATIVE_STAFF", "farmers:view"],
        ["COOPERATIVE_STAFF", "farmers:create"],
        ["FARMER", "deliveries:view"],
        ["FARMER", "batches:view"],
      ];
      for (const [role, permission] of grants) {
        await prisma.rolePermission.upsert({
          where: { role_permission: { role: role as never, permission } },
          update: {},
          create: { role: role as never, permission },
        });
      }

      // The staff 403 below is only meaningful if the grant is genuinely absent —
      // a leftover row from another run would make the test pass for the wrong
      // reason, or fail for one.
      await prisma.rolePermission.deleteMany({
        where: { role: "COOPERATIVE_STAFF", permission: { in: ["farmers:manage-account", "users:manage"] } },
      });

      invalidatePermissionCache();
    })
  );

  afterAll(
    asSystem(async () => {
      const users = await prisma.user.findMany({
        where: { cooperativeId: { in: [coopA, coopB] } },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);

      // Outermost references first: deliveries point at farmers, farmers and
      // audit rows point at users. Batches are soft-deleted rather than removed,
      // because the hash chain that references them is append-only by design.
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.delivery.deleteMany({ where: { cooperativeId: { in: [coopA, coopB] } } });
      await prisma.coffeeBatch.updateMany({
        where: { cooperativeId: { in: [coopA, coopB] } },
        data: { isDeleted: true },
      });
      await prisma.farmer.deleteMany({ where: { cooperativeId: { in: [coopA, coopB] } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    })
  );

  // ---------------------------------------------------------------------------
  // Provisioning
  // ---------------------------------------------------------------------------

  it("creates a linked, active, must-change FARMER user and returns the password once", async () => {
    const res = await registerFarmer({ firstName: "Wanjiku", lastName: "Provision", createLogin: true });

    expect(res.status).toBe(201);
    const { credentials, id: farmerId, farmerCode } = res.body.data;
    expect(credentials.identifier).toBe(farmerCode);
    expect(credentials.temporaryPassword).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    expect(new Date(credentials.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const farmer = await runAsSystem(() =>
      prisma.farmer.findUnique({ where: { id: farmerId }, include: { user: true } })
    );
    expect(farmer?.userId).toBeTruthy();
    expect(farmer?.user?.role).toBe("FARMER");
    expect(farmer?.user?.status).toBe("ACTIVE");
    expect(farmer?.user?.mustChangePassword).toBe(true);
    expect(farmer?.user?.cooperativeId).toBe(coopA);
    // Only the hash is persisted — the plaintext exists in the response and nowhere else.
    expect(farmer?.user?.passwordHash).not.toContain(credentials.temporaryPassword);
  });

  it("issues a login to a farmer registered without one", async () => {
    const created = await registerFarmer({ firstName: "Later", lastName: "Login" });
    expect(created.status).toBe(201);
    expect(created.body.data.credentials).toBeUndefined();

    const res = await request(app)
      .post(`${API}/farmers/${created.body.data.id}/account`)
      .set(...authHeader(adminA()))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.data.identifier).toBe(created.body.data.farmerCode);
    expect(res.body.data.temporaryPassword).toBeTruthy();

    const farmer = await runAsSystem(() =>
      prisma.farmer.findUnique({ where: { id: created.body.data.id }, select: { userId: true } })
    );
    expect(farmer?.userId).toBeTruthy();
  });

  it("refuses a second account for a farmer who already has one", async () => {
    const created = await registerFarmer({ firstName: "Only", lastName: "Once", createLogin: true });

    const res = await request(app)
      .post(`${API}/farmers/${created.body.data.id}/account`)
      .set(...authHeader(adminA()))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already has a login/i);
  });

  it("never exposes the temporary password on a re-read", async () => {
    const created = await registerFarmer({ firstName: "No", lastName: "Replay", createLogin: true });
    const secret = created.body.data.credentials.temporaryPassword;

    const byId = await request(app)
      .get(`${API}/farmers/${created.body.data.id}`)
      .set(...authHeader(adminA()));
    expect(byId.status).toBe(200);
    expect(JSON.stringify(byId.body)).not.toContain(secret);

    const list = await request(app)
      .get(`${API}/farmers`)
      .query({ page: 1, limit: 100 })
      .set(...authHeader(adminA()));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(secret);

    // Nor in the audit trail, which is read by more people and kept far longer
    // than the slip it was printed on.
    const logs = await runAsSystem(() =>
      prisma.auditLog.findMany({ where: { userId: adminAId }, select: { metadata: true } })
    );
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("pins the new account to FARMER however the request is dressed up", async () => {
    // `users_tenant`'s WITH CHECK would permit this row: the cooperative matches.
    // Nothing but the service stands between a cooperative admin and a peer.
    const res = await registerFarmer({
      firstName: "Not",
      lastName: "Admin",
      createLogin: true,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    expect(res.status).toBe(201);
    const farmer = await runAsSystem(() =>
      prisma.farmer.findUnique({ where: { id: res.body.data.id }, include: { user: true } })
    );
    expect(farmer?.user?.role).toBe("FARMER");
  });

  it("does not let an admin provision a farmer in another cooperative", async () => {
    const created = await registerFarmer({ firstName: "Coop", lastName: "A Only" });

    const res = await request(app)
      .post(`${API}/farmers/${created.body.data.id}/account`)
      .set(...authHeader(adminB()))
      .send({});

    expect([403, 404]).toContain(res.status);

    const farmer = await runAsSystem(() =>
      prisma.farmer.findUnique({ where: { id: created.body.data.id }, select: { userId: true } })
    );
    expect(farmer?.userId).toBeNull();
  });

  it("refuses credential issuing to staff who may register farmers but not equip them", async () => {
    const created = await registerFarmer({ firstName: "Staff", lastName: "Blocked" });

    const viaRoute = await request(app)
      .post(`${API}/farmers/${created.body.data.id}/account`)
      .set(...authHeader(staffA()))
      .send({});
    expect(viaRoute.status).toBe(403);

    // And not through the back door either: `POST /farmers` is a route staff DO
    // hold, so `createLogin` is re-checked inside the handler.
    const viaCreate = await registerFarmer(
      { firstName: "Staff", lastName: "Backdoor", createLogin: true },
      staffA()
    );
    expect(viaCreate.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Identifier resolution
  // ---------------------------------------------------------------------------

  it("signs a farmer in by farmer code, phone number, and email alike", async () => {
    const phone = `07${String(stamp).slice(-8)}`;
    const email = `acct-login-${stamp}@test.local`;
    const created = await registerFarmer({
      firstName: "Three",
      lastName: "Ways",
      phoneNumber: phone,
      createLogin: true,
      email,
    });
    expect(created.status).toBe(201);
    const { farmerCode, credentials } = created.body.data;

    for (const identifier of [farmerCode, phone, email]) {
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ identifier, password: credentials.temporaryPassword });

      expect(res.status, `login by ${identifier}`).toBe(200);
      expect(res.body.data.accessToken).toBeTruthy();
      expect(res.body.data.mustChangePassword).toBe(true);
    }
  });

  it("resolves every Kenyan phone format to the same account", async () => {
    const local = `07${String(stamp + 1).slice(-8)}`;
    const subscriber = local.slice(1); // 7XXXXXXXX
    const created = await registerFarmer({
      firstName: "One",
      lastName: "Number",
      phoneNumber: local,
      createLogin: true,
    });
    const password = created.body.data.credentials.temporaryPassword;

    const formats = [local, `+254${subscriber}`, `254${subscriber}`, subscriber];
    const ids = new Set<string>();

    for (const identifier of formats) {
      const res = await request(app).post(`${API}/auth/login`).send({ identifier, password });
      expect(res.status, `login by ${identifier}`).toBe(200);
      ids.add(res.body.data.user.id);
    }

    expect(ids.size).toBe(1);
  });

  it("answers an unknown identifier exactly as it answers a wrong password", async () => {
    // Farmer codes are sequential, so "does this account exist" must not be
    // readable off the response — and the codes are walkable enough that it
    // must not be readable off the timing either.
    const created = await registerFarmer({ firstName: "Real", lastName: "Account", createLogin: true });

    const wrongPassword = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: "Definitely-Not-It!1" });

    const unknown = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: "FARM-2026-99999", password: "Definitely-Not-It!1" });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it("locks an account after repeated failures by farmer code", async () => {
    const created = await registerFarmer({ firstName: "Lock", lastName: "Out", createLogin: true });
    const { farmerCode, credentials } = created.body.data;

    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ identifier: farmerCode, password: `Wrong-Guess-${attempt}!` });
      expect(res.status).toBe(401);
    }

    // The lockout holds even against the password that would otherwise work,
    // which is what makes it a lockout rather than a counter.
    const locked = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: farmerCode, password: credentials.temporaryPassword });

    expect(locked.status).toBe(403);
    expect(locked.body.error.message).toMatch(/locked/i);
  });

  it("refuses a temporary password that has expired", async () => {
    const created = await registerFarmer({ firstName: "Stale", lastName: "Slip", createLogin: true });
    const { id, farmerCode, credentials } = created.body.data;

    await runAsSystem(async () => {
      const farmer = await prisma.farmer.findUnique({ where: { id }, select: { userId: true } });
      await prisma.user.update({
        where: { id: farmer!.userId! },
        data: { temporaryPasswordExpiresAt: new Date(Date.now() - 60_000) },
      });
    });

    const res = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: farmerCode, password: credentials.temporaryPassword });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("TEMPORARY_PASSWORD_EXPIRED");
  });

  // ---------------------------------------------------------------------------
  // Forced password change
  // ---------------------------------------------------------------------------

  it("blocks the API, not just the pages, while a temporary password stands", async () => {
    const created = await registerFarmer({ firstName: "Gate", lastName: "Kept", createLogin: true });
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: created.body.data.credentials.temporaryPassword });
    const token = login.body.data.accessToken;

    // The frontend redirect is a courtesy. This is the enforcement: a caller who
    // skips the browser entirely gets records, or does not.
    for (const path of ["/deliveries", "/batches"]) {
      const res = await request(app).get(`${API}${path}`).set("Authorization", `Bearer ${token}`);
      expect(res.status, `GET ${path}`).toBe(403);
      expect(res.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
  });

  it("still lets a gated user reach the way out and read their own identity", async () => {
    const created = await registerFarmer({ firstName: "Way", lastName: "Out", createLogin: true });
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: created.body.data.credentials.temporaryPassword });
    const token = login.body.data.accessToken;

    const me = await request(app).get(`${API}/users/me`).set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);

    // Wrong current password — a 401 from the handler, not a 403 from the gate.
    const rejected = await request(app)
      .post(`${API}/auth/change-password`)
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "Not-The-One!1", newPassword: strongPassword });
    expect(rejected.status).toBe(401);
  });

  it("clears the flag, hands back working tokens, and kills the old refresh token", async () => {
    const created = await registerFarmer({ firstName: "Own", lastName: "Password", createLogin: true });
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: created.body.data.credentials.temporaryPassword });
    const oldRefresh = login.body.data.refreshToken;

    const changed = await request(app)
      .post(`${API}/auth/change-password`)
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .send({
        currentPassword: created.body.data.credentials.temporaryPassword,
        newPassword: strongPassword,
      });

    expect(changed.status).toBe(200);
    expect(changed.body.data.mustChangePassword).toBe(false);

    // The returned token must clear the gate immediately — otherwise a farmer who
    // has just complied keeps hitting it until the old one expires.
    const afterwards = await request(app)
      .get(`${API}/deliveries`)
      .query({ page: 1, limit: 10 })
      .set("Authorization", `Bearer ${changed.body.data.accessToken}`);
    expect(afterwards.status).toBe(200);

    const replayed = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: oldRefresh });
    expect(replayed.status).toBe(401);

    // The old temporary password is gone; the chosen one works.
    const stale = await request(app)
      .post(`${API}/auth/login`)
      .send({
        identifier: created.body.data.farmerCode,
        password: created.body.data.credentials.temporaryPassword,
      });
    expect(stale.status).toBe(401);

    const fresh = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: strongPassword });
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.mustChangePassword).toBe(false);
  });

  it("re-arms the gate on reset and drops the farmer's session", async () => {
    const created = await registerFarmer({ firstName: "Reset", lastName: "Me", createLogin: true });
    const first = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: created.body.data.credentials.temporaryPassword });

    await request(app)
      .post(`${API}/auth/change-password`)
      .set("Authorization", `Bearer ${first.body.data.accessToken}`)
      .send({ currentPassword: created.body.data.credentials.temporaryPassword, newPassword: strongPassword });

    const settled = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: strongPassword });
    const refreshBeforeReset = settled.body.data.refreshToken;

    const reset = await request(app)
      .post(`${API}/farmers/${created.body.data.id}/account/reset-password`)
      .set(...authHeader(adminA()))
      .send({});

    expect(reset.status).toBe(200);
    expect(reset.body.data.temporaryPassword).toBeTruthy();
    expect(reset.body.data.temporaryPassword).not.toBe(created.body.data.credentials.temporaryPassword);

    // The session cannot be extended past the current access token's lifetime.
    const replayed = await request(app)
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: refreshBeforeReset });
    expect(replayed.status).toBe(401);

    const relogin = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: created.body.data.farmerCode, password: reset.body.data.temporaryPassword });
    expect(relogin.status).toBe(200);
    expect(relogin.body.data.mustChangePassword).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // `POST /auth/register` lockdown
  // ---------------------------------------------------------------------------

  it("no longer lets anyone who can reach the API mint an account", async () => {
    // This returned 201 before the feature: unauthenticated, any role, any
    // cooperative. It is the reason the rest of this suite would have been
    // decorative.
    const res = await request(app).post(`${API}/auth/register`).send({
      email: `intruder-${stamp}@test.local`,
      password: strongPassword,
      firstName: "Un",
      lastName: "Invited",
      role: "COOPERATIVE_ADMIN",
      cooperativeId: coopA,
    });

    expect(res.status).toBe(401);
    const created = await runAsSystem(() =>
      prisma.user.findUnique({ where: { email: `intruder-${stamp}@test.local` } })
    );
    expect(created).toBeNull();
  });

  it("refuses a caller without users:manage", async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .set(...authHeader(staffA()))
      .send({
        email: `staff-made-${stamp}@test.local`,
        password: strongPassword,
        firstName: "Staff",
        lastName: "Made",
        role: "FARMER",
        cooperativeId: coopA,
      });

    expect(res.status).toBe(403);
  });

  it("refuses a cooperative admin minting a peer", async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .set(...authHeader(adminA()))
      .send({
        email: `peer-${stamp}@test.local`,
        password: strongPassword,
        firstName: "New",
        lastName: "Admin",
        role: "COOPERATIVE_ADMIN",
        cooperativeId: coopA,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/cannot create/i);
  });

  it("pins a new account to the caller's own cooperative whatever the body says", async () => {
    const email = `foreign-${stamp}@test.local`;
    const res = await request(app)
      .post(`${API}/auth/register`)
      .set(...authHeader(adminA()))
      .send({
        email,
        password: strongPassword,
        firstName: "Wrong",
        lastName: "Coop",
        role: "COOPERATIVE_STAFF",
        cooperativeId: coopB,
      });

    expect(res.status).toBe(201);
    const user = await runAsSystem(() => prisma.user.findUnique({ where: { email } }));
    expect(user?.cooperativeId).toBe(coopA);
  });

  // ---------------------------------------------------------------------------
  // End to end — the case the feature exists for
  // ---------------------------------------------------------------------------

  it("takes a farmer from registration to reading only their own deliveries and batches", async () => {
    const created = await registerFarmer({ firstName: "Full", lastName: "Circle", createLogin: true });
    const { id: farmerId, farmerCode, credentials } = created.body.data;

    // A neighbour in the same cooperative, whose rows must stay invisible.
    const neighbour = await registerFarmer({ firstName: "Next", lastName: "Door" });

    const { mineDeliveryId, mineBatchId, theirDeliveryId, theirBatchId } = await runAsSystem(async () => {
      const mineBatch = await prisma.coffeeBatch.create({
        data: {
          batchCode: `TEST-FA-BATCH-MINE-${stamp}`,
          cooperativeId: coopA,
          qrCodeToken: `test-fa-mine-${stamp}`,
          originRegion: "Mathira",
        },
      });
      const theirBatch = await prisma.coffeeBatch.create({
        data: {
          batchCode: `TEST-FA-BATCH-THEIRS-${stamp}`,
          cooperativeId: coopA,
          qrCodeToken: `test-fa-theirs-${stamp}`,
          originRegion: "Othaya",
        },
      });
      const mine = await prisma.delivery.create({
        data: {
          deliveryCode: `TEST-FA-DEL-MINE-${stamp}`,
          farmerId,
          cooperativeId: coopA,
          weightKg: 120,
          qualityGrade: "AA",
          batchId: mineBatch.id,
        },
      });
      const theirs = await prisma.delivery.create({
        data: {
          deliveryCode: `TEST-FA-DEL-THEIRS-${stamp}`,
          farmerId: neighbour.body.data.id,
          cooperativeId: coopA,
          weightKg: 90,
          qualityGrade: "AB",
          batchId: theirBatch.id,
        },
      });
      return {
        mineDeliveryId: mine.id,
        mineBatchId: mineBatch.id,
        theirDeliveryId: theirs.id,
        theirBatchId: theirBatch.id,
      };
    });

    // 1. Sign in with the code off the slip.
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ identifier: farmerCode, password: credentials.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePassword).toBe(true);

    // 2. Choose their own password.
    const changed = await request(app)
      .post(`${API}/auth/change-password`)
      .set("Authorization", `Bearer ${login.body.data.accessToken}`)
      .send({ currentPassword: credentials.temporaryPassword, newPassword: strongPassword });
    expect(changed.status).toBe(200);
    const token = changed.body.data.accessToken;

    // 3. Read back their own records — and only those. This is the first account
    //    in the suite whose `farmerId` is resolved from a real provisioning path
    //    rather than a hand-written fixture, so it exercises the link that
    //    `authenticate` reads and every policy narrows on.
    const deliveries = await request(app)
      .get(`${API}/deliveries`)
      .query({ page: 1, limit: 50 })
      .set("Authorization", `Bearer ${token}`);
    expect(deliveries.status).toBe(200);
    const deliveryIds = (deliveries.body.data as { id: string }[]).map((d) => d.id);
    expect(deliveryIds).toContain(mineDeliveryId);
    expect(deliveryIds).not.toContain(theirDeliveryId);

    const batches = await request(app)
      .get(`${API}/batches`)
      .query({ page: 1, limit: 50 })
      .set("Authorization", `Bearer ${token}`);
    expect(batches.status).toBe(200);
    const batchIds = (batches.body.data as { id: string }[]).map((b) => b.id);
    expect(batchIds).toContain(mineBatchId);
    expect(batchIds).not.toContain(theirBatchId);
  });
});
