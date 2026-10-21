// Explicit, selected-target lifecycle intents. No arbitrary components/commands,
// app-data access, force-stop of another package, or system configuration.
export function validateAndroidLifecycle(step) {
	if (step.action === "appLifecycle" && !["background", "resume", "restart"].includes(step.operation)) throw new Error("invalid Android appLifecycle operation");
	if (step.action === "wait" && (!Number.isInteger(step.durationMs) || step.durationMs < 100 || step.durationMs > 20_000)) throw new Error("Android wait durationMs must be 100..20000");
}

export function resumesAndroidApp(steps) {
	return steps?.[0]?.action === "appLifecycle" && steps[0].operation === "resume";
}

export function createAndroidLifecycle(client, target, expectedBoot, context) {
	let homePackage;
	async function identity() {
		if (await client.identity() !== expectedBoot) throw new Error("Android target identity changed during lifecycle; no further command allowed");
	}
	async function resolve(category, appOnly) {
		await identity();
		const args = ["shell", "cmd", "package", "resolve-activity", "--brief", "--user", "current", "-a", "android.intent.action.MAIN", "-c", `android.intent.category.${category}`];
		if (appOnly) args.push("-p", target.package);
		const raw = (await client.command(args)).toString("utf8").trim();
		const component = raw.split(/\r?\n/).at(-1);
		const match = component?.match(/^([A-Za-z]\w*(?:\.[A-Za-z]\w*)+)\/(\.?[A-Za-z_][\w.]*)$/);
		if (!match || appOnly && match[1] !== target.package) throw new Error("Android lifecycle activity could not be resolved safely");
		return { component, package: match[1] };
	}
	async function home() {
		if (!homePackage) {
			const resolved = await resolve("HOME", false);
			if (resolved.package === target.package) throw new Error("target app is the HOME handler; background lifecycle unavailable");
			homePackage = resolved.package;
		}
		return homePackage;
	}
	async function guardBackground() {
		await identity();
		const launcher = await home();
		const focused = await client.focusedPackage();
		if (focused !== target.package && focused !== launcher) throw new Error("Android background focus is neither target app nor resolved HOME; no further command allowed");
		return focused;
	}
	async function waitForPackage(wanted) {
		do {
			const focused = await guardBackground();
			if (focused === wanted) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		} while (Date.now() < context.deadline);
		throw new Error("Android lifecycle foreground transition timed out");
	}
	async function run(operation) {
		validateAndroidLifecycle({ action: "appLifecycle", operation });
		if (target.deviceType === "physical" && operation === "restart") throw new Error("physical Android restart is not supported");
		if (operation === "background") {
			await identity();
			const launcher = await home();
			await identity();
			await client.foreground();
			await client.command(["shell", "input", "keyevent", "KEYCODE_HOME"]);
			await waitForPackage(launcher);
		} else {
			if (operation === "restart") { await identity(); await client.foreground(); }
			else await guardBackground();
			const { component } = await resolve("LAUNCHER", true);
			// Resolve/readback may take time: recheck before the only mutation.
			if (operation === "restart") { await identity(); await client.foreground(); }
			else await guardBackground();
			const args = ["shell", "am", "start", "-W", "--user", "current"];
			if (operation === "restart") args.push("-S");
			args.push("-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", component);
			const output = (await client.command(args)).toString("utf8");
			if (!/^Status: ok\s*$/m.test(output) || /^Error:|^Exception|^Status: (?!ok)/m.test(output)) throw new Error("Android lifecycle launch acknowledgement unavailable");
			await waitForPackage(target.package);
		}
	}
	return { run, guardBackground };
}
