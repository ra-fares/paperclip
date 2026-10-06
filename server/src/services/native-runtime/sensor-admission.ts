import { and, eq } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  agentConfigRevisions,
  agents,
  completionContracts,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "@paperclipai/db";

import { nativeSha256 } from "./canonical.js";

export const SENSOR_ADMISSION_DOCUMENT_KEY = "sensor-admission";
export const SENSOR_ADMISSION_SCHEMA = "sensor-admission.v1";
export const SENSOR_ADMISSION_PIN_SCHEMA = "sensor-admission.pin.v1";
export const SENSOR_ADMISSION_CONTEXT_KEY = "sensorAdmission";

export type SensorAdmissionDenyReason =
  | "contract_invalid"
  | "issue_mismatch"
  | "assignee_mismatch"
  | "qualification_missing"
  | "qualification_agent_mismatch"
  | "qualification_config_stale"
  | "capability_missing"
  | "scope_invalid"
  | "workspace_mismatch"
  | "baseline_missing"
  | "baseline_mismatch"
  | "completion_contract_mismatch"
  | "binding_conflict";

export class SensorAdmissionDeniedError extends Error {
  readonly code = "sensor_admission_denied" as const;

  constructor(
    readonly reason: SensorAdmissionDenyReason,
    readonly detail: string,
  ) {
    super(`sensor_admission_denied:${reason}: ${detail}`);
    this.name = "SensorAdmissionDeniedError";
  }
}

export interface SensorAdmissionContract {
  schema: typeof SENSOR_ADMISSION_SCHEMA;
  issueId: string;
  requiredCapabilities: string[];
  workerQualification: {
    agentId: string;
    qualificationRevision: string;
    agentConfigRevisionId: string;
    qualifiedCapabilities: string[];
  };
  scope: {
    allowedPaths: string[];
    forbiddenPaths: string[];
  };
  workspace: {
    id: string;
    baselineSha: string;
  };
  minimumRiskClass: "low" | "standard";
}

export interface SensorAdmissionRuntimeState {
  issueId: string;
  agentId: string;
  workspaceId: string;
  baselineSha: string;
  nativeRisk: string;
  qualificationConfigMatches: boolean;
}

export interface SensorAdmissionPin {
  schema: typeof SENSOR_ADMISSION_PIN_SCHEMA;
  documentId: string;
  revisionId: string;
  contractSha256: string;
  qualificationRevision: string;
  agentConfigRevisionId: string;
  workspaceId: string;
  baselineSha: string;
  completionContractId: string;
  completionContractSha256: string;
  admittedAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SensorAdmissionDeniedError("contract_invalid", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizedCapabilityList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SensorAdmissionDeniedError("contract_invalid", `${field} must be a non-empty array`);
  }
  const capabilities = value.map((entry, index) =>
    nonEmptyString(entry, `${field}[${index}]`).toLowerCase());
  if (capabilities.some((entry) => !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(entry))) {
    throw new SensorAdmissionDeniedError("contract_invalid", `${field} contains an invalid capability token`);
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new SensorAdmissionDeniedError("contract_invalid", `${field} contains duplicate capabilities`);
  }
  return capabilities;
}

function normalizedScopePath(value: unknown, field: string): string {
  const path = nonEmptyString(value, field);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new SensorAdmissionDeniedError("scope_invalid", `${field} must be a workspace-relative forward-slash path`);
  }
  return path.replace(/^\.\//, "");
}

function normalizedScopePaths(
  value: unknown,
  field: string,
  options: { allowEmpty: boolean },
): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new SensorAdmissionDeniedError(
      "scope_invalid",
      `${field} must be ${options.allowEmpty ? "an array" : "a non-empty array"}`,
    );
  }
  const paths = value.map((entry, index) =>
    normalizedScopePath(entry, `${field}[${index}]`));
  if (new Set(paths).size !== paths.length) {
    throw new SensorAdmissionDeniedError("scope_invalid", `${field} contains duplicate paths`);
  }
  return paths;
}

function normalizedSha(value: unknown, field: string): string {
  const sha = nonEmptyString(value, field).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new SensorAdmissionDeniedError("contract_invalid", `${field} must be a 40-64 character hex SHA`);
  }
  return sha;
}

