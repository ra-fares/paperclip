import type { Db } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";

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

export function record(value: unknown): Record<string, unknown> {
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

export function readBaselineSha(metadata: unknown): string | null {
  const snapshot = record(record(metadata).baseRefSnapshot);
  return typeof snapshot.resolvedSha === "string" && /^[a-f0-9]{40,64}$/i.test(snapshot.resolvedSha.trim())
    ? snapshot.resolvedSha.trim().toLowerCase()
    : null;
}

export function executionConfigFingerprintFromAgent(agent: {
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

export function executionConfigFingerprintFromRevision(afterConfig: unknown) {
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

export function parseAdmissionPin(value: unknown): SensorAdmissionPin | null {
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


/** The semantic check accepts only bindings read/locked by the caller under tx.
 * Neither this function nor its dependencies start a transaction or grant
 * provider dispatch rights. Native's existing run-first transaction remains
 * owned by assertSensorAdmissionBeforeNativeSpawn. */
export type TrustedSensorAdmissionBindings = {
  issueId: string;
  agentId: string;
  documentId: string;
  revisionId: string;
  documentBody: string;
  workspaceId: string;
  baselineSha: string;
  completionContractId: string;
  completionContractSha256: string;
  completionRisk: string;
  qualificationConfigMatches: boolean;
};
export async function verifySensorAdmissionInTx(
  tx: Db,
  verified: TrustedSensorAdmissionBindings,
  options: { mode: "native" | "direct"; sourceLockPolicy: "native-existing" | "direct-locked" },
): Promise<{ contract: SensorAdmissionContract; pin: SensorAdmissionPin }> {
  // This is intentionally transaction-scoped but does not own tx lifecycle.
  // TrustedSensorAdmissionBindings must be sourced in the caller's transaction;
  // no caller-constructed document, workspace or configuration may be passed.
  if (
    (options.mode === "native" && options.sourceLockPolicy !== "native-existing") ||
    (options.mode === "direct" && options.sourceLockPolicy !== "direct-locked")
  ) {
    throw new SensorAdmissionDeniedError("binding_conflict", "invalid Sensor admission transaction mode");
  }
  void tx;
  const contract = parseSensorAdmissionDocumentBody(verified.documentBody);
  evaluateSensorAdmissionContract(contract, {
    issueId: verified.issueId,
    agentId: verified.agentId,
    workspaceId: verified.workspaceId,
    baselineSha: verified.baselineSha,
    nativeRisk: verified.completionRisk,
    qualificationConfigMatches: verified.qualificationConfigMatches,
  });
  return {
    contract,
    pin: {
      schema: SENSOR_ADMISSION_PIN_SCHEMA,
      documentId: verified.documentId,
      revisionId: verified.revisionId,
      contractSha256: nativeSha256(contract),
      qualificationRevision: contract.workerQualification.qualificationRevision,
      agentConfigRevisionId: contract.workerQualification.agentConfigRevisionId,
      workspaceId: verified.workspaceId,
      baselineSha: verified.baselineSha,
      completionContractId: verified.completionContractId,
      completionContractSha256: verified.completionContractSha256,
      admittedAt: new Date().toISOString(),
    },
  };
}
