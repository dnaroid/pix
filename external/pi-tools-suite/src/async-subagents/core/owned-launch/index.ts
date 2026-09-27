// owned-launch public surface. Candidate production macOS
// detached-descendant containment launcher; NOT yet wired into
// core/spawn.ts — integration is owned by the parent task. See README.md
// for the protocol, contracts, and claim boundaries.
export {
	OWNED_LAUNCH_LABEL_PREFIX,
	OWNED_LAUNCH_RUNS_DIRNAME,
	createSecureDir,
	ensureSecureDir,
	isValidOwnedLaunchLabel,
	listOwnedLaunchRunDirs,
	ownedLaunchLabel,
	resolveSocketsDir,
} from "./label.js";
export {
	OWNED_LAUNCH_SPEC_FILE,
	OWNED_LAUNCH_SPEC_VERSION,
	OwnedLaunchSpecError,
	serializeOwnedLaunchSpec,
	validateOwnedLaunchSpec,
	writeOwnedLaunchSpec,
	type OwnedLaunchWorkerSpec,
} from "./spec.js";
export {
	compileOwnedLaunchBinaries,
	ensureOwnedLaunchBinaries,
	ownedLaunchNativeDir,
	type OwnedLaunchBinaries,
} from "./bootstrap.js";
export {
	DEFAULT_OWNED_LAUNCH_TIMEOUTS,
	launchOwnedAgent,
	launchOwnedAgentSync,
	prepareOwnedLaunchBinaries,
	type LaunchOwnedAgentOptions,
	type OwnedLaunchExit,
	type OwnedLaunchHandle,
	type OwnedLaunchTimeouts,
} from "./launcher.js";
export { readOwnedLaunchReceipt, type OwnedLaunchReceipt } from "./receipt.js";
export {
	OWNED_LAUNCH_CANCEL_MARKER,
	OWNED_LAUNCH_CLAIM_FILE,
	OWNED_NEVER_LAUNCHED_MARKER,
	fenceOwnedLaunchRunAsync,
	readOwnedLaunchClaimSync,
	writeOwnedLaunchCancelMarker,
	type OwnedLaunchClaim,
} from "./marker.js";
