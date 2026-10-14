import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentConfigRevisions,
  agents,
  closeRegisteredClients,
  companies,
  completionContracts,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  heartbeatRunEvents,
  nativeRunFinalizations,
  issueDocuments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  executeNativeSession,
  type ControlPlanePort,
  type NativeExecutionInput,
  type NativeSessionBackend,
} from "@paperclipai/paperclip-runner";
import {
  SENSOR_ADMISSION_CONTEXT_KEY,
  SENSOR_ADMISSION_DOCUMENT_KEY,
  SensorAdmissionDeniedError,
  assertSensorAdmissionBeforeNativeSpawn,
  parseSensorAdmissionContract,
} from "./sensor-admission.js";
import { nativeSha256 } from "./canonical.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";

// The DB is provisioned and migrated by a dedicated CI job, not by this test.
// Fail closed: no silent embedded DB fallback and never use application DB.
const testUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
type Db = ReturnType<typeof createDb>;
let db: Db;

const baselineSha = "b".repeat(40);
const completionSha = "c".repeat(64);

beforeAll(() => {
  if (!testUrl) throw new Error("PAPERCLIP_TEST_DATABASE_URL is mandatory for real DB admission tests");
  const parsed = new URL(testUrl);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/paperclip_p04_db_acceptance_01_[a-z0-9_]+$/.test(parsed.pathname)
  ) throw new Error("Refusing non-local or non-task PostgreSQL database");
  db = createDb(testUrl);
});

afterAll(async () => {
  if (testUrl) await closeRegisteredClients(testUrl);
});

