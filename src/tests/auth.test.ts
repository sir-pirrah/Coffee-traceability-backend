import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { authHeader } from "./helpers/auth";

const API = env.API_PREFIX;

describe("authentication", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects a protected route with no Authorization header", async () => {
    const res = await request(app).get(`${API}/batches`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await request(app).get(`${API}/batches`).set("Authorization", "NotBearer abc");
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    // A structurally valid JWT that our secret cannot verify.
    const forged =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiJmYWtlIiwicm9sZSI6IlNVUEVSX0FETUlOIn0." +
      "definitely-not-a-valid-signature";
    const res = await request(app).get(`${API}/batches`).set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed token (no longer 401)", async () => {
    const res = await request(app)
      .get(`${API}/batches`)
      .set(...authHeader({ id: "11111111-1111-1111-1111-111111111111", role: "SUPER_ADMIN", cooperativeId: null }));
    // The request may still fail for other reasons (e.g. no DB), but the
    // identity itself must be accepted — that is what this asserts.
    expect(res.status).not.toBe(401);
  });

  it("rejects a login with invalid credentials without leaking which field was wrong", async () => {
    const res = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: "nobody@example.com", password: "WrongPassword!1" });
    expect([400, 401]).toContain(res.status);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("password hash");
  });

  it("validates the login payload shape", async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});

describe("public surface", () => {
  let app: Express;
  beforeAll(() => {
    app = createApp();
  });

  it("serves /health without authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("serves the maintenance status without authentication", async () => {
    const res = await request(app).get(`${API}/system/status`);
    expect(res.status).not.toBe(401);
  });

  it("returns 404 through the JSON error handler for unknown routes", async () => {
    const res = await request(app).get(`${API}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
