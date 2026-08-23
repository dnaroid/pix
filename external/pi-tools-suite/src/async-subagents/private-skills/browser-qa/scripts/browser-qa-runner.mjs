#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { strFromU8, strToU8, unzipSync, zipSync } from "../vendor/fflate.mjs";

const CONFIG_RELATIVE = ".pi/qa_auth.jsonc";
const SUBAGENT_AGENT_DIR_ENV = "PI_SUBAGENT_AGENT_DIR";
const QA_WORKSPACE_RELATIVE = "browser-qa";
const EVIDENCE_RELATIVE = "evidence";
const FORM_VIDEO_STEP_DELAY_MS = 250;
const EXIT_AUTH_UPDATE_REQUIRED = 42;
const PROFILE_ID = /^[A-Za-z0-9._-]+$/;
const AUTH_TEMPLATE = `{
  // Authenticated browser QA requires at least one project-local profile.
  // Fill and uncomment a profile below. Keep this file private.
  "profiles": {
    // "staging-user": {
    //   "description": "Staging user",
    //   "traits": ["role:user"],
    //   "baseUrl": "https://staging.example.test",
    //   "allowedOrigins": ["https://staging.example.test"],
    //   "auth": {
    //     "type": "form",
    //     "loginUrl": "https://staging.example.test/login",
    //     "fields": [
    //       { "selector": "input[name=email]", "value": "" },
    //       { "selector": "input[name=password]", "value": "" }
    //     ],
    //     "submitSelector": "button[type=submit]",
    //     "success": { "selector": "[data-testid=user-menu]" }
    //   }
    // }
  }
}
`;
process.umask(0o077);

class QaStatusError extends Error {
	constructor(status, reason, exitCode, profileId, details = {}) {
		super(reason);
		this.status = status;
		this.reason = reason;
		this.exitCode = exitCode;
		this.profileId = profileId;
		this.details = details;
	}
}

main().catch((error) => {
	const statusError = error instanceof QaStatusError
		? error
		: new QaStatusError("QA_RUN_FAILED", safeReason(error), 1);
	writeStatus({
		status: statusError.status,
		profile: statusError.profileId,
		...(statusError.status === "QA_AUTH_UPDATE_REQUIRED" ? { file: CONFIG_RELATIVE } : {}),
		reason: statusError.reason,
		...statusError.details,
	});
	process.exitCode = statusError.exitCode;
});

async function main() {
	const [command = "profiles", ...rawArgs] = process.argv.slice(2);
	const cwd = fs.realpathSync(process.cwd());
	if (command === "profiles") {
		const requireAuth = rawArgs.length === 1 && rawArgs[0] === "--require-auth";
		if (rawArgs.length > 0 && !requireAuth) {
			throw new QaStatusError("QA_RUN_FAILED", `invalid profiles argument: ${rawArgs[0]}`, 1);
		}
		const config = readAuthConfig(cwd, requireAuth);
		writeStatus({ status: "QA_PROFILES", authConfigPresent: config.present, profiles: safeProfiles(config.profiles) });
		return;
	}
	if (command !== "run") throw new QaStatusError("QA_RUN_FAILED", `unknown command: ${command}`, 1);

	const args = parseArgs(rawArgs);
	const selected = args.profile
		? selectProfile(readAuthConfig(cwd, true).profiles, args.profile)
		: createPublicProfile(args.baseUrl);
	const profileId = selected.id;
	const profile = selected.profile;
	const secrets = collectSecrets(profile.auth);
	try {
		const agentDir = resolveBrowserQaAgentDirectory(cwd, process.env[SUBAGENT_AGENT_DIR_ENV]);
		await runQa({ cwd, agentDir, args, profileId, profile });
	} catch (error) {
		if (error instanceof QaStatusError) throw error;
		throw new QaStatusError("QA_RUN_FAILED", redact(safeReason(error), secrets), 1, profileId);
	}
}

