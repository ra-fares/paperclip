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
  const [result] = await db.select({
    marked: sql<string | null>`sensor_governed_at::text`,
  }).from(issues).where(eq(issues.id, issueId));
  if (!result) throw new Error("Missing issue in P04 migration test fixture");
  return result.marked;
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


/**
 * CI executes this suite against the REAL 0292 schema before applying 0293.
 * The second invocation, with P04_BACKFILL_SEED unset, verifies historical rows.
 * Never fabricate backfill by inserting test data after migration.
 */
if (process.env.P04_BACKFILL_SEED === "true") {
  describe("P04 pre-0293 fixture seed (schema 0292 only)", () => {
    afterAll(async () => { await closeRegisteredClients(url); });
    it("seeds pre-existing Sensor link and run provenance plus invalid / foreign / absent witnesses", async () => {
      const column = await db.execute(sql`
        SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'issues'
          AND column_name = 'sensor_governed_at'
      `);
      expect(column[0]?.count).toBe(0);

      const companyId = randomUUID(), foreignCompanyId = randomUUID();
      const agentId = randomUUID(), foreignAgentId = randomUUID();
      await db.insert(companies).values([
        { id: companyId, name: "P04 pre-0293 historical company",
          issuePrefix: "B" + companyId.slice(0, 8), requireBoardApprovalForNewAgents: false },
        { id: foreignCompanyId, name: "P04 pre-0293 mismatched run company",
          issuePrefix: "B" + foreignCompanyId.slice(0, 8), requireBoardApprovalForNewAgents: false },
      ]);
      await db.insert(agents).values([
        { id: agentId, companyId, name: "P04 pre-0293 owner",
          role: "engineer", adapterType: "cline_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { id: foreignAgentId, companyId: foreignCompanyId, name: "P04 pre-0293 foreign owner",
          role: "engineer", adapterType: "agy_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ]);
      const kinds = ["document", "trusted", "malformed", "wrong-company", "absent",
        "wrong-schema", "invalid-id"] as const;
      const ids = Object.fromEntries(kinds.map(kind => [kind, randomUUID()])) as Record<typeof kinds[number], string>;
      // Historical fixtures are blocked so later recovery integration suites\n      // cannot redispatch unrelated imported issues without responsible users.\n      // This suite runs on 0292, while the compiled Drizzle schema already
      // includes the 0293-only sensor_governed_at column. Use legacy SQL here.
      for (const kind of kinds) {
        await db.execute(sql`
          INSERT INTO issues (id, company_id, title, assignee_agent_id, status)
          VALUES (${ids[kind]}::uuid, ${companyId}::uuid, ${"P04_PREFILL:" + kind},
                  ${agentId}::uuid, 'blocked')
        `);
      }
      const documentId = randomUUID();
      await db.insert(documents).values({
        id: documentId, companyId, title: "P04 pre-0293 Sensor", latestBody: "{}",
      });
      await db.insert(issueDocuments).values({
        issueId: ids.document, companyId, documentId, key: "sensor-admission",
      });
      const provenance = (kind: string, issueId: unknown) =>
        ({ sensorGovernance: { schema: kind, issueId } });
      const run = (
        company: string, agent: string, issueId: string,
        runnerProfileJson: Record<string, unknown>,
      ) => ({
        id: randomUUID(), companyId: company, agentId: agent,
        status: "failed" as const, runtimeMode: "legacy" as const,
        runnerProfileJson, contextSnapshot: { issueId },
      });
      await db.insert(heartbeatRuns).values([
        run(companyId, agentId, ids.trusted, provenance("sensor-governance.queued.v1", ids.trusted)),
        run(companyId, agentId, ids.malformed, { sensorGovernance: { issueId: ["invalid"], schema: 3 } }),
        run(foreignCompanyId, foreignAgentId, ids["wrong-company"],
          provenance("sensor-governance.queued.v1", ids["wrong-company"])),
        run(companyId, agentId, ids["wrong-schema"], provenance("invalid-schema.v1", ids["wrong-schema"])),
        run(companyId, agentId, ids["invalid-id"],
          provenance("sensor-governance.queued.v1", { bogus: ids["invalid-id"] })),
      ]);
      const stored = await db.select({ title: issues.title }).from(issues)
        .where(sql`${issues.title} like 'P04_PREFILL:%'`);
      expect(stored).toHaveLength(kinds.length);
    });
  });
} else {
describe("P04 durable Sensor issue-governance migration", () => {
  beforeAll(() => {
    if (!url) throw new Error("P04 DB URL required");
  });

  afterAll(async () => {
    await closeRegisteredClients(url);
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
  it("SQL claim guard distinguishes SQL NULL, JSON null, key deletion/replacement, and unrelated fields", async () => {
    const { companyId, issueId } = await issueFixture();
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "P04 direct SQL claim guard",
      role: "engineer", adapterType: "cline_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running",
      runnerProfileJson: null, contextSnapshot: { issueId },
    });
    // SQL NULL is not a committed claim; it may gain the server-owned receipt.
    const receipt = {
      schema: "sensor-direct-dispatch-claim.v1",
      runId, issueId, attemptId: randomUUID(),
      ownerBootId: randomUUID(), claimedAt: new Date().toISOString(),
    };
    await db.execute(sql`
      UPDATE heartbeat_runs
      SET runner_profile_json = jsonb_build_object('ordinary', 'initial')
      WHERE id = ${runId}::uuid AND runner_profile_json IS NULL
    `);
    await db.update(heartbeatRuns).set({
      runnerProfileJson: { ordinary: "initial", sensorDirectDispatchClaim: receipt },
    }).where(eq(heartbeatRuns.id, runId));

    // These are different PostgreSQL JSON operations. None may erase or
    // replace a committed receipt, even when JSON null is not SQL NULL.
    await expect(db.execute(sql`UPDATE heartbeat_runs
      SET runner_profile_json = NULL WHERE id = ${runId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE heartbeat_runs
      SET runner_profile_json = 'null'::jsonb WHERE id = ${runId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE heartbeat_runs
      SET runner_profile_json = runner_profile_json - 'sensorDirectDispatchClaim'
      WHERE id = ${runId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE heartbeat_runs
      SET runner_profile_json = jsonb_set(runner_profile_json,
        '{sensorDirectDispatchClaim}', 'null'::jsonb)
      WHERE id = ${runId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE heartbeat_runs
      SET runner_profile_json = jsonb_set(runner_profile_json,
        '{sensorDirectDispatchClaim}', ${JSON.stringify({ ...receipt, attemptId: randomUUID() })}::jsonb)
      WHERE id = ${runId}::uuid`)).rejects.toThrow();

    await db.execute(sql`UPDATE heartbeat_runs
      SET runner_profile_json = jsonb_set(runner_profile_json,
        '{ordinary}', '"permitted"'::jsonb)
      WHERE id = ${runId}::uuid`);
    const [stored] = await db.select({ profile: heartbeatRuns.runnerProfileJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(stored?.profile?.sensorDirectDispatchClaim).toEqual(receipt);
    expect(stored?.profile?.ordinary).toBe("permitted");
  });

  it("BACKFILL on real pre-0293 rows recognizes current link and trusted run evidence, ignores invalid or foreign evidence", async () => {
    const rows = await db.select({
      title: issues.title, companyId: issues.companyId, marked: issues.sensorGovernedAt,
    }).from(issues).where(sql`${issues.title} like 'P04_PREFILL:%'`);
    const observed = new Map(rows.map(row => [row.title.replace("P04_PREFILL:", ""), row.marked]));
    expect(observed.size).toBe(7); // Fails if the CI pre-migration seed never happened.
    expect(observed.get("document")).toBeInstanceOf(Date);
    expect(observed.get("trusted")).toBeInstanceOf(Date);
    for (const name of ["malformed", "wrong-company", "absent", "wrong-schema", "invalid-id"]) {
      expect(observed.has(name)).toBe(true);
      expect(observed.get(name), name).toBeNull();
    }
    const applied = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM information_schema.columns WHERE table_name = 'issues'
        AND column_name = 'sensor_governed_at'
    `);
    expect(applied[0]?.count).toBe(1);
  });

});
}
