import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  closeRegisteredClients,
  companies,
  agents,
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

  it("preserves a committed claim while allowing unrelated profile edits", async () => {
    const { companyId, issueId } = await issueFixture();
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "P04 claim-guard DB spy",
      role: "engineer", adapterType: "cline_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    const receipt = {
      schema: "sensor-direct-dispatch-claim.v1",
      runId, issueId, attemptId: randomUUID(),
      ownerBootId: randomUUID(), claimedAt: new Date().toISOString(),
    };
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running",
      runnerProfileJson: null,
      contextSnapshot: { issueId },
    });
    // SQL NULL and missing keys are not yet claimed.
    await db.update(heartbeatRuns).set({
      runnerProfileJson: { unrelated: true },
    }).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({
      runnerProfileJson: { sensorDirectDispatchClaim: receipt, unrelated: true },
    }).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({
      runnerProfileJson: { sensorDirectDispatchClaim: receipt, unrelated: "changed" },
    }).where(eq(heartbeatRuns.id, runId));
    for (const forbidden of [null, {}, { sensorDirectDispatchClaim: null },
      { sensorDirectDispatchClaim: { ...receipt, attemptId: randomUUID() } }]) {
      await expect(db.update(heartbeatRuns).set({
        runnerProfileJson: forbidden,
      }).where(eq(heartbeatRuns.id, runId))).rejects.toThrow();
    }
    const [persisted] = await db.select({ profile: heartbeatRuns.runnerProfileJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persisted.profile?.sensorDirectDispatchClaim).toEqual(receipt);
    expect(persisted.profile?.unrelated).toBe("changed");
  });

  it("distinguishes JSON null claim key from missing key", async () => {
    const { companyId, issueId } = await issueFixture();
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "P04 JSON null DB spy",
      role: "engineer", adapterType: "agy_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running",
      runnerProfileJson: { sensorDirectDispatchClaim: null, ordinary: 1 },
      contextSnapshot: { issueId },
    });
    await db.update(heartbeatRuns).set({
      runnerProfileJson: { sensorDirectDispatchClaim: null, ordinary: 2 },
    }).where(eq(heartbeatRuns.id, runId));
    await expect(db.update(heartbeatRuns).set({
      runnerProfileJson: { ordinary: 3 },
    }).where(eq(heartbeatRuns.id, runId))).rejects.toThrow();
    await expect(db.update(heartbeatRuns).set({
      runnerProfileJson: null,
    }).where(eq(heartbeatRuns.id, runId))).rejects.toThrow();
  });
});