export function parseSensorAdmissionContract(value: unknown): SensorAdmissionContract {
  const input = record(value);
  if (input.schema !== SENSOR_ADMISSION_SCHEMA) {
    throw new SensorAdmissionDeniedError("contract_invalid", `schema must be ${SENSOR_ADMISSION_SCHEMA}`);
  }
  const worker = record(input.workerQualification);
  const scope = record(input.scope);
  const workspace = record(input.workspace);
  const risk = input.minimumRiskClass ?? "low";
  if (risk !== "low" && risk !== "standard") {
    throw new SensorAdmissionDeniedError("contract_invalid", "minimumRiskClass must be low or standard");
  }
  return {
    schema: SENSOR_ADMISSION_SCHEMA,
    issueId: nonEmptyString(input.issueId, "issueId"),
    requiredCapabilities: normalizedCapabilityList(
      input.requiredCapabilities,
      "requiredCapabilities",
    ),
    workerQualification: {
      agentId: nonEmptyString(worker.agentId, "workerQualification.agentId"),
      qualificationRevision: nonEmptyString(
        worker.qualificationRevision,
        "workerQualification.qualificationRevision",
      ),
      agentConfigRevisionId: nonEmptyString(
        worker.agentConfigRevisionId,
        "workerQualification.agentConfigRevisionId",
      ),
      qualifiedCapabilities: normalizedCapabilityList(
        worker.qualifiedCapabilities,
        "workerQualification.qualifiedCapabilities",
      ),
    },
    scope: {
      allowedPaths: normalizedScopePaths(
        scope.allowedPaths,
        "scope.allowedPaths",
        { allowEmpty: false },
      ),
      forbiddenPaths: normalizedScopePaths(
        scope.forbiddenPaths ?? [],
        "scope.forbiddenPaths",
        { allowEmpty: true },
      ),
    },
    workspace: {
      id: nonEmptyString(workspace.id, "workspace.id"),
      baselineSha: normalizedSha(workspace.baselineSha, "workspace.baselineSha"),
    },
    minimumRiskClass: risk,
  };
}

export function parseSensorAdmissionDocumentBody(body: string): SensorAdmissionContract {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new SensorAdmissionDeniedError("contract_invalid", "sensor-admission body must be valid JSON");
  }
  return parseSensorAdmissionContract(decoded);
}

export function evaluateSensorAdmissionContract(
  contract: SensorAdmissionContract,
  state: SensorAdmissionRuntimeState,
): void {
  if (contract.issueId !== state.issueId) {
    throw new SensorAdmissionDeniedError("issue_mismatch", "contract issueId does not match the executing issue");
  }
  if (contract.workerQualification.agentId !== state.agentId) {
    throw new SensorAdmissionDeniedError(
      "qualification_agent_mismatch",
      "qualified agent does not match the executing agent",
    );
  }
  if (!state.qualificationConfigMatches) {
    throw new SensorAdmissionDeniedError(
      "qualification_config_stale",
      "agent execution configuration changed after the referenced qualification revision",
    );
  }
  const qualified = new Set(contract.workerQualification.qualifiedCapabilities);
  const missing = contract.requiredCapabilities.filter((capability) => !qualified.has(capability));
  if (missing.length > 0) {
    throw new SensorAdmissionDeniedError(
      "capability_missing",
      `qualification does not cover required capabilities: ${missing.join(", ")}`,
    );
  }
  if (contract.workspace.id !== state.workspaceId) {
    throw new SensorAdmissionDeniedError(
      "workspace_mismatch",
      "contract workspace does not match the run workspace",
    );
  }
  if (contract.workspace.baselineSha !== state.baselineSha.toLowerCase()) {
    throw new SensorAdmissionDeniedError(
      "baseline_mismatch",
      "recorded workspace baseline does not match the contract baseline",
    );
  }
  const riskRank = { low: 0, standard: 1 } as const;
  if (
    state.nativeRisk !== "low" &&
    state.nativeRisk !== "standard"
  ) {
    throw new SensorAdmissionDeniedError(
      "completion_contract_mismatch",
      `unsupported native completion risk ${JSON.stringify(state.nativeRisk)}`,
    );
  }
  if (riskRank[state.nativeRisk] < riskRank[contract.minimumRiskClass]) {
    throw new SensorAdmissionDeniedError(
      "completion_contract_mismatch",
      `native completion risk ${state.nativeRisk} is below required ${contract.minimumRiskClass}`,
    );
  }
}

