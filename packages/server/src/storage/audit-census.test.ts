/**
 * This is a maintained inventory, not a claim that syntax proves atomicity.
 * Native failure controls exercise the boundaries named in audit-census.json.
 * Resolve signatures rather than receiver names: aliases such as this.jobs and
 * handles narrowed to one method are still storage calls. Any new method or
 * caller must be classified here, including provider credential boundaries.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const READS: Record<string, string> = {
  ItemStore:
    "get writersAt getMany getIncludingTrashed list listSummaries listTrashSummaries trashDetailsOf findBySourceId findByLinks findBySourceIds tombstones cascadeMarks countByType stats listInactiveAppGrants listTrashedOlderThan listExpiredFeed restoredAtOf listRevokedAppGrantsOlderThan",
  MetadataStore: "get getMany listTags getExtensions getExtensionsForItems",
  VersionStore: "list all getByVersion scanProperties listThinningCandidates",
  TypeStore:
    "list get provenance listRegistered listRegisteredWithProvenance loadAll countRegistered propertyNamesHeld",
  EdgeTypeStore: "list get",
  SearchStore: "search",
  KeyStore: "list get validate count",
  BlobRegistry:
    "get listAll readableThrough lendingHashesOf lendingHashesOfEdges lendingHashesOfExtensions uploadedBy count listStores copiesClaimedAt listCopies storeIdsOf listPendingCopyDeletions listMissingFrom countMissingFrom listToVerify listOrphans listOrphansToPurge listPendingPurges purgePending",
  WebhookStore: "checkpoint listAfter list get count",
  WebhookDeliveryStore: "list get",
  OauthProviderStore:
    "getClient listLiveGrantClients getPriorConsent validateAccessToken getAccessTokenById findAuthorizationCodeGrantKey findRefreshTokenGrantKey findGrantItemId findDeviceCodeGrantKey findDeviceCodeRequest findTokenGrantScopes",
  AuditStore: "has list",
  EventLogStore: "getAfter getNonFanoutEnd getMinRetainedId getMaxId",
  SettingsStore: "get",
  EdgeStore:
    "get listFromSource listToTarget list countsBySourceBatch countsByTargetBatch existsExactBatch findByTriple listOutboundOfType listAllByItem listFromSourcesBatched listToTargetsBatched wouldCreateCycle",
  OwnerStore: "find",
  BulkActionJobStore: "scanPendingPropertyPatches getById carriedItems",
  EnrichmentStore: "listCandidates get",
  HousekeepingStore: "listDue list get",
  ConnectorStore: "list get listRuns",
  ConnectorStateStore: "getState lookupAgreements listAgreements",
  InboundStore: "listEndpoints target backlog listDeliveries body",
  FolderStatusStore: "list isCurrent",
  RateLimitStore: "peekWindow",
};
// Storage primitives themselves can be used by several kinds of boundary. The
// caller inventory below distinguishes audited units, contained subwrites,
// existing operational exceptions and provider credential boundaries.
const WRITES: Record<string, string> = {
  ItemStore:
    "create settleTombstones update delete purge restore restoreBeneath restoreDates transition",
  MetadataStore:
    "set addTags removeTag setExtension setExtensions deleteExtension",
  VersionStore: "create restore deleteByIds",
  TypeStore: "create update delete seedPlatformTypes deleteRetiredPlatformType",
  EdgeTypeStore: "create replace delete",
  SearchStore: "index setTags remove",
  KeyStore:
    "create update revoke revokeLapsedHolders updateLastUsed deleteDeadKeysOlderThan",
  BlobRegistry:
    "register recordUploader attachStore detachStoresExcept recordCopy queueCopyDeletion beginCopyDeletionAttempt settleCopyDeletion removeCopy dropCopyKeeping markVerified retainOrphans claimOrphanPurge settlePurge",
  WebhookStore: "acknowledge create update delete",
  WebhookDeliveryStore:
    "schedule getPending reopen markSuccess markFailed markCanceled cancelPending cancelUnselected cleanup",
  OauthProviderStore:
    "widenClientScopes setConsentScopes revokeTokensBeyondScopes upsertConsent revokeTokensForGrant revokeAuthorizationCodesForGrant revokeAccessTokensForGrant mintTokenPair createClient deleteIdleGrantlessClients markClientOffered updateLastUsedAt drain narrowDeviceCodeScope deleteDeviceCodesForGrant",
  AuditStore: "log cleanup",
  EventLogStore: "append cleanup",
  IdempotencyStore: "claim takeOverExpiredClaim complete release cleanup",
  SettingsStore: "set claim release",
  EdgeStore: "createRaw updateProperties delete deleteBySource deleteByTarget",
  AuthSessionStore: "deleteExpired",
  OwnerStore: "update",
  RateLimitStore: "incrementWindow incrementWindows cleanup clearSignIn",
  BulkActionJobStore:
    "create claimNext beginChunk checkpointChunk completeOwned failOwned cancel recoverStale gcExpired",
  EnrichmentStore: "upsert delete",
  HousekeepingStore:
    "upsert removeExcept clearRunning claimDue claim finish wake",
  ConnectorStore: "register remove heartbeat recordRun takeHold releaseHold",
  ConnectorStateStore: "putState writeAgreements clear",
  InboundStore: "createEndpoint retireEndpoint receive markHandled cleanup",
  FolderStatusStore: "put",
};
const CONTROL = {
  Storage:
    "assertTransactionUsable assertInWriteTransaction runInTransaction runInReadSnapshot close",
};
function keys(groups: Record<string, string>): string[] {
  return Object.entries(groups).flatMap(([store, methods]) =>
    methods.split(" ").map((method) => `${store}.${method}`),
  );
}

it("classifies every declared method and every production mutation caller", () => {
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), (path) =>
    ts.sys.readFile(path),
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const declarations = program.getSourceFile(
    resolve(root, "src/storage/interface.ts"),
  )!;
  const methods = declarations.statements
    .filter(ts.isInterfaceDeclaration)
    .flatMap((node) =>
      node.members
        .filter(ts.isMethodSignature)
        .map((method) => `${node.name.text}.${method.name.getText()}`),
    );
  expect([...keys(READS), ...keys(WRITES), ...keys(CONTROL)].sort()).toEqual(
    methods.sort(),
  );
  const writes = new Set(keys(WRITES));
  const calls: Record<string, Record<string, number>> = {};
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(`${root}/src/`)) continue;
    const path = file.fileName.slice(`${root}/src/`.length);
    // SQLite owns primitives, derived indexes and schema bootstrap. Its callers
    // are what this census tracks; table-writer censuses cover direct SQL doors.
    if (
      path.startsWith("storage/sqlite/") ||
      path.endsWith(".test.ts") ||
      path.endsWith(".fixture.ts") ||
      path === "auth/claim-test-app.ts" ||
      path.startsWith("test-")
    )
      continue;
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        let key: string | undefined;
        if (
          declaration?.getSourceFile() === declarations &&
          ts.isMethodSignature(declaration) &&
          ts.isInterfaceDeclaration(declaration.parent)
        ) {
          const name = `${declaration.parent.name.text}.${declaration.name.getText()}`;
          if (writes.has(name)) key = name;
          if (name === "AuditStore.log") {
            expect(
              ts.isAwaitExpression(node.parent),
              `${path}: audit writes must be awaited`,
            ).toBe(true);
          }
        } else if (
          declaration &&
          ts.isFunctionDeclaration(declaration) &&
          [
            "writeItem",
            "finalizeArchiveItem",
            "runAuditedTransaction",
            "writeInstanceConfig",
          ].includes(declaration.name?.text ?? "")
        ) {
          key = declaration.name!.text;
        }
        if (key) {
          const caller = (calls[path] ??= {});
          caller[key] = (caller[key] ?? 0) + 1;
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  const inventory = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "audit-census.json"), "utf8"),
  ) as Record<string, { boundary: string; calls: Record<string, number> }>;
  for (const entry of Object.values(inventory))
    expect(entry.boundary.length).toBeGreaterThan(20);
  expect(calls).toEqual(
    Object.fromEntries(
      Object.entries(inventory).map(([path, entry]) => [path, entry.calls]),
    ),
  );
}, 30_000);
