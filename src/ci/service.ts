import type { CIAllowlist } from "./policy.js";
import type { ApprovalTokenService } from "./approval.js";
import type { CIProvider } from "../providers/ci-provider.js";
import type { CIProviderRegistry } from "../providers/ci-provider-registry.js";
import type { CIProviderName } from "../domain/ci-provider-contracts.js";

export type CIProviderType = "github" | "jenkins" | "bitbucket";

export interface CIProviderRuntimeMetadata {
  readonly name: CIProviderName;
  readonly type: CIProviderType;
  readonly capabilities: {
    readonly read: boolean;
    readonly rerun: boolean;
  };
  readonly approvalRequired: boolean;
}

export interface CIService {
  readonly provider: CIProvider;
  readonly policy: CIAllowlist;
  readonly approval?: ApprovalTokenService;
  /** Optional registry used by loaded runtimes as the capability source of truth. */
  readonly providerRegistry?: CIProviderRegistry;
  /** Runtime-owned identity and capability declaration; absent means fail closed. */
  readonly runtimeMetadata?: CIProviderRuntimeMetadata;
}