async function makeFixture(withAdmissionDocument = true) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  const completionId = randomUUID();
  const configRevisionId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "P04 isolated DB fixture",
    issuePrefix: `P04${randomUUID().replace(/-/g, "").slice(0, 10)}`,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "P04 test worker (never started)",
    adapterType: "process",
    capabilities: "code,tests",
    adapterConfig: {},
    runtimeConfig: {},
  });
  await db.insert(agentConfigRevisions).values({
    id: configRevisionId,
    companyId,
    agentId,
    beforeConfig: {},
    afterConfig: {
      capabilities: "code,tests",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: null,
    },
  });
  await db.insert(projects).values({ id: projectId, companyId, name: "P04 admission fixture" });
  await db.insert(executionWorkspaces).values({
    id: workspaceId,
    companyId,
    projectId,
    name: "isolated-p04-db",
    mode: "worktree",
    strategyType: "isolated",
    metadata: { baseRefSnapshot: { resolvedSha: baselineSha } },
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "P04 native admission fixture",
    assigneeAgentId: agentId,
    executionWorkspaceId: workspaceId,
  });
  await db.insert(completionContracts).values({
    id: completionId,
    companyId,
    issueId,
    revision: 1,
    schemaVersion: "paperclip.completion-contract.v1",
    policyVersion: "test-only",
    risk: "standard",
    completionAuthority: "test-only",
    incompleteCriteriaPolicy: "test-only",
    contractJson: {},
    canonicalSha256: completionSha,
    createdByActorType: "system",
    createdByActorId: "P04 DB acceptance fixture",
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    nativeIssueId: issueId,
    completionContractId: completionId,
    completionContractSha256: completionSha,
    contextSnapshot: {},
    runtimeMode: "native",
  });

  const binding = { companyId, agentId, issueId, runId, executionWorkspaceId: workspaceId };
  const completionContract = { id: completionId, sha256: completionSha };
  const contract = parseSensorAdmissionContract({
    schema: "sensor-admission.v1",
    issueId,
    requiredCapabilities: ["code", "tests"],
    workerQualification: {
      agentId,
      qualificationRevision: "qualified-v1",
      agentConfigRevisionId: configRevisionId,
      qualifiedCapabilities: ["code", "tests"],
    },
    scope: { allowedPaths: ["server/src/**"], forbiddenPaths: [".github/**"] },
    workspace: { id: workspaceId, baselineSha },
    minimumRiskClass: "standard",
  });

  let documentId: string | null = null;
  let revisionId: string | null = null;
  if (withAdmissionDocument) {
    documentId = randomUUID();
    revisionId = randomUUID();
    const body = JSON.stringify(contract);
    await db.insert(documents).values({
      id: documentId, companyId, title: "sensor-admission", latestBody: body,
    });
    await db.insert(documentRevisions).values({
      id: revisionId, companyId, documentId, revisionNumber: 1, body,
    });
    await db.update(documents).set({
      latestRevisionId: revisionId,
    }).where(eq(documents.id, documentId));
    await db.insert(issueDocuments).values({
      companyId, issueId, documentId, key: SENSOR_ADMISSION_DOCUMENT_KEY,
    });
  }
  const admit = () => assertSensorAdmissionBeforeNativeSpawn({ db, binding, completionContract });
  const persistedPin = async () => {
    // A separate Drizzle pool/connection reads only *committed* data.
    const fresh = createDb(testUrl!);
    const [row] = await fresh.select({ snapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return ((row?.snapshot ?? {}) as Record<string, unknown>)[SENSOR_ADMISSION_CONTEXT_KEY] ?? null;
  };
  return { companyId, agentId, issueId, runId, workspaceId, documentId, revisionId, configRevisionId,
    completionId, contract, binding, completionContract, admit, persistedPin };
}

describe("P04 native Sensor admission — real isolated PostgreSQL", () => {
  it("DB1: ALLOW commits a durable pin visible from a separate DB connection", async () => {
    const f = await makeFixture();
    const result = await f.admit();
    expect(result.governed).toBe(true);
    expect(result.pin).toMatchObject({
      schema: "sensor-admission.pin.v1",
      documentId: f.documentId,
      revisionId: f.revisionId,
      contractSha256: nativeSha256(f.contract),
      agentConfigRevisionId: f.configRevisionId,
      workspaceId: f.workspaceId,
      baselineSha,
      completionContractId: f.completionId,
      completionContractSha256: completionSha,
    });
    expect(new Date(result.pin!.admittedAt).toISOString()).toBe(result.pin!.admittedAt);
    expect(await f.persistedPin()).toEqual(result.pin);
  });

  it("DB2: latest revision changes, but original run pin and admittedAt remain immutable", async () => {
    const f = await makeFixture();
    const first = await f.admit();
    const persistedBefore = await f.persistedPin();
    const nextRevisionId = randomUUID();
    const nextContract = { ...f.contract, scope: { ...f.contract.scope, allowedPaths: ["another/**"] } };
    await db.insert(documentRevisions).values({
      id: nextRevisionId, companyId: f.companyId, documentId: f.documentId!,
      revisionNumber: 2, body: JSON.stringify(nextContract),
    });
    await db.update(documents).set({
      latestRevisionId: nextRevisionId, latestRevisionNumber: 2, latestBody: JSON.stringify(nextContract),
    }).where(eq(documents.id, f.documentId!));
    const again = await f.admit();
    expect(again).toEqual(first);
    expect(again.pin!.revisionId).toBe(f.revisionId);
    expect(again.pin!.revisionId).not.toBe(nextRevisionId);
    expect(await f.persistedPin()).toEqual(persistedBefore);
  });

  it("DB3: stale qualification DENY precedes real runner backend.openSession", async () => {
    const f = await makeFixture();
    await db.update(agents).set({ adapterConfig: { changedAfterQualification: true } })
      .where(eq(agents.id, f.agentId));
    const openSession = vi.fn(async () => { throw new Error("backend must not execute"); });
    const backend = {
      async descriptor() {
        return {
          kind: "mock", name: "p04-db3-no-model", version: "1",
          capabilities: { sessions: true },
        };
      },
      openSession,
    } as unknown as NativeSessionBackend;
    // Drive the production runner entrypoint with its actual onSessionAdmission
    // callback. The backend is a test double; no provider/model is available.
    const input = {
      schema: "paperclip.native-execution-input.v1",
      binding: f.binding,
      task: {
        identifier: "P04-DB3", title: "stale qualification", description: null,
        prompt: "Never execute provider", workMode: "standard",
      },
      workspace: { cwd: "/isolated", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: randomUUID(), driverKind: "codex_app_server", protocolVersion: 1 },
      provider: { kind: "codex", model: null },
      completionContract: {
        id: f.completionId, sha256: completionSha,
        schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "no provider",
          criteria: [{ id: "objective", requirement: "Never execute" }] },
      },
      interactionResponses: [], credentialBindings: [],
    } as unknown as NativeExecutionInput;
    await expect(executeNativeSession({
      onSessionAdmission: async () => { await f.admit(); },
      input, backend, controlPlane: {} as ControlPlanePort,
      runnerInstanceId: "p04-db3-test-runner", controlPlaneInstanceId: "p04-db3-test-control",
    })).rejects.toMatchObject({
      code: "sensor_admission_denied",
      reason: "qualification_config_stale",
    } satisfies Partial<SensorAdmissionDeniedError>);
    expect(openSession).not.toHaveBeenCalled();
    expect(await f.persistedPin()).toBeNull();
  });

  it("DB4: absent sensor-admission document is an explicit legacy opt-out on PostgreSQL", async () => {
    const f = await makeFixture(false);
    await expect(f.admit()).resolves.toEqual({ governed: false, pin: null });
    expect(await f.persistedPin()).toBeNull();
  });

  // The next two checks must use the actual server entrypoint, NOT a callback
  // provided by the test to executeNativeSession. No real provider is available.
  async function prepareServerAdmissionFixture(f: Awaited<ReturnType<typeof makeFixture>>) {
    await db.update(heartbeatRuns).set({
      status: "running",
      startedAt: new Date(),
      nativeSessionId: f.runId,
      runnerInstanceId: "p04-db3-server-runner",
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({
      runId: f.runId,
      companyId: f.companyId,
      issueId: f.issueId,
      phase: "pending",
      attempt: 0,
    });
  }

  function serverExecutionInput(f: Awaited<ReturnType<typeof makeFixture>>): NativeExecutionInput {
    return {
      schema: "paperclip.native-execution-input.v1",
      binding: f.binding,
      task: {
        identifier: "P04-DB3-SERVER",
        title: "Server admission path",
        description: null,
        prompt: "No external provider permitted",
        workMode: "standard",
      },
      workspace: { cwd: "/isolated", repoUrl: null, repoRef: null, branchName: null },
      session: {
        normalizedSessionId: f.runId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
      },
      provider: { kind: "codex", model: null },
      completionContract: {
        id: f.completionId,
        sha256: completionSha,
        schemaVersion: "paperclip.completion-contract.v1",
        contract: {
          revision: "1",
          objective: "Test admission without a provider",
          criteria: [{ id: "objective", requirement: "No model may be started" }],
        },
      },
      interactionResponses: [],
      credentialBindings: [],
    } as NativeExecutionInput;
  }

  async function serverRunEvidence(f: Awaited<ReturnType<typeof makeFixture>>) {
    const [run] = await db.select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [finalization] = await db.select({
      phase: nativeRunFinalizations.phase,
      failureCode: nativeRunFinalizations.failureCode,
      nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
    }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const events = await db.select({
      eventType: heartbeatRunEvents.eventType,
    }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    return {
      run,
      finalization,
      processStartRequested: events.filter(e => e.eventType === "native.process_start_requested").length,
    };
  }

  function serverBackend(openSession: ReturnType<typeof vi.fn>): NativeSessionBackend {
    return {
      async descriptor() {
        return {
          kind: "mock", name: "p04-server-entrypoint-spy", version: "1",
          capabilities: { sessions: true },
        };
      },
      openSession,
    } as unknown as NativeSessionBackend;
  }

  it("DB3-server DENY: stale qualification fails in server-created guard before provider launch", async () => {
    const f = await makeFixture();
    await prepareServerAdmissionFixture(f);
    await db.update(agents).set({ adapterConfig: { changedAfterQualification: true } })
      .where(eq(agents.id, f.agentId));

    const openSession = vi.fn(async () => {
      throw new Error("P04_BACKEND_MUST_NOT_OPEN");
    });
    const onSpawn = vi.fn(async () => {});
    await expect(executePaperclipNativeSession({
      db,
      execution: serverExecutionInput(f),
      runnerInstanceId: "p04-db3-server-runner",
      useRunnerd: false,
      backend: serverBackend(openSession),
      onSpawn,
    })).rejects.toMatchObject({
      code: "sensor_admission_denied",
      reason: "qualification_config_stale",
    } satisfies Partial<SensorAdmissionDeniedError>);

    expect(openSession).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(await f.persistedPin()).toBeNull();
    const evidence = await serverRunEvidence(f);
    expect(evidence.processStartRequested).toBe(0);
    expect(evidence.run).toMatchObject({
      status: "failed",
      errorCode: "sensor_admission_denied",
    });
    expect(evidence.finalization).toMatchObject({
      phase: "terminal_failure",
      failureCode: "sensor_admission_denied",
      nextAttemptAt: null,
    });
  });

  it("DB3-server ALLOW control: committed pin and start-request event precede safe backend spy", async () => {
    const f = await makeFixture();
    await prepareServerAdmissionFixture(f);
    let pinAtBackend: unknown = null;
    let eventCountAtBackend = -1;
    const openSession = vi.fn(async () => {
      pinAtBackend = await f.persistedPin();
      eventCountAtBackend = (await serverRunEvidence(f)).processStartRequested;
      // Stop at provider boundary without starting any provider or model.
      throw new Error("P04_TEST_BACKEND_BOUNDARY_REACHED");
    });
    const onSpawn = vi.fn(async () => {});
    await expect(executePaperclipNativeSession({
      db,
      execution: serverExecutionInput(f),
      runnerInstanceId: "p04-db3-server-runner",
      useRunnerd: false,
      backend: serverBackend(openSession),
      onSpawn,
    })).rejects.toThrow("P04_TEST_BACKEND_BOUNDARY_REACHED");

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(pinAtBackend).toMatchObject({
      revisionId: f.revisionId,
      workspaceId: f.workspaceId,
      completionContractId: f.completionId,
    });
    expect(eventCountAtBackend).toBe(1);
    expect(await f.persistedPin()).toEqual(pinAtBackend);
  });

});