function readBaselineSha(metadata: unknown): string | null {
  const snapshot = record(record(metadata).baseRefSnapshot);
  return typeof snapshot.resolvedSha === "string" && /^[a-f0-9]{40,64}$/i.test(snapshot.resolvedSha.trim())
    ? snapshot.resolvedSha.trim().toLowerCase()
    : null;
}

function executionConfigFingerprintFromAgent(agent: {
  capabilities: string | null;
  adapterType: string;
  adapterConfig: unknown;
  runtimeConfig: unknown;
  defaultEnvironmentId: string | null;
}) {
  return nativeSha256({
    capabilities: agent.capabilities,
    adapterType: agent.adapterType,
    adapterConfig: record(agent.adapterConfig),
    runtimeConfig: record(agent.runtimeConfig),
    defaultEnvironmentId: agent.defaultEnvironmentId,
  });
}

function executionConfigFingerprintFromRevision(afterConfig: unknown) {
  const config = record(afterConfig);
  return nativeSha256({
    capabilities: typeof config.capabilities === "string" ? config.capabilities : null,
    adapterType: typeof config.adapterType === "string" ? config.adapterType : null,
    adapterConfig: record(config.adapterConfig),
    runtimeConfig: record(config.runtimeConfig),
    defaultEnvironmentId:
      typeof config.defaultEnvironmentId === "string"
        ? config.defaultEnvironmentId
        : null,
  });
}

function parseAdmissionPin(value: unknown): SensorAdmissionPin | null {
  if (value === undefined || value === null) return null;
  const pin = record(value);
  if (pin.schema !== SENSOR_ADMISSION_PIN_SCHEMA) {
    throw new SensorAdmissionDeniedError("binding_conflict", "run contains an invalid sensor admission pin");
  }
  return {
    schema: SENSOR_ADMISSION_PIN_SCHEMA,
    documentId: nonEmptyString(pin.documentId, "sensorAdmission.documentId"),
    revisionId: nonEmptyString(pin.revisionId, "sensorAdmission.revisionId"),
    contractSha256: normalizedSha(pin.contractSha256, "sensorAdmission.contractSha256"),
    qualificationRevision: nonEmptyString(
      pin.qualificationRevision,
      "sensorAdmission.qualificationRevision",
    ),
    agentConfigRevisionId: nonEmptyString(
      pin.agentConfigRevisionId,
      "sensorAdmission.agentConfigRevisionId",
    ),
    workspaceId: nonEmptyString(pin.workspaceId, "sensorAdmission.workspaceId"),
    baselineSha: normalizedSha(pin.baselineSha, "sensorAdmission.baselineSha"),
    completionContractId: nonEmptyString(
      pin.completionContractId,
      "sensorAdmission.completionContractId",
    ),
    completionContractSha256: normalizedSha(
      pin.completionContractSha256,
      "sensorAdmission.completionContractSha256",
    ),
    admittedAt: nonEmptyString(pin.admittedAt, "sensorAdmission.admittedAt"),
  };
}

