import {
    App,
    ItemView,
    MarkdownView,
    Notice,
    Plugin,
    SuggestModal,
    TFile,
    TFolder,
    WorkspaceLeaf,
} from "obsidian";

export const VIEW_TYPE_REGEX = "global-regex-view";

type ScopeType = "current-file" | "current-folder" | "selected-folder" | "vault";

interface RegexToolSettings {
    findPattern: string;
    replacePattern: string;
    flagI: boolean;
    flagM: boolean;
    flagS: boolean;
    flagU: boolean;
    scope: ScopeType;
    selectedFolder: string;
    fileExtensions: string;
}

const DEFAULT_SETTINGS: RegexToolSettings = {
    findPattern: "",
    replacePattern: "",
    flagI: false,
    flagM: true,
    flagS: false,
    flagU: false,
    scope: "current-file",
    selectedFolder: "",
    fileExtensions: "md",
};

interface RegexMatch {
    file: TFile;
    index: number;
    length: number;
    text: string;
    line: number;
    col: number;
    lineContext: string;
}

function indexToLineCol(
    text: string,
    index: number
): { line: number; col: number; lineStart: number; lineEnd: number } {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < index; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            lineStart = i + 1;
        }
    }
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    return { line, col: index - lineStart, lineStart, lineEnd };
}

function truncate(s: string, maxLen: number, fromEnd: boolean): string {
    if (s.length <= maxLen) return s;
    if (fromEnd) return "…" + s.slice(-(maxLen - 1));
    return s.slice(0, maxLen - 1) + "…";
}

export default class GlobalRegexPlugin extends Plugin {
    settings: RegexToolSettings = { ...DEFAULT_SETTINGS };

    async onload() {
        await this.loadSettings();

        this.registerView(VIEW_TYPE_REGEX, (leaf) => new RegexView(leaf, this));

        this.addRibbonIcon("replace", "Global Regex Tool", () => {
            this.activateView();
        });

        this.addCommand({
            id: "open-global-regex",
            name: "Open regex find and replace",
            callback: () => this.activateView(),
        });
    }

    onunload() {
        // Leaves are detached automatically by Obsidian.
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(VIEW_TYPE_REGEX);
        let leaf: WorkspaceLeaf | null;
        if (existing.length > 0) {
            leaf = existing[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (!leaf) leaf = workspace.getLeaf(true);
            await leaf.setViewState({ type: VIEW_TYPE_REGEX, active: true });
        }
        workspace.revealLeaf(leaf);
    }
}

class RegexView extends ItemView {
    plugin: GlobalRegexPlugin;

    private findInputEl!: HTMLTextAreaElement;
    private replaceInputEl!: HTMLTextAreaElement;
    private scopeSelectEl!: HTMLSelectElement;
    private folderInputEl!: HTMLInputElement;
    private folderRowEl!: HTMLElement;
    private extensionInputEl!: HTMLInputElement;
    private resultsEl!: HTMLElement;
    private statusEl!: HTMLElement;

    private matches: RegexMatch[] = [];
    private matchesValid = false;
    private currentIndex = -1;

    constructor(leaf: WorkspaceLeaf, plugin: GlobalRegexPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_REGEX;
    }

    getDisplayText() {
        return "Regex Find & Replace";
    }

    getIcon() {
        return "replace";
    }

    async onOpen() {
        this.build();
        this.registerEvent(
            this.plugin.app.vault.on("modify", () => this.invalidateMatches())
        );
        this.registerEvent(
            this.plugin.app.vault.on("delete", () => this.invalidateMatches())
        );
        this.registerEvent(
            this.plugin.app.vault.on("rename", () => this.invalidateMatches())
        );
        this.registerEvent(
            this.plugin.app.vault.on("create", () => this.invalidateMatches())
        );
    }

    async onClose() {
        // nothing to clean up
    }

