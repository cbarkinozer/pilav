/**
 * Owns editor-replacement layout for interactive mode.
 */

import { type Component, Container, type TUI } from "@earendil-works/pi-tui";

export type EditorReplacementMaxHeight = (width: number) => number;

export interface EditorReplacementSession {
	maxHeight: EditorReplacementMaxHeight;
	show(component: Component, focus: Component): void;
	restoreEditor(): void;
	restore(component: Component, focus: Component): void;
}

export class VisibilityContainer extends Container {
	private visible = true;

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	override render(width: number): string[] {
		return this.visible ? super.render(width) : [];
	}
}

export class EditorReplacementHost {
	private readonly tui: TUI;
	private readonly editorContainer: Container;
	private readonly chromeContainer: VisibilityContainer;
	private readonly getEditor: () => Component;
	private chromeHidden = false;

	constructor(tui: TUI, editorContainer: Container, chromeContainer: VisibilityContainer, getEditor: () => Component) {
		this.tui = tui;
		this.editorContainer = editorContainer;
		this.chromeContainer = chromeContainer;
		this.getEditor = getEditor;
	}

	begin(options: { hideChrome?: boolean } = {}): EditorReplacementSession {
		this.setChromeHidden(options.hideChrome === true);
		return {
			maxHeight: (width) => this.getAvailableHeight(width),
			show: (component, focus) => this.show(component, focus),
			restoreEditor: () => this.restoreEditor(),
			restore: (component, focus) => this.restore(component, focus),
		};
	}

	restoreEditor(): void {
		this.restore(this.getEditor(), this.getEditor());
	}

	restore(component: Component, focus: Component): void {
		this.setChromeHidden(false);
		this.show(component, focus);
	}

	private show(component: Component, focus: Component): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.tui.setFocus(focus);
		this.tui.requestRender();
	}

	private setChromeHidden(hidden: boolean): void {
		if (this.chromeHidden === hidden) return;
		this.chromeHidden = hidden;
		this.chromeContainer.setVisible(!hidden);
	}

	private getAvailableHeight(width: number): number {
		let reservedRows = 0;
		let afterEditor = false;
		for (const child of this.tui.children) {
			if (child === this.editorContainer) {
				afterEditor = true;
				continue;
			}
			if (afterEditor) {
				reservedRows += child.render(width).length;
			}
		}
		return Math.max(1, this.tui.terminal.rows - reservedRows);
	}
}
