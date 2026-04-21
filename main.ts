import {
    App,
    ItemView,
    MarkdownView,
    Menu,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    SuggestModal,
    TFile,
    TFolder,
    WorkspaceLeaf,
} from "obsidian";

export const VIEW_TYPE_REGEX = "global-regex-view";

type ScopeType =
    | "current-file"
    | "current-selection"
    | "current-folder"
    | "selected-folder"
    | "vault";

interface SavedPair {
    name: string;
    find: string;
    replace: string;
    flagI?: boolean;
    flagM?: boolean;
    flagS?: boolean;
    flagU?: boolean;
}

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
    findHistory: string[];
    replaceHistory: string[];
    savedPairs: SavedPair[];
    historyLimit: number;
}

const HISTORY_LIMIT_MIN = 1;
const HISTORY_LIMIT_MAX = 100;
const HISTORY_LIMIT_DEFAULT = 20;

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
    findHistory: [],
    replaceHistory: [],
    savedPairs: [],
    historyLimit: HISTORY_LIMIT_DEFAULT,
};

interface RegexMatch {
    file: TFile;
    index: number;
    length: number;
    text: string;
    line: number;
    col: number;
    lineContext: string;
    groupCaptures: (string | undefined)[];
    namedCaptures: Record<string, string | undefined> | undefined;
}

interface DryRunItem {
    match: RegexMatch;
    replacedText: string;
    multiline: boolean;
}

function processReplacementEscapes(template: string): string {
    return template.replace(/\\(.)/g, (match, ch) => {
        switch (ch) {
            case "n":
                return "\n";
            case "r":
                return "\r";
            case "t":
                return "\t";
            case "\\":
                return "\\";
            default:
                return match;
        }
    });
}

