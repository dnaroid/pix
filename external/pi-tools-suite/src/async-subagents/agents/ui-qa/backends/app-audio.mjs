export function validateAppAudioPolicy(flow) {
	if (flow.recordAppAudio === undefined) return;
	if (typeof flow.recordAppAudio !== "boolean") throw new Error("recordAppAudio must be a boolean");
	if (!flow.target?.application || flow.target.application.fixture) throw new Error("recordAppAudio is supported only for non-fixture desktop applications");
	if (flow.recordAppAudio && flow.recordWindowVideo === false) throw new Error("recordAppAudio requires window video");
}

export function appAudioEvidence(stdout, requested) {
	if (!requested) return { status: "disabled" };
	const match = /^app-audio=recorded buffers=([1-9]\d*)$/m.exec(stdout);
	if (match) return { status: "recorded", scope: "selected-application", buffers: Number(match[1]) };
	const reason = /^app-audio=unavailable reason=(.+)$/m.exec(stdout)?.[1];
	return { status: "unavailable", reason: reason ?? "helper did not confirm captured app audio" };
}
