/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { ExtensionDialogFrame, type ExtensionDialogMaxHeight } from "./extension-dialog-frame.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	maxHeight?: ExtensionDialogMaxHeight;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		const hint = new Text(
			rawKeyHint("↑↓", "navigate") +
				"  " +
				keyHint("tui.select.confirm", "select") +
				"  " +
				keyHint("tui.select.cancel", "cancel"),
			1,
			0,
		);
		this.addChild(
			new ExtensionDialogFrame(this.titleText, this.listContainer, hint, {
				maxHeight: opts?.maxHeight,
				clippedTitleText: "[increase terminal height to see remaining dialog text]",
				renderBody: (width, maxRows) => this.renderVisibleOptions(width, maxRows),
			}),
		);

		this.updateList();
	}

	private renderVisibleOptions(width: number, maxRows: number): string[] {
		if (maxRows <= 0) return [];

		// Render options as per-option groups, not flattened rows. Wrapped options can
		// span multiple rows, while selectedIndex is an option index.
		const optionGroups = this.listContainer.children.map((child) => child.render(width));
		const optionRows = maxRows;
		let firstOption = this.selectedIndex;
		let lastOption = this.selectedIndex + 1;
		let visibleOptionRows = optionGroups[this.selectedIndex]?.length ?? 0;
		while (lastOption < optionGroups.length && visibleOptionRows + optionGroups[lastOption]!.length <= optionRows) {
			visibleOptionRows += optionGroups[lastOption]!.length;
			lastOption++;
		}
		while (firstOption > 0 && visibleOptionRows + optionGroups[firstOption - 1]!.length <= optionRows) {
			firstOption--;
			visibleOptionRows += optionGroups[firstOption]!.length;
		}
		return optionGroups.slice(firstOption, lastOption).flat().slice(0, optionRows);
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