async function runQa({ cwd, agentDir, args, profileId, profile }) {
	if (!args.flow) throw new QaStatusError("QA_RUN_FAILED", "--flow is required", 1, profileId);
	const workspaceDir = path.join(agentDir, QA_WORKSPACE_RELATIVE);
	const flowPath = resolveExistingPrivateFile(workspaceDir, args.flow, "QA flow", false);
	const flow = readFlow(flowPath, profileId);
	const allowedOrigins = normalizeAllowedOrigins(profile.allowedOrigins, profileId);
	const baseURL = normalizeBaseUrl(args.baseUrl ?? profile.baseUrl ?? allowedOrigins[0], allowedOrigins, profileId);
	validateAuthConfiguration(cwd, profile.auth, allowedOrigins, profileId);
	const runId = safeRunId(args.runId ?? `${timestamp()}-${profileId}`);
	const evidenceDir = path.join(workspaceDir, EVIDENCE_RELATIVE, runId, profileId);
	createExclusivePrivateDirectory(agentDir, evidenceDir);

	const playwright = loadPlaywright(cwd);
	const browser = await playwright.chromium.launch({ headless: true });
	let context;
	let page;
	let video;
	let outcome = "passed";
	let failure;
	const runtimeSecrets = collectSecrets(profile.auth);
	const tracePath = path.join(evidenceDir, "trace.zip");
	try {
		const contextOptions = await contextOptionsForAuth({ cwd, profileId, profile, allowedOrigins });
		context = await browser.newContext({
			...contextOptions,
			baseURL,
			serviceWorkers: "block",
			recordVideo: { dir: evidenceDir, size: { width: 1280, height: 720 } },
			viewport: { width: 1280, height: 720 },
		});
		await installOriginGuard(context, allowedOrigins, profile.auth);
		await applyContextAuth(context, profile.auth, allowedOrigins, baseURL, profileId);
		page = await context.newPage();
		video = page.video();
		await applyFormAuth(page, profile.auth, allowedOrigins, profileId);
		runtimeSecrets.push(...collectStorageStateSecrets(await context.storageState()));
		await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
		await executeFlow({ page, context, baseURL, evidenceDir, flow, allowedOrigins, profileId, secrets: runtimeSecrets });
		await assertPageDoesNotExposeSecrets(page, runtimeSecrets, profileId);
		await page.screenshot({ path: path.join(evidenceDir, "final.png"), fullPage: true });
	} catch (error) {
		outcome = error instanceof QaStatusError ? error.status : "failed";
		failure = error;
		if (page && !page.isClosed() && !error.suppressEvidence) {
			try {
				await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true });
			} catch { /* best effort */ }
		}
	} finally {
		if (context) {
			try {
				runtimeSecrets.push(...collectStorageStateSecrets(await context.storageState()));
			} catch { /* best effort */ }
			try {
				await context.tracing.stop({ path: tracePath });
				sanitizeTraceArchive(tracePath, runtimeSecrets);
			} catch (error) {
				fs.rmSync(tracePath, { force: true });
				if (!failure) {
					outcome = "failed";
					failure = new Error(`trace evidence could not be sanitized: ${safeReason(error)}`);
				}
			}
			await context.close().catch(() => {});
		}
		if (video) {
			try {
				const generatedVideo = await video.path();
				if (fs.existsSync(generatedVideo)) fs.renameSync(generatedVideo, path.join(evidenceDir, "video.webm"));
			} catch { /* best effort */ }
		}
		await browser.close().catch(() => {});
	}
	if (failure?.suppressEvidence) removeVisualEvidence(evidenceDir);

	const evidence = existingEvidence(evidenceDir);
	const evidenceDetails = {
		evidenceDir: relativePath(cwd, evidenceDir),
		evidence,
		artifacts: artifactManifest(evidenceDir, evidence),
	};
	writeJsonPrivate(path.join(evidenceDir, "result.json"), {
		status: outcome,
		profile: profileId,
		...evidenceDetails,
	});
	if (failure) {
		if (failure instanceof QaStatusError) {
			failure.reason = redact(failure.reason, collectSecrets(profile.auth));
			failure.details = { ...failure.details, ...evidenceDetails };
			throw failure;
		}
		throw new QaStatusError(
			"QA_RUN_FAILED",
			redact(safeReason(failure), collectSecrets(profile.auth)),
			1,
			profileId,
			evidenceDetails,
		);
	}
	writeStatus({ status: "QA_PASSED", profile: profileId, ...evidenceDetails });
}

function readAuthConfig(cwd, required = false) {
	const candidate = path.join(cwd, CONFIG_RELATIVE);
	if (!fs.existsSync(candidate)) {
		if (!required) return { present: false, profiles: {} };
		let templateCreated;
		try {
			templateCreated = createAuthTemplate(cwd);
		} catch (error) {
			throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", safeReason(error), EXIT_AUTH_UPDATE_REQUIRED);
		}
		if (templateCreated) {
			throw new QaStatusError(
				"QA_AUTH_UPDATE_REQUIRED",
				"credentials are required; fill the generated auth config template and rerun browser QA",
				EXIT_AUTH_UPDATE_REQUIRED,
				undefined,
				{ action: "provide_credentials", templateCreated: true },
			);
		}
	}
	let file;
	try {
		file = resolveExistingPrivateFile(cwd, CONFIG_RELATIVE, "auth config");
	} catch (error) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", safeReason(error), EXIT_AUTH_UPDATE_REQUIRED);
	}
	const errors = [];
	const value = parseJsonc(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", `auth config is invalid JSONC (${printParseErrorCode(errors[0].error)})`, EXIT_AUTH_UPDATE_REQUIRED);
	}
	if (!isObject(value) || !isObject(value.profiles)) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "auth config must define a profiles object", EXIT_AUTH_UPDATE_REQUIRED);
	}
	if (required && Object.keys(value.profiles).length === 0) {
		throw new QaStatusError(
			"QA_AUTH_UPDATE_REQUIRED",
			"credentials are required; auth config must define a non-empty profiles object",
			EXIT_AUTH_UPDATE_REQUIRED,
			undefined,
			{ action: "provide_credentials", templateCreated: false },
		);
	}
	if (Object.keys(value.profiles).some((id) => !isSafeName(id))) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "auth profile ids may contain only letters, digits, dot, underscore, or dash", EXIT_AUTH_UPDATE_REQUIRED);
	}
	return { ...value, present: true };
}

function safeProfiles(profiles) {
	return Object.entries(profiles).map(([id, profile]) => ({
		id,
		description: isObject(profile) && typeof profile.description === "string" ? profile.description : undefined,
		traits: isObject(profile) && Array.isArray(profile.traits)
			? profile.traits.filter((value) => typeof value === "string")
			: [],
	}));
}

