/**
 * Shared frame and clipping logic for extension dialogs.
 */

import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type ExtensionDialogMaxHeight = (width: number) => number;

export interface ExtensionDialogFrameOptions {
	maxHeight?: ExtensionDialogMaxHeight;
	clippedTitleText: string;
	renderBody?: (width: number, maxRows: number) => string[];
}

export class ExtensionDialogFrame extends Container {
	private readonly title: Text;
	private readonly body: Component;
	private readonly hint: Text;
	private readonly topBorder = new DynamicBorder();
	private readonly bottomBorder = new DynamicBorder();
	private readonly maxHeight: ExtensionDialogMaxHeight | undefined;
	private readonly clippedTitleText: string;
	private readonly renderBodyOverride: ((width: number, maxRows: number) => string[]) | undefined;

	constructor(title: Text, body: Component, hint: Text, options: ExtensionDialogFrameOptions) {
		super();
		this.title = title;
		this.body = body;
		this.hint = hint;
		this.maxHeight = options.maxHeight;
		this.clippedTitleText = options.clippedTitleText;
		this.renderBodyOverride = options.renderBody;

		this.addChild(this.topBorder);
		this.addChild(new Spacer(1));
		this.addChild(this.title);
		this.addChild(new Spacer(1));
		this.addChild(this.body);
		this.addChild(new Spacer(1));
		this.addChild(this.hint);
		this.addChild(new Spacer(1));
		this.addChild(this.bottomBorder);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const maxHeight = this.maxHeight?.(width);
		if (maxHeight === undefined || lines.length <= maxHeight) return lines;

		const maxRows = Math.max(1, Math.floor(maxHeight));
		const topBorder = this.topBorder.render(width);
		const bottomBorder = this.bottomBorder.render(width);
		const hintLines = this.hint.render(width);
		const bodyBudget = Math.max(0, maxRows - topBorder.length - bottomBorder.length - hintLines.length);
		const bodyLines = this.renderBodyOverride
			? this.renderBodyOverride(width, bodyBudget)
			: this.body.render(width).slice(0, bodyBudget);
		const titleRows = Math.max(
			0,
			maxRows - topBorder.length - bottomBorder.length - bodyLines.length - hintLines.length,
		);

		return [
			...topBorder,
			...this.renderClippedTitle(width, titleRows),
			...bodyLines,
			...hintLines,
			...bottomBorder,
		].slice(0, maxRows);
	}

	private renderClippedTitle(width: number, maxRows: number): string[] {
		const titleLines = this.title.render(width);
		const clippedTitle = titleLines.slice(0, maxRows);
		if (titleLines.length <= maxRows || maxRows <= 1) {
			return clippedTitle;
		}

		const clippedIndicator = new Text(theme.fg("muted", this.clippedTitleText), 1, 0).render(width)[0];
		if (clippedIndicator) {
			clippedTitle[clippedTitle.length - 1] = clippedIndicator;
		}
		return clippedTitle;
	}
}
