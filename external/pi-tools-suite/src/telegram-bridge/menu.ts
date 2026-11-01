/** Only fixed informational/control commands can be invoked by menu callbacks. */
const COMMANDS = ["sessions", "status", "stop", "help"] as const;
type MenuCommand = typeof COMMANDS[number];

export interface InlineKeyboard {
	inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export function menuCommand(data: string | undefined): MenuCommand | undefined {
	return COMMANDS.find((command) => data === `pix:menu:${command}`);
}

export function menuKeyboard(inSessionTopic: boolean): InlineKeyboard {
	const button = (text: string, command: MenuCommand) => ({ text, callback_data: `pix:menu:${command}` });
	return {
		inline_keyboard: [
			[button("📂 Sessions", "sessions"), button("❔ Help", "help")],
			...(inSessionTopic ? [[button("📊 Status", "status"), button("⏹ Stop", "stop")]] : []),
		],
	};
}