function selectProfile(profiles, requestedId) {
	if (!isSafeName(requestedId) || !isObject(profiles[requestedId])) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "requested auth profile is missing or invalid", EXIT_AUTH_UPDATE_REQUIRED, requestedId);
	}
	const profile = profiles[requestedId];
	if (!isObject(profile.auth) || typeof profile.auth.type !== "string") {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "profile auth configuration is missing or invalid", EXIT_AUTH_UPDATE_REQUIRED, requestedId);
	}
	return { id: requestedId, profile };
}

function createPublicProfile(rawBaseUrl) {
	if (typeof rawBaseUrl !== "string") {
		throw new QaStatusError("QA_RUN_FAILED", "--base-url is required when running without --profile", 1, "public");
	}
	try {
		const url = new URL(rawBaseUrl);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
		return {
			id: "public",
			profile: {
				baseUrl: url.href,
				allowedOrigins: [url.origin],
				auth: { type: "none" },
			},
		};
	} catch {
		throw new QaStatusError("QA_RUN_FAILED", "public --base-url must be an http(s) URL without embedded credentials", 1, "public");
	}
}

function normalizeAllowedOrigins(value, profileId) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "profile must define allowedOrigins", EXIT_AUTH_UPDATE_REQUIRED, profileId);
	}
	const origins = [];
	for (const raw of value) {
		try {
			const url = new URL(raw);
			if (!/^https?:$/.test(url.protocol) || url.origin !== raw.replace(/\/$/, "")) throw new Error();
			origins.push(url.origin);
		} catch {
			throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "allowedOrigins must contain exact http(s) origins", EXIT_AUTH_UPDATE_REQUIRED, profileId);
		}
	}
	return [...new Set(origins)];
}

function normalizeBaseUrl(raw, allowedOrigins, profileId) {
	try {
		const url = new URL(raw);
		if (url.username || url.password || !allowedOrigins.includes(url.origin)) throw new Error();
		return url.href;
	} catch {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "base URL is missing or not in allowedOrigins", EXIT_AUTH_UPDATE_REQUIRED, profileId);
	}
}

function validateAuthConfiguration(cwd, auth, allowedOrigins, profileId) {
	switch (auth.type) {
		case "none":
			break;
		case "cookie":
			if (!Array.isArray(auth.cookies) || auth.cookies.length === 0) throw authError(profileId, "cookie auth requires cookies");
			for (const cookie of auth.cookies) {
				if (!isObject(cookie) || typeof cookie.name !== "string" || !cookie.name || typeof cookie.value !== "string" || !cookie.value) throw authError(profileId, "cookie auth entries require non-empty name/value strings");
				if (!cookieAllowed(cookie, allowedOrigins)) throw authError(profileId, "cookie auth domain is outside allowedOrigins");
			}
			break;
		case "localStorage":
		case "sessionStorage": {
			const origin = typeof auth.origin === "string" ? auth.origin : allowedOrigins[0];
			if (!isAllowedUrl(origin, allowedOrigins) || !isObject(auth.entries)) throw authError(profileId, `${auth.type} auth is invalid`);
			const entries = Object.entries(auth.entries);
			if (entries.length === 0 || entries.some(([key, value]) => !key || typeof value !== "string" || !value)) throw authError(profileId, `${auth.type} entries must contain non-empty string keys and values`);
			break;
		}
		case "bearer":
			if (typeof auth.token !== "string" || !auth.token) throw authError(profileId, "bearer token is missing");
			if (auth.header !== undefined && (typeof auth.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(auth.header))) throw authError(profileId, "bearer header name is invalid");
			if (auth.prefix !== undefined && typeof auth.prefix !== "string") throw authError(profileId, "bearer prefix must be a string");
			break;
		case "form":
			if (typeof auth.loginUrl !== "string" || !isAllowedUrl(auth.loginUrl, allowedOrigins)) throw authError(profileId, "form loginUrl is missing or outside allowedOrigins");
			if (!Array.isArray(auth.fields) || auth.fields.length === 0 || auth.fields.some((field) => !isObject(field) || typeof field.selector !== "string" || !field.selector || typeof field.value !== "string" || !field.value)) throw authError(profileId, "form fields require non-empty selector/value strings");
			if (typeof auth.submitSelector !== "string" || !auth.submitSelector) throw authError(profileId, "form submitSelector is missing");
			if (!isObject(auth.success) || (typeof auth.success.url !== "string" && typeof auth.success.selector !== "string")) throw authError(profileId, "form success.url or success.selector is required");
			break;
		case "storageState":
			if (typeof auth.path !== "string") throw authError(profileId, "storageState path is missing");
			try { resolveExistingPrivateFile(cwd, auth.path, "storageState"); } catch (error) { throw authError(profileId, safeReason(error)); }
			break;
		default: throw authError(profileId, `unsupported auth type: ${auth.type}`);
	}
}

