import { describe, expect, it } from "vitest";

import {
  SensorAdmissionDeniedError,
  assertSensorAdmissionBeforeNativeSpawn,
  evaluateSensorAdmissionContract,
  parseSensorAdmissionContract,
} from "./sensor-admission.js";

const contract = parseSensorAdmissionContract({
  schema: "sensor-admission.v1",
  issueId: "issue-1",
  requiredCapabilities: ["code", "tests"],
  workerQualification: {
    agentId: "agent-1",
    qualificationRevision: "cline-r2",
    agentConfigRevisionId: "config-revision-1",
    qualifiedCapabilities: ["code", "tests", "review"],
  },
  scope: {
    allowedPaths: ["server/src/**", "server/src/__tests__/**"],
    forbiddenPaths: [".github/**"],
  },
  workspace: {
    id: "workspace-1",
    baselineSha: "0123456789abcdef0123456789abcdef01234567",
  },
  minimumRiskClass: "standard",
});

const state = {
  issueId: "issue-1",
  agentId: "agent-1",
  workspaceId: "workspace-1",
  baselineSha: "0123456789abcdef0123456789abcdef01234567",
  nativeRisk: "standard",
  qualificationConfigMatches: true,
};

function expectDenied(
  mutate: Parameters<typeof evaluateSensorAdmissionContract>[1],
  reason: SensorAdmissionDeniedError["reason"],
) {
  try {
    evaluateSensorAdmissionContract(contract, mutate);
  } catch (error) {
    expect(error).toBeInstanceOf(SensorAdmissionDeniedError);
    expect((error as SensorAdmissionDeniedError).reason).toBe(reason);
    return;
  }
  throw new Error("expected SensorAdmissionDeniedError");
}

describe("sensor admission contract", () => {
  it("allows a qualified worker on the pinned workspace baseline", () => {
    expect(() => evaluateSensorAdmissionContract(contract, state)).not.toThrow();
  });

  it("keeps a legacy run ungoverned when no sensor-admission document exists", async () => {
    const resultSets = [
      [{
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        nativeIssueId: "issue-1",
        completionContractId: null,
        completionContractSha256: null,
        contextSnapshot: {},
      }],
      [],
    ];
    let selectIndex = 0;

    const tx = {
      select: () => {
        const rows = resultSets[selectIndex++] ?? [];
        const query = {
          from: () => query,
          innerJoin: () => query,
          where: () => query,
          for: () => query,
          limit: () => Promise.resolve(rows),
        };
        return query;
      },
    };

    const db = {
      transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
    } as unknown as Parameters<typeof assertSensorAdmissionBeforeNativeSpawn>[0]["db"];

    await expect(
      assertSensorAdmissionBeforeNativeSpawn({
        db,
        binding: {
          companyId: "company-1",
          issueId: "issue-1",
          agentId: "agent-1",
          runId: "run-1",
          executionWorkspaceId: "workspace-1",
        },
        completionContract: {
          id: "completion-1",
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }),
    ).resolves.toEqual({ governed: false, pin: null });

    expect(selectIndex).toBe(2);
  });

  it("denies stale qualification configuration", () => {
    expectDenied({ ...state, qualificationConfigMatches: false }, "qualification_config_stale");
  });

  it("denies a different workspace", () => {
    expectDenied({ ...state, workspaceId: "workspace-2" }, "workspace_mismatch");
  });

  it("denies a changed baseline", () => {
    expectDenied(
      { ...state, baselineSha: "fedcba9876543210fedcba9876543210fedcba98" },
      "baseline_mismatch",
    );
  });

  it("denies native risk below the contract requirement", () => {
    expectDenied({ ...state, nativeRisk: "low" }, "completion_contract_mismatch");
  });

  it("rejects missing qualified capabilities", () => {
    const insufficient = parseSensorAdmissionContract({
      ...contract,
      workerQualification: {
        ...contract.workerQualification,
        qualifiedCapabilities: ["code"],
      },
    });
    expect(() => evaluateSensorAdmissionContract(insufficient, state)).toThrowError(
      /capability_missing/,
    );
  });

  it("rejects unsafe scope paths", () => {
    expect(() =>
      parseSensorAdmissionContract({
        ...contract,
        scope: {
          allowedPaths: ["../outside"],
          forbiddenPaths: [],
        },
      }),
    ).toThrowError(/scope_invalid/);
  });
});
