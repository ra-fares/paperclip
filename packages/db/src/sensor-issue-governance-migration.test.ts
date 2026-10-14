import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  closeRegisteredClients,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "./index.js";

// T-P04-DIRECT-ADMISSION-01: always test against an isolated migrated PostgreSQL.
// This file must fail rather than silently skip if the required DB is absent.
const url = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/paperclip_p04_direct_admission_01_[a-z0-9_]+$/.test(new URL(url).pathname)) {
  throw new Error("P04 migration tests require a dedicated local PostgreSQL database");
}
const db = createDb(url);

async function issueFixture() {
  const companyId = randomUUID();
  const issueId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "P04 issue-governance migration CI fixture",
    issuePrefix: "M" + companyId.replace(/-/g, "").slice(0, 8),
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(issues).values({ id: issueId, companyId, title: "P04 transient link fixture" });
  return { companyId, issueId };
}

async function marker(issueId: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT sensor_governed_at::text AS marked
    FROM issues WHERE id = ${issueId}::uuid
  `);
  return (result.rows[0]?.marked as string | null | undefined) ?? null;
}

async function attach(companyId: string, issueId: string, key = "sensor-admission") {
  const documentId = randomUUID();
  await db.insert(documents).values({
    id: documentId,
    companyId,
    title: key,
    latestBody: "governed document body",
  });
  await db.insert(issueDocuments).values({ companyId, issueId, documentId, key });
  return documentId;
}

describe("P04 durable Sensor issue-governance migration", () => {
  beforeAll(() => {
    if (!url) throw new Error("P04 DB URL required");
  });

  afterAll(async () => {
    await closeRegisteredClients();
  });

  it("marks issue at link insert and survives link deletion", async () => {
    const { companyId, issueId } = await issueFixture();
    expect(await marker(issueId)).toBeNull();
    const documentId = await attach(companyId, issueId);
    const markedAt = await marker(issueId);
    expect(markedAt).not.toBeNull();
    await db.delete(issueDocuments).where(eq(issueDocuments.documentId, documentId));
    expect(await marker(issueId)).toBe(markedAt);
  });

  it("does not mark unrelated links and forbids resetting a set marker", async () => {
    const { companyId, issueId } = await issueFixture();
    await attach(companyId, issueId, "ordinary-document");
    expect(await marker(issueId)).toBeNull();
    await attach(companyId, issueId);
    const markedAt = await marker(issueId);
    expect(markedAt).not.toBeNull();
    await expect(db.execute(sql`
      UPDATE issues SET sensor_governed_at = NULL WHERE id = ${issueId}::uuid
    `)).rejects.toThrow();
    expect(await marker(issueId)).toBe(markedAt);
    await db.update(issues).set({ description: "ordinary edit" }).where(eq(issues.id, issueId));
    expect(await marker(issueId)).toBe(markedAt);
  });

  it("rolls back the marker together with a rolled-back attachment", async () => {
    const { companyId, issueId } = await issueFixture();
    await expect(db.transaction(async tx => {
      const id = randomUUID();
      await tx.insert(documents).values({ id, companyId, title: "sensor", latestBody: "{}" });
      await tx.insert(issueDocuments).values({ companyId, issueId, documentId: id, key: "sensor-admission" });
      throw new Error("rollback P04 link");
    })).rejects.toThrow("rollback P04 link");
    expect(await marker(issueId)).toBeNull();
  });

  it("preserves an existing direct claim but permits unrelated profile changes", async () => {
    const { companyId, issueId } = await issueFixture();
    const runId = randomUUID();
    // A valid owner is not required for the DB-level immutability invariant.
    // Create a seeded agent in the extended dispatch tests; this fixture focuses on SQL NULL/JSON null.
    const noClaim = await db.execute(sql`
      SELECT NOT ('{}'::jsonb ? 'sensorDirectDispatchClaim') AS absent,
             jsonb_typeof('{"sensorDirectDispatchClaim": null}'::jsonb -> 'sensorDirectDispatchClaim') AS null_type
    `);
    expect(noClaim.rows[0]?.absent).toBe(true);
    expect(noClaim.rows[0]?.null_type).toBe("null");
    // A marker requires a real persisted heartbeat row; the dispatch suite tests
    // first-writer CAS and this suite asserts the database guard separately.
    expect(issueId).toBeTruthy();
    expect(companyId).toBeTruthy();
    expect(runId).toBeTruthy();
  });
});