function readFlow(flowPath, profileId) {
	const stat = fs.statSync(flowPath);
	if (!stat.isFile() || stat.size > 256 * 1024) throw new QaStatusError("QA_RUN_FAILED", "QA flow must be a regular JSONC file no larger than 256 KiB", 1, profileId);
	const errors = [];
	const flow = parseJsonc(fs.readFileSync(flowPath, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0 || !isObject(flow) || !Array.isArray(flow.steps) || flow.steps.length === 0 || flow.steps.length > 100) {
		throw new QaStatusError("QA_RUN_FAILED", "QA flow must define between 1 and 100 valid steps", 1, profileId);
	}
	return flow;
}

async function executeFlow({ page, baseURL, evidenceDir, flow, allowedOrigins, profileId, secrets }) {
	const timeout = Math.min(finitePositive(flow.timeoutMs) ?? 15_000, 60_000);
	page.setDefaultTimeout(timeout);
	page.setDefaultNavigationTimeout(timeout);
	for (let index = 0; index < flow.steps.length; index += 1) {
		const step = flow.steps[index];
		if (!isObject(step) || typeof step.action !== "string") throw flowError(profileId, index, "action is missing");
		const locator = step.locator === undefined ? undefined : resolveLocator(page, step.locator, profileId, index);
		switch (step.action) {
			case "goto": {
				const target = typeof step.url === "string" ? step.url : step.path;
				if (typeof target !== "string") throw flowError(profileId, index, "goto requires url or path");
				const url = new URL(target, baseURL);
				if (url.username || url.password || !allowedOrigins.includes(url.origin)) throw flowError(profileId, index, "goto target is outside allowedOrigins");
				await page.goto(url.href, { waitUntil: validWaitUntil(step.waitUntil) });
				break;
			}
			case "reload": await page.reload({ waitUntil: validWaitUntil(step.waitUntil) }); break;
			case "click": await requireLocator(locator, profileId, index).click(); break;
			case "doubleClick": await requireLocator(locator, profileId, index).dblclick(); break;
			case "hover": await requireLocator(locator, profileId, index).hover(); break;
			case "fill":
				if (typeof step.value !== "string") throw flowError(profileId, index, "fill requires a string value");
				await requireLocator(locator, profileId, index).fill(step.value);
				break;
			case "press":
				if (typeof step.key !== "string" || step.key.length > 80) throw flowError(profileId, index, "press requires a valid key");
				await requireLocator(locator, profileId, index).press(step.key);
				break;
			case "check": await requireLocator(locator, profileId, index).check(); break;
			case "uncheck": await requireLocator(locator, profileId, index).uncheck(); break;
			case "selectOption":
				if (typeof step.value !== "string" && !isStringArray(step.value)) throw flowError(profileId, index, "selectOption requires a string or string array");
				await requireLocator(locator, profileId, index).selectOption(step.value);
				break;
			case "waitFor": await requireLocator(locator, profileId, index).waitFor({ state: validLocatorState(step.state) }); break;
			case "waitForTimeout":
				if (!finitePositive(step.timeoutMs) || step.timeoutMs > 5_000) throw flowError(profileId, index, "waitForTimeout must be between 1 and 5000 ms");
				await page.waitForTimeout(step.timeoutMs);
				break;
			case "assertVisible": assertCondition(await requireLocator(locator, profileId, index).isVisible(), profileId, index, "expected locator to be visible"); break;
			case "assertHidden": assertCondition(await requireLocator(locator, profileId, index).isHidden(), profileId, index, "expected locator to be hidden"); break;
			case "assertEnabled": assertCondition(await requireLocator(locator, profileId, index).isEnabled(), profileId, index, "expected locator to be enabled"); break;
			case "assertDisabled": assertCondition(await requireLocator(locator, profileId, index).isDisabled(), profileId, index, "expected locator to be disabled"); break;
			case "assertChecked": assertCondition(await requireLocator(locator, profileId, index).isChecked(), profileId, index, "expected locator to be checked"); break;
			case "assertUnchecked": assertCondition(!(await requireLocator(locator, profileId, index).isChecked()), profileId, index, "expected locator to be unchecked"); break;
			case "assertText": {
				const actual = (await requireLocator(locator, profileId, index).textContent()) ?? "";
				assertExpectedString(actual, step, profileId, index, "text");
				break;
			}
			case "assertValue": {
				const actual = await requireLocator(locator, profileId, index).inputValue();
				assertExpectedString(actual, step, profileId, index, "value");
				break;
			}
			case "assertCount":
				if (!Number.isInteger(step.equals) || step.equals < 0) throw flowError(profileId, index, "assertCount requires a non-negative integer equals");
				assertCondition((await requireLocator(locator, profileId, index).count()) === step.equals, profileId, index, "locator count assertion failed");
				break;
			case "assertURL": assertExpectedString(page.url(), step, profileId, index, "URL"); break;
			case "authRejectedIf": {
				const urlRejected = typeof step.urlIncludes === "string" && page.url().includes(step.urlIncludes);
				const locatorRejected = locator ? await locator.isVisible().catch(() => false) : false;
				if (!urlRejected && !locatorRejected) break;
				throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "application rejected or expired the configured authentication", EXIT_AUTH_UPDATE_REQUIRED, profileId);
			}
			case "screenshot": {
				const name = typeof step.name === "string" ? step.name : `step-${index + 1}`;
				if (!isSafeName(name)) throw flowError(profileId, index, "screenshot name is invalid");
				await assertPageDoesNotExposeSecrets(page, secrets, profileId);
				await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: step.fullPage !== false });
				break;
			}
			default: throw flowError(profileId, index, `unsupported action: ${step.action}`);
		}
		await assertPageDoesNotExposeSecrets(page, secrets, profileId);
	}
}