export async function assertSensorAdmissionBeforeNativeSpawn(input: {
  db: Db;
  binding: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    executionWorkspaceId: string;
  };
  completionContract: {
    id: string;
    sha256: string;
  };
}): Promise<{ governed: boolean; pin: SensorAdmissionPin | null }> {
  return input.db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        nativeIssueId: heartbeatRuns.nativeIssueId,
        completionContractId: heartbeatRuns.completionContractId,
        completionContractSha256: heartbeatRuns.completionContractSha256,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.binding.runId),
        eq(heartbeatRuns.companyId, input.binding.companyId),
        eq(heartbeatRuns.agentId, input.binding.agentId),
      ))
      .for("update")
      .limit(1);

    if (!run || run.nativeIssueId !== input.binding.issueId) {
      throw new SensorAdmissionDeniedError(
        "binding_conflict",
        "native run binding changed before provider launch",
      );
    }
    const contextSnapshot = record(run.contextSnapshot);
    const existingPin = parseAdmissionPin(contextSnapshot[SENSOR_ADMISSION_CONTEXT_KEY]);

    let documentId: string;
    let revisionId: string;
    let body: string;

    if (existingPin) {
      const [revision] = await tx
        .select({
          documentId: issueDocuments.documentId,
          revisionId: documentRevisions.id,
          body: documentRevisions.body,
        })
        .from(issueDocuments)
        .innerJoin(
          documentRevisions,
          eq(documentRevisions.documentId, issueDocuments.documentId),
        )
        .where(and(
          eq(issueDocuments.companyId, input.binding.companyId),
          eq(issueDocuments.issueId, input.binding.issueId),
          eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
          eq(issueDocuments.documentId, existingPin.documentId),
          eq(documentRevisions.id, existingPin.revisionId),
        ))
        .limit(1);
      if (!revision) {
        throw new SensorAdmissionDeniedError(
          "binding_conflict",
          "pinned sensor admission document revision no longer exists",
        );
      }
      documentId = revision.documentId;
      revisionId = revision.revisionId;
      body = revision.body;
    } else {
      const [document] = await tx
        .select({
          documentId: issueDocuments.documentId,
          latestRevisionId: documents.latestRevisionId,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
        .where(and(
          eq(issueDocuments.companyId, input.binding.companyId),
          eq(issueDocuments.issueId, input.binding.issueId),
          eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
        ))
        .limit(1);

      if (!document) {
        return { governed: false, pin: null };
      }
      if (!document.latestRevisionId) {
        throw new SensorAdmissionDeniedError(
          "contract_invalid",
          "sensor-admission document has no revision",
        );
      }
      const [revision] = await tx
        .select({
          id: documentRevisions.id,
          body: documentRevisions.body,
        })
        .from(documentRevisions)
        .where(and(
          eq(documentRevisions.id, document.latestRevisionId),
          eq(documentRevisions.documentId, document.documentId),
          eq(documentRevisions.companyId, input.binding.companyId),
        ))
        .limit(1);
      if (!revision) {
        throw new SensorAdmissionDeniedError(
          "contract_invalid",
          "latest sensor-admission revision is missing",
        );
      }
      documentId = document.documentId;
      revisionId = revision.id;
      body = revision.body;
    }

    if (
      run.completionContractId !== input.completionContract.id ||
      run.completionContractSha256 !== input.completionContract.sha256
    ) {
      throw new SensorAdmissionDeniedError(
        "completion_contract_mismatch",
        "run completion contract binding does not match native execution input",
      );
    }

    const contract = parseSensorAdmissionDocumentBody(body);
    const contractSha256 = nativeSha256(contract);

    if (existingPin && existingPin.contractSha256 !== contractSha256) {
      throw new SensorAdmissionDeniedError(
        "binding_conflict",
        "pinned sensor admission revision hash changed",
      );
    }

    const [issue] = await tx
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        executionWorkspaceId: issues.executionWorkspaceId,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.binding.companyId),
        eq(issues.id, input.binding.issueId),
      ))
      .limit(1);
    if (!issue || issue.assigneeAgentId !== input.binding.agentId) {
      throw new SensorAdmissionDeniedError(
        "assignee_mismatch",
        "issue assignee no longer matches the executing agent",
      );
    }
    if (
      issue.executionWorkspaceId !== input.binding.executionWorkspaceId ||
      issue.executionWorkspaceId !== contract.workspace.id
    ) {
      throw new SensorAdmissionDeniedError(
        "workspace_mismatch",
        "issue, run, and sensor contract do not reference the same execution workspace",
      );
    }

    const [agent] = await tx
      .select({
        id: agents.id,
        capabilities: agents.capabilities,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
        defaultEnvironmentId: agents.defaultEnvironmentId,
      })
      .from(agents)
      .where(and(
        eq(agents.companyId, input.binding.companyId),
        eq(agents.id, input.binding.agentId),
      ))
      .limit(1);
    if (!agent) {
      throw new SensorAdmissionDeniedError(
        "qualification_missing",
        "executing agent no longer exists",
      );
    }

    const [qualificationConfig] = await tx
      .select({
        id: agentConfigRevisions.id,
        afterConfig: agentConfigRevisions.afterConfig,
      })
      .from(agentConfigRevisions)
      .where(and(
        eq(agentConfigRevisions.companyId, input.binding.companyId),
        eq(agentConfigRevisions.agentId, input.binding.agentId),
        eq(
          agentConfigRevisions.id,
          contract.workerQualification.agentConfigRevisionId,
        ),
      ))
      .limit(1);
    if (!qualificationConfig) {
      throw new SensorAdmissionDeniedError(
        "qualification_missing",
        "referenced agent configuration revision does not exist",
      );
    }

    const [workspace] = await tx
      .select({
        id: executionWorkspaces.id,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(and(
        eq(executionWorkspaces.companyId, input.binding.companyId),
        eq(executionWorkspaces.id, input.binding.executionWorkspaceId),
      ))
      .limit(1);
    const baselineSha = workspace ? readBaselineSha(workspace.metadata) : null;
    if (!baselineSha) {
      throw new SensorAdmissionDeniedError(
        "baseline_missing",
        "execution workspace has no persisted baseRefSnapshot.resolvedSha",
      );
    }

    const [completion] = await tx
      .select({
        id: completionContracts.id,
        canonicalSha256: completionContracts.canonicalSha256,
        risk: completionContracts.risk,
      })
      .from(completionContracts)
      .where(and(
        eq(completionContracts.companyId, input.binding.companyId),
        eq(completionContracts.issueId, input.binding.issueId),
        eq(completionContracts.id, input.completionContract.id),
      ))
      .limit(1);
    if (
      !completion ||
      completion.canonicalSha256 !== input.completionContract.sha256
    ) {
      throw new SensorAdmissionDeniedError(
        "completion_contract_mismatch",
        "native completion contract row does not match the execution binding",
      );
    }

    evaluateSensorAdmissionContract(contract, {
      issueId: input.binding.issueId,
      agentId: input.binding.agentId,
      workspaceId: input.binding.executionWorkspaceId,
      baselineSha,
      nativeRisk: completion.risk,
      qualificationConfigMatches:
        executionConfigFingerprintFromAgent(agent) ===
        executionConfigFingerprintFromRevision(qualificationConfig.afterConfig),
    });

    const pin: SensorAdmissionPin = existingPin ?? {
      schema: SENSOR_ADMISSION_PIN_SCHEMA,
      documentId,
      revisionId,
      contractSha256,
      qualificationRevision: contract.workerQualification.qualificationRevision,
      agentConfigRevisionId: contract.workerQualification.agentConfigRevisionId,
      workspaceId: contract.workspace.id,
      baselineSha,
      completionContractId: input.completionContract.id,
      completionContractSha256: input.completionContract.sha256,
      admittedAt: new Date().toISOString(),
    };

    if (
      existingPin &&
      (
        existingPin.documentId !== documentId ||
        existingPin.revisionId !== revisionId ||
        existingPin.qualificationRevision !== contract.workerQualification.qualificationRevision ||
        existingPin.agentConfigRevisionId !== contract.workerQualification.agentConfigRevisionId ||
        existingPin.workspaceId !== contract.workspace.id ||
        existingPin.baselineSha !== baselineSha ||
        existingPin.completionContractId !== input.completionContract.id ||
        existingPin.completionContractSha256 !== input.completionContract.sha256
      )
    ) {
      throw new SensorAdmissionDeniedError(
        "binding_conflict",
        "pinned sensor admission binding no longer matches this run",
      );
    }

    if (!existingPin) {
      await tx
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...contextSnapshot,
            [SENSOR_ADMISSION_CONTEXT_KEY]: pin,
          },
          updatedAt: new Date(),
        })
        .where(and(
          eq(heartbeatRuns.id, input.binding.runId),
          eq(heartbeatRuns.companyId, input.binding.companyId),
        ));
    }

    return { governed: true, pin };
  });
}