    private build() {
        const container = this.contentEl;
        container.empty();
        container.addClass("global-regex-view");

        // Find
        const findRow = container.createDiv({ cls: "gr-row" });
        findRow.createEl("label", { text: "Find (regex)", cls: "gr-label" });
        this.findInputEl = findRow.createEl("textarea", {
            cls: "gr-input gr-find",
        });
        this.findInputEl.rows = 2;
        this.findInputEl.value = this.plugin.settings.findPattern;
        this.findInputEl.spellcheck = false;
        this.findInputEl.addEventListener("input", () => {
            this.plugin.settings.findPattern = this.findInputEl.value;
            this.plugin.saveSettings();
            this.validateRegexLive();
            this.invalidateMatches();
        });
        this.findInputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.findNext();
            }
        });

        // Replace
        const replaceRow = container.createDiv({ cls: "gr-row" });
        replaceRow.createEl("label", {
            text: "Replace with",
            cls: "gr-label",
        });
        this.replaceInputEl = replaceRow.createEl("textarea", {
            cls: "gr-input gr-replace",
        });
        this.replaceInputEl.rows = 2;
        this.replaceInputEl.value = this.plugin.settings.replacePattern;
        this.replaceInputEl.spellcheck = false;
        this.replaceInputEl.addEventListener("input", () => {
            this.plugin.settings.replacePattern = this.replaceInputEl.value;
            this.plugin.saveSettings();
        });

        // Flags
        const flagsRow = container.createDiv({ cls: "gr-row gr-flags" });
        flagsRow.createEl("label", { text: "Flags:", cls: "gr-label" });
        this.makeFlag(flagsRow, "i", "Case insensitive", "flagI");
        this.makeFlag(
            flagsRow,
            "m",
            "Multiline (^ and $ match line boundaries)",
            "flagM"
        );
        this.makeFlag(flagsRow, "s", "Dot matches newlines", "flagS");
        this.makeFlag(flagsRow, "u", "Unicode", "flagU");

        // Scope
        const scopeRow = container.createDiv({ cls: "gr-row" });
        scopeRow.createEl("label", { text: "Scope", cls: "gr-label" });
        this.scopeSelectEl = scopeRow.createEl("select", { cls: "gr-input" });
        const scopeOptions: [ScopeType, string][] = [
            ["current-file", "Current file"],
            ["current-folder", "Current folder (recursive)"],
            ["selected-folder", "Selected folder (recursive)"],
            ["vault", "Entire vault"],
        ];
        for (const [val, label] of scopeOptions) {
            const opt = this.scopeSelectEl.createEl("option", { text: label });
            opt.value = val;
        }
        this.scopeSelectEl.value = this.plugin.settings.scope;
        this.scopeSelectEl.addEventListener("change", () => {
            this.plugin.settings.scope = this.scopeSelectEl
                .value as ScopeType;
            this.plugin.saveSettings();
            this.updateFolderRow();
            this.invalidateMatches();
        });

        // Folder row (only visible for selected-folder scope)
        this.folderRowEl = container.createDiv({
            cls: "gr-row gr-folder-row",
        });
        this.folderRowEl.createEl("label", {
            text: "Folder",
            cls: "gr-label",
        });
        this.folderInputEl = this.folderRowEl.createEl("input", {
            cls: "gr-input",
            type: "text",
        });
        this.folderInputEl.value = this.plugin.settings.selectedFolder;
        this.folderInputEl.placeholder = "Vault root";
        this.folderInputEl.addEventListener("change", () => {
            this.plugin.settings.selectedFolder = this.folderInputEl.value;
            this.plugin.saveSettings();
            this.invalidateMatches();
        });
        const browseBtn = this.folderRowEl.createEl("button", {
            text: "Browse…",
            cls: "gr-btn",
        });
        browseBtn.addEventListener("click", () => {
            new FolderPickerModal(this.plugin.app, (folder) => {
                const path = folder.path === "" ? "/" : folder.path;
                this.folderInputEl.value = path;
                this.plugin.settings.selectedFolder = path;
                this.plugin.saveSettings();
                this.invalidateMatches();
            }).open();
        });

        // Extensions
        const extRow = container.createDiv({ cls: "gr-row" });
        extRow.createEl("label", {
            text: "File extensions (comma-separated; blank = all)",
            cls: "gr-label",
        });
        this.extensionInputEl = extRow.createEl("input", {
            cls: "gr-input",
            type: "text",
        });
        this.extensionInputEl.value = this.plugin.settings.fileExtensions;
        this.extensionInputEl.placeholder = "md, txt, canvas";
        this.extensionInputEl.addEventListener("change", () => {
            this.plugin.settings.fileExtensions = this.extensionInputEl.value;
            this.plugin.saveSettings();
            this.invalidateMatches();
        });

        // Buttons
        const btnRow = container.createDiv({ cls: "gr-row gr-buttons" });
        const findNextBtn = btnRow.createEl("button", {
            text: "Find Next",
            cls: "gr-btn",
        });
        const findAllBtn = btnRow.createEl("button", {
            text: "Find All",
            cls: "gr-btn",
        });
        const replaceBtn = btnRow.createEl("button", {
            text: "Replace",
            cls: "gr-btn",
        });
        const replaceAllBtn = btnRow.createEl("button", {
            text: "Replace All",
            cls: "gr-btn gr-warn",
        });
        findNextBtn.addEventListener("click", () => this.findNext());
        findAllBtn.addEventListener("click", () => this.findAll());
        replaceBtn.addEventListener("click", () => this.replaceNext());
        replaceAllBtn.addEventListener("click", () => this.replaceAll());

        // Status + results
        this.statusEl = container.createDiv({ cls: "gr-status" });
        this.resultsEl = container.createDiv({ cls: "gr-results" });

        this.updateFolderRow();
        this.validateRegexLive();
    }

    private makeFlag(
        parent: HTMLElement,
        letter: string,
        title: string,
        settingKey: keyof RegexToolSettings
    ): HTMLInputElement {
        const label = parent.createEl("label", {
            cls: "gr-flag",
            attr: { title },
        });
        const input = label.createEl("input", { type: "checkbox" });
        input.checked = Boolean(this.plugin.settings[settingKey]);
        label.createSpan({ text: letter });
        input.addEventListener("change", () => {
            (
                this.plugin.settings as unknown as Record<string, unknown>
            )[settingKey] = input.checked;
            this.plugin.saveSettings();
            this.invalidateMatches();
        });
        return input;
    }

    private updateFolderRow() {
        const show = this.plugin.settings.scope === "selected-folder";
        this.folderRowEl.style.display = show ? "" : "none";
    }

    private validateRegexLive() {
        const pattern = this.plugin.settings.findPattern;
        if (!pattern) {
            this.findInputEl.removeClass("gr-invalid");
            this.setStatus("");
            return;
        }
        try {
            new RegExp(pattern);
            this.findInputEl.removeClass("gr-invalid");
            if (this.statusEl.getText().startsWith("Invalid regex")) {
                this.setStatus("");
            }
        } catch (e) {
            this.findInputEl.addClass("gr-invalid");
            this.setStatus(`Invalid regex: ${(e as Error).message}`);
        }
    }

    private buildRegex(global: boolean): RegExp | null {
        const pattern = this.plugin.settings.findPattern;
        if (!pattern) return null;
        let flags = "";
        if (global) flags += "g";
        if (this.plugin.settings.flagI) flags += "i";
        if (this.plugin.settings.flagM) flags += "m";
        if (this.plugin.settings.flagS) flags += "s";
        if (this.plugin.settings.flagU) flags += "u";
        try {
            return new RegExp(pattern, flags);
        } catch (e) {
            new Notice(`Invalid regex: ${(e as Error).message}`);
            return null;
        }
    }

    private invalidateMatches() {
        this.matches = [];
        this.matchesValid = false;
        this.currentIndex = -1;
    }

    private setStatus(text: string) {
        this.statusEl.setText(text);
    }

    private getFilesInScope(): TFile[] {
        const { scope, selectedFolder, fileExtensions } = this.plugin.settings;
        const extList = fileExtensions
            .split(",")
            .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
            .filter(Boolean);
        const matchesExt = (file: TFile) =>
            extList.length === 0
                ? true
                : extList.includes(file.extension.toLowerCase());
        const vault = this.plugin.app.vault;
        const workspace = this.plugin.app.workspace;

        if (scope === "current-file") {
            const active = workspace.getActiveFile();
            if (active && matchesExt(active)) return [active];
            return [];
        }
        if (scope === "vault") {
            return vault.getFiles().filter(matchesExt);
        }
        if (scope === "current-folder") {
            const active = workspace.getActiveFile();
            if (!active || !active.parent) return [];
            return this.collectFilesInFolder(active.parent).filter(matchesExt);
        }
        // selected-folder
        const raw = selectedFolder || "";
        const path = raw === "/" ? "" : raw;
        const folder =
            path === ""
                ? vault.getRoot()
                : vault.getAbstractFileByPath(path);
        if (folder instanceof TFolder) {
            return this.collectFilesInFolder(folder).filter(matchesExt);
        }
        return [];
    }

    private collectFilesInFolder(folder: TFolder): TFile[] {
        const out: TFile[] = [];
        const walk = (f: TFolder) => {
            for (const child of f.children) {
                if (child instanceof TFile) out.push(child);
                else if (child instanceof TFolder) walk(child);
            }
        };
        walk(folder);
        return out;
    }

    private async ensureMatches(): Promise<RegexMatch[]> {
        if (this.matchesValid) return this.matches;
        const regex = this.buildRegex(true);
        if (!regex) {
            this.matches = [];
            this.matchesValid = true;
            return this.matches;
        }
        const files = this.getFilesInScope();
        const vault = this.plugin.app.vault;
        const all: RegexMatch[] = [];
        for (const file of files) {
            let content: string;
            try {
                content = await vault.cachedRead(file);
            } catch {
                continue;
            }
            let m: RegExpExecArray | null;
            regex.lastIndex = 0;
            while ((m = regex.exec(content)) !== null) {
                if (m[0].length === 0) {
                    regex.lastIndex++;
                    continue;
                }
                const { line, col, lineStart, lineEnd } = indexToLineCol(
                    content,
                    m.index
                );
                all.push({
                    file,
                    index: m.index,
                    length: m[0].length,
                    text: m[0],
                    line,
                    col,
                    lineContext: content.slice(lineStart, lineEnd),
                });
            }
        }
        this.matches = all;
        this.matchesValid = true;
        this.currentIndex = -1;
        return all;
    }

    async findNext() {
        if (!this.plugin.settings.findPattern) {
            this.setStatus("Enter a pattern");
            return;
        }
        const matches = await this.ensureMatches();
        if (matches.length === 0) {
            this.setStatus("No matches");
            new Notice("No matches");
            return;
        }
        if (this.currentIndex < 0) {
            this.currentIndex = this.findStartingIndex(matches);
        } else {
            this.currentIndex = (this.currentIndex + 1) % matches.length;
        }
        await this.navigateToMatch(matches[this.currentIndex]);
        this.setStatus(
            `Match ${this.currentIndex + 1} of ${matches.length} — ${
                matches[this.currentIndex].file.path
            }`
        );
    }

    private findStartingIndex(matches: RegexMatch[]): number {
        const active =
            this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (active && active.file) {
            const cursor = active.editor.getCursor();
            const cursorOffset = active.editor.posToOffset(cursor);
            const activePath = active.file.path;
            for (let i = 0; i < matches.length; i++) {
                if (
                    matches[i].file.path === activePath &&
                    matches[i].index >= cursorOffset
                ) {
                    return i;
                }
            }
        }
        return 0;
    }

    async findAll() {
        if (!this.plugin.settings.findPattern) {
            this.setStatus("Enter a pattern");
            return;
        }
        const matches = await this.ensureMatches();
        const fileCount = new Set(matches.map((m) => m.file.path)).size;
        this.setStatus(
            `${matches.length} match${matches.length === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`
        );
        this.renderResults(matches);
    }

    async replaceNext() {
        if (!this.plugin.settings.findPattern) {
            this.setStatus("Enter a pattern");
            return;
        }
        const matches = await this.ensureMatches();
        if (matches.length === 0) {
            this.setStatus("No matches");
            new Notice("No matches");
            return;
        }

        let idx = this.currentIndex;
        if (idx < 0) idx = this.findStartingIndex(matches);
        const match = matches[idx];

        const singleRegex = this.buildRegex(false);
        if (!singleRegex) return;
        const replacement = match.text.replace(
            singleRegex,
            this.plugin.settings.replacePattern
        );

        let replaced = false;
        await this.plugin.app.vault.process(match.file, (data) => {
            if (
                data.slice(match.index, match.index + match.length) ===
                match.text
            ) {
                replaced = true;
                return (
                    data.slice(0, match.index) +
                    replacement +
                    data.slice(match.index + match.length)
                );
            }
            return data;
        });

        if (replaced) {
            this.invalidateMatches();
            this.setStatus(`Replaced 1 match in ${match.file.path}`);
            await this.findNextAfterOffset(
                match.file,
                match.index + replacement.length
            );
        } else {
            this.setStatus("Match not found (content changed) — refreshed");
            this.invalidateMatches();
        }
    }

    private async findNextAfterOffset(file: TFile, offset: number) {
        const matches = await this.ensureMatches();
        if (matches.length === 0) {
            this.setStatus("No more matches");
            return;
        }
        for (let i = 0; i < matches.length; i++) {
            if (
                matches[i].file.path === file.path &&
                matches[i].index >= offset
            ) {
                this.currentIndex = i;
                await this.navigateToMatch(matches[i]);
                this.setStatus(
                    `Match ${i + 1} of ${matches.length} — ${matches[i].file.path}`
                );
                return;
            }
        }
        this.currentIndex = 0;
        await this.navigateToMatch(matches[0]);
        this.setStatus(
            `Wrapped — match 1 of ${matches.length} — ${matches[0].file.path}`
        );
    }

    async replaceAll() {
        if (!this.plugin.settings.findPattern) {
            this.setStatus("Enter a pattern");
            return;
        }
        const regex = this.buildRegex(true);
        if (!regex) return;
        const files = this.getFilesInScope();
        if (files.length === 0) {
            this.setStatus("No files in scope");
            new Notice("No files in scope");
            return;
        }
        const replacement = this.plugin.settings.replacePattern;
        let total = 0;
        let changedFiles = 0;
        for (const file of files) {
            let count = 0;
            await this.plugin.app.vault.process(file, (data) => {
                const freshCount = new RegExp(regex.source, regex.flags);
                const m = data.match(freshCount);
                count = m ? m.length : 0;
                if (count === 0) return data;
                const freshReplace = new RegExp(regex.source, regex.flags);
                return data.replace(freshReplace, replacement);
            });
            if (count > 0) {
                total += count;
                changedFiles++;
            }
        }
        this.invalidateMatches();
        const msg = `Replaced ${total} match${total === 1 ? "" : "es"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}`;
        this.setStatus(msg);
        new Notice(msg);
        this.resultsEl.empty();
    }

    private async navigateToMatch(match: RegexMatch) {
        const workspace = this.plugin.app.workspace;
        let targetLeaf: WorkspaceLeaf | null = null;
        workspace.iterateRootLeaves((leaf) => {
            if (
                !targetLeaf &&
                leaf.view instanceof MarkdownView &&
                leaf.view.file?.path === match.file.path
            ) {
                targetLeaf = leaf;
            }
        });
        if (!targetLeaf) {
            workspace.iterateRootLeaves((leaf) => {
                if (!targetLeaf && leaf.view instanceof MarkdownView) {
                    targetLeaf = leaf;
                }
            });
        }
        if (!targetLeaf) {
            targetLeaf = workspace.getLeaf(true);
        }
        await targetLeaf.openFile(match.file);
        workspace.setActiveLeaf(targetLeaf, { focus: true });
        const view = targetLeaf.view;
        if (view instanceof MarkdownView) {
            const editor = view.editor;
            const start = editor.offsetToPos(match.index);
            const end = editor.offsetToPos(match.index + match.length);
            editor.setSelection(start, end);
            editor.scrollIntoView({ from: start, to: end }, true);
            editor.focus();
        }
    }

    private renderResults(matches: RegexMatch[]) {
        this.resultsEl.empty();
        if (matches.length === 0) {
            this.resultsEl.createDiv({
                cls: "gr-no-results",
                text: "No matches.",
            });
            return;
        }
        const byFile = new Map<
            string,
            { file: TFile; matches: RegexMatch[] }
        >();
        for (const m of matches) {
            let entry = byFile.get(m.file.path);
            if (!entry) {
                entry = { file: m.file, matches: [] };
                byFile.set(m.file.path, entry);
            }
            entry.matches.push(m);
        }
        for (const { file, matches: fileMatches } of byFile.values()) {
            const group = this.resultsEl.createDiv({ cls: "gr-file-group" });
            const header = group.createDiv({ cls: "gr-file-header" });
            header.createSpan({ cls: "gr-file-path", text: file.path });
            header.createSpan({
                cls: "gr-file-count",
                text: `${fileMatches.length} match${fileMatches.length === 1 ? "" : "es"}`,
            });
            for (const match of fileMatches) {
                const el = group.createDiv({ cls: "gr-match" });
                el.createSpan({
                    cls: "gr-line-num",
                    text: `${match.line + 1}:${match.col + 1}`,
                });
                const line = match.lineContext;
                const before = line.slice(0, match.col);
                const matchedPart = line.slice(
                    match.col,
                    match.col + Math.min(match.length, line.length - match.col)
                );
                const after = line.slice(match.col + matchedPart.length);
                const matchSpansLines = match.length > matchedPart.length;
                el.createSpan({
                    cls: "gr-before",
                    text: truncate(before, 80, true),
                });
                el.createSpan({ cls: "gr-matched", text: matchedPart });
                if (matchSpansLines) {
                    el.createSpan({ cls: "gr-matched", text: "⏎" });
                }
                el.createSpan({
                    cls: "gr-after",
                    text: truncate(after, 80, false),
                });
                el.addEventListener("click", () => {
                    this.navigateToMatch(match);
                });
            }
        }
    }
}

class FolderPickerModal extends SuggestModal<TFolder> {
    private onChoose: (folder: TFolder) => void;

    constructor(app: App, onChoose: (folder: TFolder) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Select a folder…");
    }

    getSuggestions(query: string): TFolder[] {
        const folders: TFolder[] = [];
        const walk = (f: TFolder) => {
            folders.push(f);
            for (const c of f.children) {
                if (c instanceof TFolder) walk(c);
            }
        };
        walk(this.app.vault.getRoot());
        const q = query.toLowerCase();
        return folders.filter((f) =>
            (f.path === "" ? "/" : f.path).toLowerCase().includes(q)
        );
    }

    renderSuggestion(folder: TFolder, el: HTMLElement) {
        el.createEl("div", { text: folder.path === "" ? "/" : folder.path });
    }

    onChooseSuggestion(folder: TFolder) {
        this.onChoose(folder);
    }
}