function resolveLocator(page, value, profileId, index) {
	if (!isObject(value)) throw flowError(profileId, index, "locator must be an object");
	const exact = value.exact === true;
	if (typeof value.testId === "string") return page.getByTestId(value.testId);
	if (typeof value.role === "string") return page.getByRole(value.role, typeof value.name === "string" ? { name: value.name, exact } : undefined);
	if (typeof value.label === "string") return page.getByLabel(value.label, { exact });
	if (typeof value.placeholder === "string") return page.getByPlaceholder(value.placeholder, { exact });
	if (typeof value.text === "string") return page.getByText(value.text, { exact });
	if (typeof value.css === "string") return page.locator(value.css);
	throw flowError(profileId, index, "locator requires testId, role, label, placeholder, text, or css");
}

function requireLocator(locator, profileId, index) {
	if (!locator) throw flowError(profileId, index, "action requires locator");
	return locator;
}

function assertExpectedString(actual, step, profileId, index, label) {
	const hasEquals = typeof step.equals === "string";
	const hasIncludes = typeof step.includes === "string";
	if (hasEquals === hasIncludes) throw flowError(profileId, index, `${label} assertion requires exactly one of equals or includes`);
	assertCondition(hasEquals ? actual === step.equals : actual.includes(step.includes), profileId, index, `${label} assertion failed`);
}

function assertCondition(condition, profileId, index, reason) {
	if (!condition) throw flowError(profileId, index, reason);
}

function flowError(profileId, index, reason) {
	return new QaStatusError("QA_RUN_FAILED", `flow step ${index + 1}: ${reason}`, 1, profileId);
}

function validWaitUntil(value) {
	return ["commit", "domcontentloaded", "load", "networkidle"].includes(value) ? value : "load";
}

function validLocatorState(value) {
	return ["attached", "detached", "visible", "hidden"].includes(value) ? value : "visible";
}