function expandReplacementTemplate(
    template: string,
    fullMatch: string,
    groupCaptures: (string | undefined)[],
    named: Record<string, string | undefined> | undefined
): string {
    let out = "";
    let i = 0;
    while (i < template.length) {
        const ch = template[i];
        if (ch !== "$" || i + 1 >= template.length) {
            out += ch;
            i++;
            continue;
        }
        const next = template[i + 1];
        if (next === "$") {
            out += "$";
            i += 2;
        } else if (next === "&") {
            out += fullMatch;
            i += 2;
        } else if (next === "<") {
            const end = template.indexOf(">", i + 2);
            if (end !== -1 && named) {
                const name = template.slice(i + 2, end);
                out += named[name] ?? "";
                i = end + 1;
            } else {
                out += ch;
                i++;
            }
        } else if (next >= "0" && next <= "9") {
            let digits = next;
            const twoAhead = template[i + 2];
            if (twoAhead && twoAhead >= "0" && twoAhead <= "9") {
                const twoDigit = digits + twoAhead;
                const nTwo = parseInt(twoDigit, 10);
                if (nTwo > 0 && nTwo <= groupCaptures.length) {
                    digits = twoDigit;
                }
            }
            const n = parseInt(digits, 10);
            if (n > 0 && n <= groupCaptures.length) {
                out += groupCaptures[n - 1] ?? "";
                i += 1 + digits.length;
            } else {
                out += ch;
                i++;
            }
        } else {
            out += ch;
            i++;
        }
    }
    return out;
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

        this.addSettingTab(new GlobalRegexSettingTab(this.app, this));
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
    private savedPairSelectEl!: HTMLSelectElement;
    private flagIEl!: HTMLInputElement;
    private flagMEl!: HTMLInputElement;
    private flagSEl!: HTMLInputElement;
    private flagUEl!: HTMLInputElement;
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
        const findHeader = findRow.createDiv({ cls: "gr-label-row" });
        findHeader.createEl("label", {
            text: "Find (regex)",
            cls: "gr-label",
        });
        const findHistoryBtn = findHeader.createEl("button", {
            text: "History ▾",
            cls: "gr-mini-btn",
            attr: { type: "button", title: "Recent find patterns" },
        });
        findHistoryBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.openHistoryMenu(findHistoryBtn, "find");
        });
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
        const replaceHeader = replaceRow.createDiv({ cls: "gr-label-row" });
        replaceHeader.createEl("label", {
            text: "Replace with",
            cls: "gr-label",
        });
        const replaceHistoryBtn = replaceHeader.createEl("button", {
            text: "History ▾",
            cls: "gr-mini-btn",
            attr: { type: "button", title: "Recent replacement strings" },
        });
        replaceHistoryBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.openHistoryMenu(replaceHistoryBtn, "replace");
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
        this.flagIEl = this.makeFlag(flagsRow, "i", "Case insensitive", "flagI");
        this.flagMEl = this.makeFlag(
            flagsRow,
            "m",
            "Multiline (^ and $ match line boundaries)",
            "flagM"
        );
        this.flagSEl = this.makeFlag(flagsRow, "s", "Dot matches newlines", "flagS");
        this.flagUEl = this.makeFlag(flagsRow, "u", "Unicode", "flagU");

        // Scope
        const scopeRow = container.createDiv({ cls: "gr-row" });
        scopeRow.createEl("label", { text: "Scope", cls: "gr-label" });
        this.scopeSelectEl = scopeRow.createEl("select", { cls: "gr-input" });
        const scopeOptions: [ScopeType, string][] = [
            ["current-file", "Current file"],
            ["current-selection", "Selection(s) in current file"],
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

        // Saved pairs
        const savedRow = container.createDiv({
            cls: "gr-row gr-saved-row",
        });
        savedRow.createEl("label", {
            text: "Saved pairs",
            cls: "gr-label",
        });
        this.savedPairSelectEl = savedRow.createEl("select", {
            cls: "gr-input",
        });
        this.refreshSavedPairsSelect();
        this.savedPairSelectEl.addEventListener("change", () => {
            this.loadSelectedPair();
        });
        const saveBtn = savedRow.createEl("button", {
            text: "Save…",
            cls: "gr-btn gr-mini-btn",
            attr: { type: "button", title: "Save current find + replace as a named pair" },
        });
        saveBtn.addEventListener("click", () => this.saveCurrentPair());
        const deletePairBtn = savedRow.createEl("button", {
            text: "Delete",
            cls: "gr-btn gr-mini-btn gr-warn",
            attr: { type: "button", title: "Delete the selected saved pair" },
        });
        deletePairBtn.addEventListener("click", () => this.deleteSelectedPair());

        // Find actions
        const findBtnRow = container.createDiv({
            cls: "gr-row gr-buttons gr-find-buttons",
        });
        const findNextBtn = findBtnRow.createEl("button", {
            text: "Find Next",
            cls: "gr-btn",
        });
        const findAllBtn = findBtnRow.createEl("button", {
            text: "Find All",
            cls: "gr-btn",
        });
        findNextBtn.addEventListener("click", () => this.findNext());
        findAllBtn.addEventListener("click", () => this.findAll());

        // Replace actions
        const replaceBtnRow = container.createDiv({
            cls: "gr-row gr-buttons gr-replace-buttons",
        });
        const dryRunBtn = replaceBtnRow.createEl("button", {
            text: "Dry Run",
            cls: "gr-btn",
            attr: { title: "Preview what would be replaced, without changing any files" },
        });
        const replaceBtn = replaceBtnRow.createEl("button", {
            text: "Replace",
            cls: "gr-btn",
        });
        const replaceAllBtn = replaceBtnRow.createEl("button", {
            text: "Replace All",
            cls: "gr-btn gr-warn",
        });
        const clearBtn = replaceBtnRow.createEl("button", {
            text: "Clear",
            cls: "gr-btn gr-clear",
            attr: {
                title: "Reset find, replace, and flags to their defaults",
            },
        });
        dryRunBtn.addEventListener("click", () => this.dryRun());
        replaceBtn.addEventListener("click", () => this.replaceNext());
        replaceAllBtn.addEventListener("click", () => this.replaceAll());
        clearBtn.addEventListener("click", () => this.clearForm());

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
        this.markResultsStale();
    }

    private markResultsStale() {
        if (!this.resultsEl || !this.resultsEl.hasChildNodes()) return;
        if (this.resultsEl.querySelector(".gr-stale-banner")) return;
        const banner = createDiv({
            cls: "gr-stale-banner",
            text: "Results are stale — re-run the search to refresh",
        });
        this.resultsEl.prepend(banner);
    }

    private getEffectiveReplacement(): string {
        return processReplacementEscapes(this.plugin.settings.replacePattern);
    }

    private clearForm() {
        const s = this.plugin.settings;
        s.findPattern = DEFAULT_SETTINGS.findPattern;
        s.replacePattern = DEFAULT_SETTINGS.replacePattern;
        s.flagI = DEFAULT_SETTINGS.flagI;
        s.flagM = DEFAULT_SETTINGS.flagM;
        s.flagS = DEFAULT_SETTINGS.flagS;
        s.flagU = DEFAULT_SETTINGS.flagU;
        this.findInputEl.value = s.findPattern;
        this.replaceInputEl.value = s.replacePattern;
        this.flagIEl.checked = s.flagI;
        this.flagMEl.checked = s.flagM;
        this.flagSEl.checked = s.flagS;
        this.flagUEl.checked = s.flagU;
        this.savedPairSelectEl.value = "";
        this.validateRegexLive();
        this.invalidateMatches();
        this.resultsEl.empty();
        this.plugin.saveSettings();
        this.setStatus("Cleared");
    }

    private setStatus(text: string) {
        this.statusEl.setText(text);
    }

    private recordHistory() {
        const s = this.plugin.settings;
        const limit = Math.max(
            HISTORY_LIMIT_MIN,
            Math.min(HISTORY_LIMIT_MAX, s.historyLimit || HISTORY_LIMIT_DEFAULT)
        );
        const push = (list: string[], value: string) => {
            if (!value) return list;
            const next = list.filter((v) => v !== value);
            next.unshift(value);
            if (next.length > limit) next.length = limit;
            return next;
        };
        const beforeFind = s.findHistory;
        const beforeReplace = s.replaceHistory;
        s.findHistory = push(beforeFind, s.findPattern);
        s.replaceHistory = push(beforeReplace, s.replacePattern);
        if (
            s.findHistory !== beforeFind ||
            s.replaceHistory !== beforeReplace
        ) {
            this.plugin.saveSettings();
        }
    }

    private openHistoryMenu(anchor: HTMLElement, type: "find" | "replace") {
        const list =
            type === "find"
                ? this.plugin.settings.findHistory
                : this.plugin.settings.replaceHistory;
        const menu = new Menu();
        if (list.length === 0) {
            menu.addItem((item) =>
                item.setTitle("(empty)").setDisabled(true)
            );
        } else {
            for (const entry of list) {
                const display =
                    entry.length > 60 ? entry.slice(0, 59) + "…" : entry;
                menu.addItem((item) => {
                    item.setTitle(display);
                    item.onClick(() => this.applyHistory(type, entry));
                });
            }
            menu.addSeparator();
            menu.addItem((item) =>
                item
                    .setTitle("Clear history")
                    .setIcon("trash")
                    .onClick(() => {
                        if (type === "find")
                            this.plugin.settings.findHistory = [];
                        else this.plugin.settings.replaceHistory = [];
                        this.plugin.saveSettings();
                    })
            );
        }
        const rect = anchor.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }

    private applyHistory(type: "find" | "replace", value: string) {
        if (type === "find") {
            this.plugin.settings.findPattern = value;
            this.findInputEl.value = value;
            this.validateRegexLive();
            this.invalidateMatches();
        } else {
            this.plugin.settings.replacePattern = value;
            this.replaceInputEl.value = value;
        }
        this.plugin.saveSettings();
    }

    private refreshSavedPairsSelect(selectName?: string) {
        const sel = this.savedPairSelectEl;
        sel.empty();
        const placeholder = sel.createEl("option", {
            text: "— Select saved pair —",
        });
        placeholder.value = "";
        const pairs = this.plugin.settings.savedPairs;
        for (const p of pairs) {
            const opt = sel.createEl("option", { text: p.name });
            opt.value = p.name;
        }
        sel.value = selectName ?? "";
    }

    private loadSelectedPair() {
        const name = this.savedPairSelectEl.value;
        if (!name) return;
        const pair = this.plugin.settings.savedPairs.find(
            (p) => p.name === name
        );
        if (!pair) return;
        const s = this.plugin.settings;
        s.findPattern = pair.find;
        s.replacePattern = pair.replace;
        this.findInputEl.value = pair.find;
        this.replaceInputEl.value = pair.replace;
        const restoredFlags: string[] = [];
        const applyFlag = (
            key: "flagI" | "flagM" | "flagS" | "flagU",
            letter: string,
            el: HTMLInputElement
        ) => {
            if (typeof pair[key] === "boolean") {
                s[key] = pair[key] as boolean;
                el.checked = pair[key] as boolean;
                restoredFlags.push(letter);
            }
        };
        applyFlag("flagI", "i", this.flagIEl);
        applyFlag("flagM", "m", this.flagMEl);
        applyFlag("flagS", "s", this.flagSEl);
        applyFlag("flagU", "u", this.flagUEl);
        this.validateRegexLive();
        this.invalidateMatches();
        this.plugin.saveSettings();
        const flagNote = restoredFlags.length === 0
            ? " (no flags saved; kept current)"
            : "";
        this.setStatus(`Loaded "${name}"${flagNote}`);
    }

    private saveCurrentPair() {
        const s = this.plugin.settings;
        const find = s.findPattern;
        const replace = s.replacePattern;
        if (!find) {
            new Notice("Enter a find pattern before saving");
            return;
        }
        const flagI = s.flagI;
        const flagM = s.flagM;
        const flagS = s.flagS;
        const flagU = s.flagU;
        const existingNames = new Set(s.savedPairs.map((p) => p.name));
        new SavePairModal(
            this.plugin.app,
            s.savedPairs,
            find,
            replace,
            { flagI, flagM, flagS, flagU },
            (name) => {
                const pairs = s.savedPairs;
                const existing = pairs.find((p) => p.name === name);
                if (existing) {
                    existing.find = find;
                    existing.replace = replace;
                    existing.flagI = flagI;
                    existing.flagM = flagM;
                    existing.flagS = flagS;
                    existing.flagU = flagU;
                } else {
                    pairs.push({
                        name,
                        find,
                        replace,
                        flagI,
                        flagM,
                        flagS,
                        flagU,
                    });
                }
                pairs.sort((a, b) => a.name.localeCompare(b.name));
                this.plugin.saveSettings();
                this.refreshSavedPairsSelect(name);
                new Notice(
                    existingNames.has(name)
                        ? `Updated "${name}"`
                        : `Saved "${name}"`
                );
            }
        ).open();
    }

    private deleteSelectedPair() {
        const name = this.savedPairSelectEl.value;
        if (!name) {
            new Notice("Select a saved pair to delete");
            return;
        }
        new ConfirmModal(
            this.plugin.app,
            `Delete saved pair "${name}"?`,
            "Delete",
            () => {
                this.plugin.settings.savedPairs =
                    this.plugin.settings.savedPairs.filter(
                        (p) => p.name !== name
                    );
                this.plugin.saveSettings();
                this.refreshSavedPairsSelect();
                new Notice(`Deleted "${name}"`);
            }
        ).open();
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

        if (scope === "current-file" || scope === "current-selection") {
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
        const raw = (selectedFolder || "").trim();
        const stripped = raw.replace(/^\/+/, "").replace(/\/+$/, "");
        const folder =
            stripped === ""
                ? vault.getRoot()
                : vault.getAbstractFileByPath(stripped);
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

    private getTargetMarkdownView(): MarkdownView | null {
        const workspace = this.plugin.app.workspace;
        const direct = workspace.getActiveViewOfType(MarkdownView);
        if (direct) return direct;
        const activeFile = workspace.getActiveFile();
        if (!activeFile) return null;
        let found: MarkdownView | null = null;
        workspace.iterateRootLeaves((leaf) => {
            if (
                !found &&
                leaf.view instanceof MarkdownView &&
                leaf.view.file?.path === activeFile.path
            ) {
                found = leaf.view;
            }
        });
        return found;
    }

    private getActiveSelectionRanges(): {
        view: MarkdownView;
        content: string;
        ranges: { start: number; end: number }[];
    } | null {
        const active = this.getTargetMarkdownView();
        if (!active || !active.file) return null;
        const editor = active.editor;
        const content = editor.getValue();
        const ranges = editor
            .listSelections()
            .map((s) => {
                const a = editor.posToOffset(s.anchor);
                const h = editor.posToOffset(s.head);
                return a <= h
                    ? { start: a, end: h }
                    : { start: h, end: a };
            })
            .filter((r) => r.end > r.start)
            .sort((a, b) => a.start - b.start);
        return { view: active, content, ranges };
    }

    private async ensureMatches(forceRecompute = false): Promise<RegexMatch[]> {
        if (!forceRecompute && this.matchesValid) return this.matches;
        const regex = this.buildRegex(true);
        if (!regex) {
            this.matches = [];
            this.matchesValid = true;
            return this.matches;
        }

        if (this.plugin.settings.scope === "current-selection") {
            this.matches = this.computeSelectionMatches(regex);
            this.matchesValid = true;
            this.currentIndex = -1;
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
                    groupCaptures: Array.prototype.slice.call(m, 1),
                    namedCaptures: m.groups
                        ? { ...m.groups }
                        : undefined,
                });
            }
        }
        this.matches = all;
        this.matchesValid = true;
        this.currentIndex = -1;
        return all;
    }

    private computeSelectionMatches(regex: RegExp): RegexMatch[] {
        const sel = this.getActiveSelectionRanges();
        if (!sel || sel.ranges.length === 0 || !sel.view.file) return [];
        const file = sel.view.file;
        const all: RegexMatch[] = [];
        for (const range of sel.ranges) {
            const sub = sel.content.slice(range.start, range.end);
            const freshRegex = new RegExp(regex.source, regex.flags);
            freshRegex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = freshRegex.exec(sub)) !== null) {
                if (m[0].length === 0) {
                    freshRegex.lastIndex++;
                    continue;
                }
                const fileIndex = range.start + m.index;
                const { line, col, lineStart, lineEnd } = indexToLineCol(
                    sel.content,
                    fileIndex
                );
                all.push({
                    file,
                    index: fileIndex,
                    length: m[0].length,
                    text: m[0],
                    line,
                    col,
                    lineContext: sel.content.slice(lineStart, lineEnd),
                    groupCaptures: Array.prototype.slice.call(m, 1),
                    namedCaptures: m.groups ? { ...m.groups } : undefined,
                });
            }
        }
        return all;
    }

    async findNext() {
        if (!this.plugin.settings.findPattern) {
            this.setStatus("Enter a pattern");
            return;
        }
        this.recordHistory();
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
        const active = this.getTargetMarkdownView();
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
        this.recordHistory();
        const matches = await this.ensureMatches(true);
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
        this.recordHistory();
        const matches = await this.ensureMatches();
        if (matches.length === 0) {
            this.setStatus("No matches");
            new Notice("No matches");
            return;
        }

        let idx = this.currentIndex;
        if (idx < 0) idx = this.findStartingIndex(matches);
        const match = matches[idx];

        const replacement = expandReplacementTemplate(
            this.getEffectiveReplacement(),
            match.text,
            match.groupCaptures,
            match.namedCaptures
        );

        let replaced = false;
        if (this.plugin.settings.scope === "current-selection") {
            const view = this.getTargetMarkdownView();
            if (view && view.file?.path === match.file.path) {
                const editor = view.editor;
                const current = editor.getRange(
                    editor.offsetToPos(match.index),
                    editor.offsetToPos(match.index + match.length)
                );
                if (current === match.text) {
                    editor.replaceRange(
                        replacement,
                        editor.offsetToPos(match.index),
                        editor.offsetToPos(match.index + match.length)
                    );
                    replaced = true;
                }
            }
        } else {
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
        }

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
        this.recordHistory();
        const regex = this.buildRegex(true);
        if (!regex) return;

        if (this.plugin.settings.scope === "current-selection") {
            await this.replaceAllInSelection(regex);
            return;
        }

        const files = this.getFilesInScope();
        if (files.length === 0) {
            this.setStatus("No files in scope");
            new Notice("No files in scope");
            return;
        }
        const replacement = this.getEffectiveReplacement();
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

    private async replaceAllInSelection(regex: RegExp) {
        const sel = this.getActiveSelectionRanges();
        if (!sel) {
            this.setStatus("No active markdown editor");
            new Notice("Open a markdown file first");
            return;
        }
        if (sel.ranges.length === 0) {
            this.setStatus("No text selected");
            new Notice("Select some text first");
            return;
        }
        const editor = sel.view.editor;
        const replacement = this.getEffectiveReplacement();
        let total = 0;
        let changedRanges = 0;
        // Process in reverse order so earlier ranges' offsets stay valid.
        for (let i = sel.ranges.length - 1; i >= 0; i--) {
            const range = sel.ranges[i];
            const text = sel.content.slice(range.start, range.end);
            const freshCount = new RegExp(regex.source, regex.flags);
            const m = text.match(freshCount);
            const count = m ? m.length : 0;
            if (count === 0) continue;
            const freshReplace = new RegExp(regex.source, regex.flags);
            const newText = text.replace(freshReplace, replacement);
            editor.replaceRange(
                newText,
                editor.offsetToPos(range.start),
                editor.offsetToPos(range.end)
            );
            total += count;
            changedRanges++;
        }
        this.invalidateMatches();
        const msg = `Replaced ${total} match${total === 1 ? "" : "es"} in ${changedRanges} selection${changedRanges === 1 ? "" : "s"}`;
        this.setStatus(msg);
        new Notice(msg);
        this.resultsEl.empty();
    }

    private async navigateToMatch(match: RegexMatch) {
        try {
            const data = await this.plugin.app.vault.cachedRead(match.file);
            if (
                data.slice(match.index, match.index + match.length) !==
                match.text
            ) {
                this.setStatus(
                    "Match location has shifted — re-run the search"
                );
                new Notice("Match location changed — please re-run search");
                this.invalidateMatches();
                return;
            }
        } catch {
            this.setStatus("File unavailable");
            return;
        }
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

    async dryRun() {
        if (!this.plugin.settings.findPattern) {
            this.setStatus("Enter a pattern");
            return;
        }
        this.recordHistory();
        const matches = await this.ensureMatches(true);
        const template = this.getEffectiveReplacement();
        const items: DryRunItem[] = matches.map((m) => {
            const replaced = expandReplacementTemplate(
                template,
                m.text,
                m.groupCaptures,
                m.namedCaptures
            );
            return {
                match: m,
                replacedText: replaced,
                multiline:
                    m.text.includes("\n") || replaced.includes("\n"),
            };
        });
        const fileCount = new Set(items.map((i) => i.match.file.path)).size;
        this.setStatus(
            `Dry run: ${items.length} match${items.length === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"} — nothing changed`
        );
        this.renderDryRun(items);
    }

    private renderDryRun(items: DryRunItem[]) {
        this.resultsEl.empty();
        if (items.length === 0) {
            this.resultsEl.createDiv({
                cls: "gr-no-results",
                text: "No matches. Nothing would be replaced.",
            });
            return;
        }
        const RENDER_CAP = 1000;
        const truncated = items.length > RENDER_CAP;
        const slice = truncated ? items.slice(0, RENDER_CAP) : items;
        const byFile = new Map<
            string,
            { file: TFile; items: DryRunItem[] }
        >();
        for (const it of slice) {
            let entry = byFile.get(it.match.file.path);
            if (!entry) {
                entry = { file: it.match.file, items: [] };
                byFile.set(it.match.file.path, entry);
            }
            entry.items.push(it);
        }
        for (const { file, items: fileItems } of byFile.values()) {
            const group = this.resultsEl.createDiv({ cls: "gr-file-group" });
            const header = group.createDiv({ cls: "gr-file-header" });
            header.createSpan({ cls: "gr-file-path", text: file.path });
            header.createSpan({
                cls: "gr-file-count",
                text: `${fileItems.length} would change`,
            });
            for (const it of fileItems) {
                const block = group.createDiv({ cls: "gr-dry-block" });
                block.createDiv({
                    cls: "gr-line-num",
                    text: `line ${it.match.line + 1}, col ${it.match.col + 1}`,
                });
                const before = block.createDiv({
                    cls: "gr-dry-row gr-dry-before",
                });
                before.createSpan({ cls: "gr-dry-marker", text: "−" });
                const after = block.createDiv({
                    cls: "gr-dry-row gr-dry-after",
                });
                after.createSpan({ cls: "gr-dry-marker", text: "+" });

                if (!it.multiline) {
                    const line = it.match.lineContext;
                    const col = it.match.col;
                    const end = col + it.match.length;
                    before.createSpan({
                        cls: "gr-dry-text",
                        text: line.slice(0, col),
                    });
                    before.createSpan({
                        cls: "gr-matched",
                        text: line.slice(col, end),
                    });
                    before.createSpan({
                        cls: "gr-dry-text",
                        text: line.slice(end),
                    });
                    after.createSpan({
                        cls: "gr-dry-text",
                        text: line.slice(0, col),
                    });
                    after.createSpan({
                        cls: "gr-matched gr-dry-replacement",
                        text: it.replacedText,
                    });
                    after.createSpan({
                        cls: "gr-dry-text",
                        text: line.slice(end),
                    });
                } else {
                    before.createSpan({
                        cls: "gr-matched gr-dry-multiline",
                        text: it.match.text,
                    });
                    after.createSpan({
                        cls: "gr-matched gr-dry-replacement gr-dry-multiline",
                        text: it.replacedText,
                    });
                }

                block.addEventListener("click", () =>
                    this.navigateToMatch(it.match)
                );
            }
        }
        if (truncated) {
            this.resultsEl.createDiv({
                cls: "gr-no-results",
                text: `…and ${items.length - RENDER_CAP} more not shown`,
            });
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

class SavePairModal extends Modal {
    private readonly pairs: SavedPair[];
    private readonly find: string;
    private readonly replace: string;
    private readonly flags: {
        flagI: boolean;
        flagM: boolean;
        flagS: boolean;
        flagU: boolean;
    };
    private readonly onSubmit: (name: string) => void;
    private readonly existingNames: Set<string>;
    private inputEl!: HTMLInputElement;
    private saveBtn!: HTMLButtonElement;
    private listEl: HTMLElement | null = null;

    constructor(
        app: App,
        pairs: SavedPair[],
        find: string,
        replace: string,
        flags: {
            flagI: boolean;
            flagM: boolean;
            flagS: boolean;
            flagU: boolean;
        },
        onSubmit: (name: string) => void
    ) {
        super(app);
        this.pairs = pairs;
        this.find = find;
        this.replace = replace;
        this.flags = flags;
        this.onSubmit = onSubmit;
        this.existingNames = new Set(pairs.map((p) => p.name));
    }

    onOpen() {
        this.titleEl.setText("Save find/replace pair");
        const content = this.contentEl;
        content.addClass("gr-save-modal");

        const preview = content.createDiv({ cls: "gr-save-preview" });
        const findRow = preview.createDiv();
        findRow.createSpan({ cls: "gr-save-label", text: "Find: " });
        findRow.createSpan({
            cls: "gr-save-value",
            text: this.find || "(empty)",
        });
        const replaceRow = preview.createDiv();
        replaceRow.createSpan({
            cls: "gr-save-label",
            text: "Replace: ",
        });
        replaceRow.createSpan({
            cls: "gr-save-value",
            text: this.replace || "(empty)",
        });
        const flagLetters =
            (this.flags.flagI ? "i" : "") +
            (this.flags.flagM ? "m" : "") +
            (this.flags.flagS ? "s" : "") +
            (this.flags.flagU ? "u" : "");
        const flagsRow = preview.createDiv();
        flagsRow.createSpan({ cls: "gr-save-label", text: "Flags: " });
        flagsRow.createSpan({
            cls: "gr-save-value",
            text: flagLetters || "(none)",
        });

        if (this.pairs.length > 0) {
            content.createEl("p", {
                cls: "gr-save-hint",
                text: "Click an existing pair to overwrite it, or type a new name below.",
            });
            this.listEl = content.createDiv({ cls: "gr-save-list" });
            for (const pair of this.pairs) {
                const item = this.listEl.createDiv({ cls: "gr-save-item" });
                item.createSpan({
                    cls: "gr-save-item-name",
                    text: pair.name,
                });
                const pairFlags =
                    (pair.flagI ? "i" : "") +
                    (pair.flagM ? "m" : "") +
                    (pair.flagS ? "s" : "") +
                    (pair.flagU ? "u" : "");
                const hasFlagMeta =
                    pair.flagI !== undefined ||
                    pair.flagM !== undefined ||
                    pair.flagS !== undefined ||
                    pair.flagU !== undefined;
                const snippet =
                    pair.find.length > 40
                        ? pair.find.slice(0, 39) + "…"
                        : pair.find;
                const previewText = hasFlagMeta && pairFlags
                    ? `${snippet}  /${pairFlags}`
                    : snippet;
                item.createSpan({
                    cls: "gr-save-item-preview",
                    text: previewText,
                });
                item.addEventListener("click", () => {
                    this.inputEl.value = pair.name;
                    this.highlightItem(item);
                    this.updateSaveLabel();
                    this.inputEl.focus();
                });
            }
        }

        const nameLabel = content.createEl("label", {
            cls: "gr-save-name-label",
            text: "Name",
        });
        this.inputEl = nameLabel.createEl("input", {
            type: "text",
            cls: "gr-prompt-input",
        });
        this.inputEl.placeholder = "Pair name";
        this.inputEl.addEventListener("input", () => {
            this.syncListSelection();
            this.updateSaveLabel();
        });
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.submit();
            } else if (e.key === "Escape") {
                this.close();
            }
        });
        setTimeout(() => this.inputEl.focus(), 0);

        const btnRow = content.createDiv({ cls: "gr-prompt-buttons" });
        const cancel = btnRow.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        this.saveBtn = btnRow.createEl("button", {
            text: "Save",
            cls: "mod-cta",
        });
        this.saveBtn.addEventListener("click", () => this.submit());
        this.updateSaveLabel();
    }

    private highlightItem(selected: HTMLElement) {
        if (!this.listEl) return;
        const items = this.listEl.querySelectorAll(".gr-save-item");
        items.forEach((el) => el.removeClass("is-selected"));
        selected.addClass("is-selected");
    }

    private syncListSelection() {
        if (!this.listEl) return;
        const name = this.inputEl.value.trim();
        const items = this.listEl.querySelectorAll(
            ".gr-save-item"
        ) as NodeListOf<HTMLElement>;
        items.forEach((el) => {
            const itemName = el.querySelector(".gr-save-item-name")?.textContent;
            if (itemName === name) el.addClass("is-selected");
            else el.removeClass("is-selected");
        });
    }

    private updateSaveLabel() {
        const name = this.inputEl.value.trim();
        const overwriting = !!name && this.existingNames.has(name);
        this.saveBtn.setText(overwriting ? "Overwrite" : "Save");
        if (overwriting) {
            this.saveBtn.removeClass("mod-cta");
            this.saveBtn.addClass("mod-warning");
        } else {
            this.saveBtn.removeClass("mod-warning");
            this.saveBtn.addClass("mod-cta");
        }
        this.saveBtn.disabled = !name;
    }

    private submit() {
        const name = this.inputEl.value.trim();
        if (!name) return;
        this.close();
        this.onSubmit(name);
    }

    onClose() {
        this.contentEl.empty();
    }
}

class PromptModal extends Modal {
    private readonly title: string;
    private readonly placeholder: string;
    private readonly defaultValue: string;
    private readonly onSubmit: (value: string) => void;
    private inputEl!: HTMLInputElement;

    constructor(
        app: App,
        title: string,
        placeholder: string,
        defaultValue: string,
        onSubmit: (value: string) => void
    ) {
        super(app);
        this.title = title;
        this.placeholder = placeholder;
        this.defaultValue = defaultValue;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        this.titleEl.setText(this.title);
        this.inputEl = this.contentEl.createEl("input", {
            type: "text",
            cls: "gr-prompt-input",
        });
        this.inputEl.placeholder = this.placeholder;
        this.inputEl.value = this.defaultValue;
        this.inputEl.focus();
        this.inputEl.select();
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.submit();
            } else if (e.key === "Escape") {
                this.close();
            }
        });
        const btnRow = this.contentEl.createDiv({ cls: "gr-prompt-buttons" });
        const cancel = btnRow.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        const ok = btnRow.createEl("button", {
            text: "Save",
            cls: "mod-cta",
        });
        ok.addEventListener("click", () => this.submit());
    }

    private submit() {
        const value = this.inputEl.value;
        this.close();
        this.onSubmit(value);
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ConfirmModal extends Modal {
    private readonly message: string;
    private readonly confirmLabel: string;
    private readonly onConfirm: () => void;

    constructor(
        app: App,
        message: string,
        confirmLabel: string,
        onConfirm: () => void
    ) {
        super(app);
        this.message = message;
        this.confirmLabel = confirmLabel;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        this.contentEl.createEl("p", { text: this.message });
        const btnRow = this.contentEl.createDiv({ cls: "gr-prompt-buttons" });
        const cancel = btnRow.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        const confirm = btnRow.createEl("button", {
            text: this.confirmLabel,
            cls: "mod-warning",
        });
        confirm.addEventListener("click", () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class GlobalRegexSettingTab extends PluginSettingTab {
    plugin: GlobalRegexPlugin;

    constructor(app: App, plugin: GlobalRegexPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("History limit")
            .setDesc(
                `Maximum number of recent find and replace strings to remember (per list). Range ${HISTORY_LIMIT_MIN}–${HISTORY_LIMIT_MAX}. Lowering this trims existing history.`
            )
            .addSlider((slider) =>
                slider
                    .setLimits(HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX, 1)
                    .setValue(
                        Math.max(
                            HISTORY_LIMIT_MIN,
                            Math.min(
                                HISTORY_LIMIT_MAX,
                                this.plugin.settings.historyLimit ||
                                    HISTORY_LIMIT_DEFAULT
                            )
                        )
                    )
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        const clamped = Math.max(
                            HISTORY_LIMIT_MIN,
                            Math.min(HISTORY_LIMIT_MAX, value)
                        );
                        this.plugin.settings.historyLimit = clamped;
                        if (
                            this.plugin.settings.findHistory.length > clamped
                        ) {
                            this.plugin.settings.findHistory.length = clamped;
                        }
                        if (
                            this.plugin.settings.replaceHistory.length >
                            clamped
                        ) {
                            this.plugin.settings.replaceHistory.length =
                                clamped;
                        }
                        await this.plugin.saveSettings();
                    })
            );
    }
}
