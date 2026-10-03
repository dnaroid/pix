import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Factory = (pi: ExtensionAPI) => void | Promise<void>;
export type LoadableModule = { name: string; load: () => Promise<{ default: Factory }> };
export type ModuleLoadFailure = { name: string; error: string };

/** Stage registrations, not arbitrary factory side effects (filesystem, timers, etc.). */
function createRegistrationScope(pi: ExtensionAPI) {
	let state: "loading" | "active" | "failed" = "loading";
	const pending: Array<() => void> = [];
	const assertUsable = () => {
		if (state === "failed") throw new Error("pi-tools-suite module did not initialize");
	};
	const subscribe = (target: object, method: (...args: any[]) => () => void, args: any[]) => {
		assertUsable();
		if (state === "active") return method.apply(target, args);
		let cancelled = false;
		let unsubscribe: (() => void) | undefined;
		pending.push(() => {
			if (!cancelled) unsubscribe = method.apply(target, args);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	};
	let events: ExtensionAPI["events"] | undefined;
	const wrapEvents = () => new Proxy(pi.events, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			if (key === "on") return (...args: any[]) => subscribe(target, value, args);
			return (...args: any[]) => {
				assertUsable();
				// A failed factory must not publish events to already loaded modules.
				if (state === "loading" && key === "emit") {
					pending.push(() => value.apply(target, args));
					return;
				}
				return value.apply(target, args);
			};
		},
	});
	const api = new Proxy(pi, {
		get(target, key) {
			if (key === "events") return events ??= wrapEvents();
			const value = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			if (key === "on") return (...args: any[]) => subscribe(target, value, args);
			return (...args: any[]) => {
				assertUsable();
				if (state === "loading" && typeof key === "string" && /^(?:un)?register[A-Z]/u.test(key)) {
					pending.push(() => value.apply(target, args));
					return;
				}
				return value.apply(target, args);
			};
		},
	});
	return {
		api,
		commit() {
			state = "active";
			for (const apply of pending) apply();
			pending.length = 0;
		},
		discard() {
			state = "failed";
			pending.length = 0;
		},
	};
}

export async function loadSuiteModules(pi: ExtensionAPI, modules: readonly LoadableModule[]) {
	const loaded: string[] = [];
	const failures: ModuleLoadFailure[] = [];
	for (const module of modules) {
		const scope = createRegistrationScope(pi);
		try {
			const entry = await module.load();
			if (typeof entry.default !== "function") throw new Error("Module does not export a factory function");
			await entry.default(scope.api);
		} catch (error) {
			scope.discard();
			failures.push({ name: module.name, error: error instanceof Error ? error.stack ?? error.message : String(error) });
			continue;
		}
		// SDK registration failures cannot be rolled back via the public API. Let
		// the SDK discard the whole extension rather than keep partial registrations.
		try {
			scope.commit();
		} catch (error) {
			scope.discard();
			throw new Error(`Failed to commit pi-tools-suite module ${module.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
		loaded.push(module.name);
	}
	return { loaded, failures };
}