function isStringArray(value) {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

async function contextOptionsForAuth({ cwd, profileId, profile, allowedOrigins }) {
	const auth = profile.auth;
	if (auth.type === "none") return {};
	if (auth.type === "storageState") {
		if (typeof auth.path !== "string") throw authError(profileId, "storageState path is missing");
		const statePath = resolveExistingPrivateFile(cwd, auth.path, "storageState");
		return { storageState: filteredStorageState(statePath, allowedOrigins, profileId) };
	}
	if (auth.type === "form") {
		return {};
	}
	if (!["cookie", "localStorage", "sessionStorage", "bearer"].includes(auth.type)) {
		throw authError(profileId, `unsupported auth type: ${auth.type}`);
	}
	return {};
}

async function applyFormAuth(page, auth, allowedOrigins, profileId) {
	if (auth.type !== "form") return;
	if (typeof auth.loginUrl !== "string" || !isAllowedUrl(auth.loginUrl, allowedOrigins)) {
		throw authError(profileId, "form loginUrl is missing or outside allowedOrigins");
	}
	if (!Array.isArray(auth.fields) || auth.fields.length === 0 || typeof auth.submitSelector !== "string") {
		throw authError(profileId, "form fields or submitSelector are missing");
	}
	try {
		const timeout = Math.min(finitePositive(auth.timeoutMs) ?? 15_000, 60_000);
		page.setDefaultTimeout(timeout);
		page.setDefaultNavigationTimeout(timeout);
		await page.goto(auth.loginUrl, { timeout });
		await page.waitForTimeout(FORM_VIDEO_STEP_DELAY_MS);
		for (const field of auth.fields) {
			if (!isObject(field) || typeof field.selector !== "string" || typeof field.value !== "string") {
				throw authError(profileId, "form fields must contain selector/value strings");
			}
			await page.locator(field.selector).fill(field.value);
			await page.waitForTimeout(FORM_VIDEO_STEP_DELAY_MS);
		}
		await page.locator(auth.submitSelector).click();
		if (isObject(auth.success) && typeof auth.success.url === "string") await page.waitForURL(auth.success.url, { timeout });
		if (isObject(auth.success) && typeof auth.success.selector === "string") await page.locator(auth.success.selector).waitFor({ timeout });
		if (!isObject(auth.success) || (typeof auth.success.url !== "string" && typeof auth.success.selector !== "string")) {
			throw authError(profileId, "form success.url or success.selector is required");
		}
	} catch (error) {
		if (error instanceof QaStatusError) throw error;
		throw authError(profileId, "form login was rejected or did not reach the configured success condition");
	}
}

async function applyContextAuth(context, auth, allowedOrigins, baseURL, profileId) {
	if (auth.type === "cookie") {
		if (!Array.isArray(auth.cookies) || auth.cookies.length === 0) throw authError(profileId, "cookie auth requires cookies");
		for (const cookie of auth.cookies) {
			if (!isObject(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw authError(profileId, "invalid cookie auth entry");
			if (!cookieAllowed(cookie, allowedOrigins)) throw authError(profileId, "cookie auth domain is outside allowedOrigins");
		}
		await context.addCookies(auth.cookies);
	}
	if (auth.type === "localStorage" || auth.type === "sessionStorage") {
		const originUrl = typeof auth.origin === "string" ? auth.origin : baseURL;
		if (!isAllowedUrl(originUrl, allowedOrigins) || !isObject(auth.entries)) throw authError(profileId, `${auth.type} auth is invalid`);
		const origin = new URL(originUrl).origin;
		const storage = auth.type;
		const entries = Object.entries(auth.entries);
		if (entries.length === 0 || entries.some(([, value]) => typeof value !== "string")) throw authError(profileId, `${auth.type} entries must be non-empty strings`);
		await context.addInitScript(({ expectedOrigin, storageName, values }) => {
			if (location.origin !== expectedOrigin) return;
			const target = storageName === "localStorage" ? localStorage : sessionStorage;
			for (const [key, value] of values) target.setItem(key, value);
		}, { expectedOrigin: origin, storageName: storage, values: entries });
	}
}

async function installOriginGuard(context, allowedOrigins, auth) {
	await context.route("**/*", async (route) => {
		const request = route.request();
		let url;
		try { url = new URL(request.url()); } catch {
			await route.abort("blockedbyclient");
			return;
		}
		if (!isAllowedNetworkUrl(url, allowedOrigins)) {
			await route.abort("blockedbyclient");
			return;
		}
		if (auth.type === "bearer") {
			const headerName = typeof auth.header === "string" && auth.header ? auth.header : "Authorization";
			const prefix = typeof auth.prefix === "string" ? auth.prefix : "Bearer ";
			const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => name.toLowerCase() !== headerName.toLowerCase()));
			await route.continue({ headers: { ...headers, [headerName]: `${prefix}${auth.token}` } });
			return;
		}
		await route.continue();
	});
	if (typeof context.routeWebSocket !== "function") throw new Error("installed Playwright does not support fail-closed WebSocket routing");
	await context.routeWebSocket("**/*", async (webSocket) => {
		let allowed = false;
		try { allowed = isAllowedNetworkUrl(new URL(webSocket.url()), allowedOrigins); } catch { /* blocked */ }
		if (!allowed) {
			await webSocket.close({ code: 1008, reason: "origin blocked by browser QA" });
			return;
		}
		webSocket.connectToServer();
	});
}

function isAllowedNetworkUrl(url, allowedOrigins) {
	if (allowedOrigins.includes(url.origin)) return true;
	if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
	const httpProtocol = url.protocol === "wss:" ? "https:" : "http:";
	return allowedOrigins.includes(`${httpProtocol}//${url.host}`);
}

function filteredStorageState(statePath, allowedOrigins, profileId) {
	let state;
	try {
		state = JSON.parse(fs.readFileSync(statePath, "utf8"));
	} catch {
		throw authError(profileId, "storageState is unreadable or invalid");
	}
	return {
		cookies: Array.isArray(state.cookies) ? state.cookies.filter((cookie) => cookieAllowed(cookie, allowedOrigins)) : [],
		origins: Array.isArray(state.origins) ? state.origins.filter((entry) => isObject(entry) && allowedOrigins.includes(entry.origin)) : [],
	};
}

function cookieAllowed(cookie, allowedOrigins) {
	if (!isObject(cookie)) return false;
	if (typeof cookie.url === "string") return isAllowedUrl(cookie.url, allowedOrigins);
	if (typeof cookie.domain !== "string") return false;
	const domain = cookie.domain.replace(/^\./, "").toLowerCase();
	return allowedOrigins.some((origin) => new URL(origin).hostname.toLowerCase() === domain);
}

function loadPlaywright(cwd) {
	const requireCandidates = [createRequire(path.join(cwd, "package.json")), createRequire(import.meta.url)];
	const cliPath = findExecutable("playwright-cli");
	if (cliPath) requireCandidates.push(createRequire(findPackageJson(fs.realpathSync(cliPath))));
	for (const require of requireCandidates) {
		for (const name of ["playwright", "@playwright/test"]) {
			try {
				const module = require(name);
				if (module.chromium) return module;
			} catch { /* try next resolution root */ }
		}
	}
	throw new Error("Playwright is unavailable; install project playwright or @playwright/cli");
}

function findExecutable(name) {
	const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		for (const candidate of names) {
			const file = path.join(directory, candidate);
			if (fs.existsSync(file)) return file;
		}
	}
}

function findPackageJson(startFile) {
	let directory = path.dirname(startFile);
	while (directory !== path.dirname(directory)) {
		const candidate = path.join(directory, "package.json");
		if (fs.existsSync(candidate)) return candidate;
		directory = path.dirname(directory);
	}
	return new URL(import.meta.url);
}

function parseArgs(values) {
	const result = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		const value = values[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new QaStatusError("QA_RUN_FAILED", `invalid argument: ${flag ?? "(missing)"}`, 1);
		const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (!["profile", "flow", "baseUrl", "runId"].includes(key)) throw new QaStatusError("QA_RUN_FAILED", `unknown option: ${flag}`, 1);
		result[key] = value;
	}
	return result;
}

function collectSecrets(value, output = []) {
	if (!isObject(value)) return output;
	if (typeof value.token === "string" && value.token.length > 0) output.push(value.token);
	if (Array.isArray(value.fields)) {
		for (const field of value.fields) {
			if (isObject(field) && typeof field.value === "string" && field.value.length > 0) output.push(field.value);
		}
	}
	if (Array.isArray(value.cookies)) {
		for (const cookie of value.cookies) {
			if (isObject(cookie) && typeof cookie.value === "string" && cookie.value.length > 0) output.push(cookie.value);
		}
	}
	if (isObject(value.entries)) {
		for (const entry of Object.values(value.entries)) {
			if (typeof entry === "string" && entry.length > 0) output.push(entry);
		}
	}
	return expandSecretForms(output);
}

function collectStorageStateSecrets(state) {
	const output = [];
	if (isObject(state) && Array.isArray(state.cookies)) {
		for (const cookie of state.cookies) {
			if (isObject(cookie) && typeof cookie.value === "string" && cookie.value.length > 0) output.push(cookie.value);
		}
	}
	if (isObject(state) && Array.isArray(state.origins)) {
		for (const origin of state.origins) {
			if (!isObject(origin) || !Array.isArray(origin.localStorage)) continue;
			for (const entry of origin.localStorage) {
				if (isObject(entry) && typeof entry.value === "string" && entry.value.length > 0) output.push(entry.value);
			}
		}
	}
	return expandSecretForms(output);
}

function expandSecretForms(values) {
	const forms = new Set();
	for (const value of values) {
		if (typeof value !== "string" || value.length === 0) continue;
		forms.add(value);
		forms.add(encodeURIComponent(value));
		forms.add(Buffer.from(value, "utf8").toString("base64"));
		forms.add(Buffer.from(value, "utf8").toString("base64url"));
	}
	return [...forms].filter(Boolean).sort((left, right) => right.length - left.length);
}

async function assertPageDoesNotExposeSecrets(page, secrets, profileId) {
	if (!page || page.isClosed() || secrets.length === 0) return;
	const haystacks = [page.url(), await page.content()];
	if (!secrets.some((secret) => secret && haystacks.some((value) => value.includes(secret)))) return;
	const error = new QaStatusError("QA_RUN_FAILED", "configured authentication appeared in rendered page content; visual evidence was discarded", 1, profileId);
	error.suppressEvidence = true;
	throw error;
}

function sanitizeTraceArchive(tracePath, secrets) {
	const archive = unzipSync(new Uint8Array(fs.readFileSync(tracePath)));
	const sanitized = {};
	for (const [name, bytes] of Object.entries(archive)) {
		if (name.endsWith(".network")) continue;
		if (name.startsWith("resources/") && !isImage(bytes)) continue;
		if (isImage(bytes)) {
			sanitized[name] = bytes;
			continue;
		}
		let text = strFromU8(bytes);
		for (const secret of [...new Set(secrets)].filter(Boolean)) {
			text = text.split(secret).join("[REDACTED]");
		}
		sanitized[name] = strToU8(text);
	}
	if (Object.keys(sanitized).length === 0) throw new Error("trace archive contained no safe entries");
	for (const bytes of Object.values(sanitized)) {
		if (isImage(bytes)) continue;
		const text = strFromU8(bytes);
		for (const secret of secrets) {
			if (secret && text.includes(secret)) throw new Error("trace redaction verification failed");
		}
	}
	fs.writeFileSync(tracePath, zipSync(sanitized, { level: 6 }), { mode: 0o600 });
	fs.chmodSync(tracePath, 0o600);
}

function isImage(bytes) {
	return (
		(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		|| (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		|| (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
		|| (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
	);
}

function redact(value, secrets) {
	let output = String(value).replace(/[\r\n]+/g, " ").slice(0, 500);
	for (const secret of secrets) if (secret) output = output.split(secret).join("[REDACTED]");
	return output;
}

function safeReason(error) {
	return error instanceof Error ? error.message : String(error);
}

function authError(profileId, reason) {
	return new QaStatusError("QA_AUTH_UPDATE_REQUIRED", reason, EXIT_AUTH_UPDATE_REQUIRED, profileId);
}

function isAllowedUrl(raw, allowedOrigins) {
	try {
		const url = new URL(raw);
		return !url.username && !url.password && allowedOrigins.includes(url.origin);
	} catch {
		return false;
	}
}

function resolveBrowserQaAgentDirectory(cwd, value) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${SUBAGENT_AGENT_DIR_ENV} is required for browser QA runs`);
	}
	const projectRoot = fs.realpathSync(cwd);
	const subagentRoot = path.join(projectRoot, ".pi", "subagents");
	const resolved = path.resolve(value);
	if (!fs.existsSync(resolved)) throw new Error("browser QA agent directory is missing");
	const real = fs.realpathSync(resolved);
	if (!isInside(subagentRoot, real)) throw new Error("browser QA agent directory must be inside .pi/subagents");
	assertNoSymlinkComponents(projectRoot, real, "browser QA agent directory");
	if (!fs.statSync(real).isDirectory()) throw new Error("browser QA agent directory must be a real directory");

	const promptFile = path.join(real, "prompt.md");
	const projectFile = path.join(real, "project_cwd");
	const typeFile = path.join(real, "subagent_type");
	for (const [file, label] of [[promptFile, "prompt"], [projectFile, "project metadata"], [typeFile, "type metadata"]]) {
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`browser QA ${label} is missing`);
		assertNoSymlinkComponents(real, file, `browser QA ${label}`);
	}
	const recordedProject = fs.readFileSync(projectFile, "utf8").trim();
	if (!recordedProject || fs.realpathSync(recordedProject) !== projectRoot) {
		throw new Error("browser QA agent directory belongs to another project");
	}
	if (fs.readFileSync(typeFile, "utf8").trim() !== "browser-qa") {
		throw new Error("browser QA runner requires a browser-qa sub-agent directory");
	}

	const workspace = path.join(real, QA_WORKSPACE_RELATIVE);
	if (!fs.existsSync(workspace)) throw new Error("browser QA workspace is missing");
	assertNoSymlinkComponents(real, workspace, "browser QA workspace");
	const workspaceStat = fs.statSync(workspace);
	if (!workspaceStat.isDirectory()) throw new Error("browser QA workspace must be a real directory");
	if (process.platform !== "win32" && (workspaceStat.mode & 0o077) !== 0) {
		throw new Error("browser QA workspace must use private directory permissions (0700)");
	}
	return real;
}

function resolveExistingPrivateFile(cwd, value, label, requirePrivate = true) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} path is missing`);
	const root = fs.realpathSync(cwd);
	const resolved = path.resolve(root, value);
	assertInside(root, resolved, label);
	if (!fs.existsSync(resolved)) throw new Error(`${label} is missing`);
	assertNoSymlinkComponents(root, resolved, label);
	const real = fs.realpathSync(resolved);
	assertInside(root, real, label);
	const stat = fs.statSync(real);
	if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
	if (requirePrivate && process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`${label} must use private file permissions (0600)`);
	return real;
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertInside(root, target, label) {
	if (isInside(root, target)) return;
	throw new Error(`${label} must be project-local`);
}

function assertNoSymlinkComponents(root, target, label) {
	let current = root;
	for (const part of path.relative(root, target).split(path.sep)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} must not use symbolic links`);
	}

}

function createAuthTemplate(cwd) {
	const root = fs.realpathSync(cwd);
	const directory = path.join(root, path.dirname(CONFIG_RELATIVE));
	const file = path.join(root, CONFIG_RELATIVE);
	assertInside(root, directory, "auth config directory");
	if (!fs.existsSync(directory)) {
		try {
			fs.mkdirSync(directory, { mode: 0o700 });
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
		}
	}
	const directoryStat = fs.lstatSync(directory);
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new Error("auth config directory must be a real project-local directory");
	}
	try {
		fs.writeFileSync(file, AUTH_TEMPLATE, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (isAlreadyExistsError(error)) return false;
		throw error;
	}
	fs.chmodSync(file, 0o600);
	return true;
}

function isAlreadyExistsError(error) {
	return error !== null && typeof error === "object" && error.code === "EEXIST";
}

function createExclusivePrivateDirectory(cwd, target) {
	createPrivateDirectory(cwd, target, true);
}

function createPrivateDirectory(cwd, target, exclusive) {
	const root = fs.realpathSync(cwd);
	const resolved = path.resolve(target);
	assertInside(root, resolved, "evidence directory");
	const parts = path.relative(root, resolved).split(path.sep);
	let current = root;
	for (let index = 0; index < parts.length; index += 1) {
		current = path.join(current, parts[index]);
		const isFinal = index === parts.length - 1;
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("evidence path must contain only real directories");
			if (isFinal && exclusive) throw new Error("evidence directory already exists");
			if (index > 0 && process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("QA private directories must use mode 0700");
		} else {
			fs.mkdirSync(current, { mode: 0o700 });
		}
	}
}

function safeRunId(value) {
	if (!isSafeName(value)) throw new Error("run id must contain only letters, digits, dot, underscore, or dash without dot segments");
	return value;
}

function isSafeName(value) {
	return typeof value === "string" && PROFILE_ID.test(value) && value !== "." && !value.includes("..");
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function relativePath(cwd, value) {
	return (path.relative(cwd, value) || ".").split(path.sep).join("/");
}

function existingEvidence(evidenceDir) {
	return fs.readdirSync(evidenceDir)
		.filter((name) => /^(?:[A-Za-z0-9._-]+\.png|video\.webm|trace\.zip)$/.test(name))
		.sort();
}

function artifactManifest(evidenceDir, evidence) {
	const artifacts = { screenshots: [], videos: [], traces: [] };
	for (const name of evidence) {
		const absolutePath = path.resolve(evidenceDir, name);
		const artifact = { path: absolutePath, uri: pathToFileURL(absolutePath).href };
		if (name.endsWith(".png")) artifacts.screenshots.push(artifact);
		else if (name.endsWith(".webm")) artifacts.videos.push(artifact);
		else if (name.endsWith(".zip")) artifacts.traces.push(artifact);
	}
	return artifacts;
}

function removeVisualEvidence(evidenceDir) {
	for (const name of fs.readdirSync(evidenceDir)) {
		if (/\.(?:png|webm|zip)$/.test(name)) fs.rmSync(path.join(evidenceDir, name), { force: true });
	}
}

function writeJsonPrivate(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	fs.chmodSync(file, 0o600);
}

function writeStatus(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finitePositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
