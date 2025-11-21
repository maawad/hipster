import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HipCompiler, AssemblyMatch } from './hipCompiler';
import { HighlightManager } from './highlighting';
import { logger } from './logger';
import { LineMappingBuilder, LineMapping } from './lineMapping';

interface DiffState {
    match1: AssemblyMatch;
    match2: AssemblyMatch;
    index1: number;
    index2: number;
}

export class AssemblyViewerPanel {
    public static currentPanel: AssemblyViewerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _compiler: HipCompiler;
    private _highlightManager: HighlightManager;
    private _currentDocument: vscode.TextDocument | undefined;
    private _matches: AssemblyMatch[] = [];
    private _selectedMatch: AssemblyMatch | undefined;
    private _lineMapping: LineMapping = { sourceToAsm: new Map(), asmToSource: new Map() };
    private _mappingBuilder: LineMappingBuilder = new LineMappingBuilder();
    private static _isProgrammaticSelection: boolean = false;
    private _diffState: DiffState | undefined;

    public static isProgrammaticSelection(): boolean {
        return AssemblyViewerPanel._isProgrammaticSelection;
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        compiler: HipCompiler,
        document: vscode.TextDocument,
        highlightManager: HighlightManager,
        sourceLine?: number
    ) {
        const column = vscode.ViewColumn.Beside;

        if (AssemblyViewerPanel.currentPanel) {
            AssemblyViewerPanel.currentPanel._panel.reveal(column);
            AssemblyViewerPanel.currentPanel.updateAssembly(document, sourceLine);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'hipster',
            'Hipster',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        // Set custom icon for the panel
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.png');

        AssemblyViewerPanel.currentPanel = new AssemblyViewerPanel(
            panel,
            extensionUri,
            compiler,
            document,
            highlightManager
        );
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        compiler: HipCompiler,
        document: vscode.TextDocument,
        highlightManager: HighlightManager
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._compiler = compiler;
        this._highlightManager = highlightManager;
        this._currentDocument = document;

        this.updateAssembly(document);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'highlightSource':
                        await this.highlightSourceFromAssembly(message.line);
                        break;
                    case 'selectMatch':
                        await this.selectMatch(message.fileIndex, message.kernelIndex);
                        break;
                    case 'refresh':
                        await this.updateAssembly(this._currentDocument);
                        break;
                    case 'compare':
                        await this.showComparePicker();
                        break;
                    case 'exitDiff':
                        this._diffState = undefined;
                        await this.updateAssembly(this._currentDocument);
                        break;
                    case 'highlightSourceFromDiff':
                        await this.highlightSourceFromDiff(message.line, message.side);
                        break;
                    case 'openAssemblyFile':
                        await this.openAssemblyFile(message.filePath);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Register callback for source highlighting
        this._highlightManager.registerAssemblyHighlightCallback((lines) => {
            this._panel.webview.postMessage({
                command: 'highlightAssembly',
                lines: lines
            });
        });
    }

    private async updateAssembly(document: vscode.TextDocument | undefined, sourceLine?: number) {
        if (!document) {
            return;
        }

        this._currentDocument = document;
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspaceFolder = workspaceFolders[0].uri.fsPath;
        const sourceFile = document.uri.fsPath;
        const sourceFileName = path.basename(sourceFile);

        logger.log(`Finding assemblies for ${sourceFileName}`);

        // Find all matching assemblies
        this._matches = await this._compiler.findMatchingAssemblies(
            workspaceFolder,
            sourceFileName,
            sourceLine || 0
        );

        if (this._matches.length === 0) {
            vscode.window.showWarningMessage(
                `No assembly found for ${sourceFileName}. Make sure the project is built with debug info (-g flag).`
            );
            this._panel.webview.html = this.getNoAssemblyContent();
            return;
        }

        // Sort matches by timestamp (most recent first) so default selection is latest
        this._matches.sort((a, b) => {
            try {
                const statsA = fs.statSync(a.assemblyFile);
                const statsB = fs.statSync(b.assemblyFile);
                return statsB.mtime.getTime() - statsA.mtime.getTime();
            } catch (e) {
                return 0;
            }
        });

        // Group matches by source file
        const fileGroups = this.groupMatchesByFile();

        // Select first match by default (which is now the most recent)
        if (!this._selectedMatch && this._matches.length > 0) {
            this._selectedMatch = this._matches[0];
            this._lineMapping = this._mappingBuilder.buildMapping(
                this._selectedMatch.assemblyContent,
                this.extractSourceFilesFromAssembly(this._selectedMatch.assemblyContent)
            );
        }

        this._panel.webview.html = await this.getWebviewContent(fileGroups);

        // Highlight the current source line if provided
        if (sourceLine !== undefined && this._selectedMatch) {
            await this.highlightAssemblyForSourceLine(document, sourceLine);
        }
    }

    private groupMatchesByFile(): Map<string, AssemblyMatch[]> {
        const groups = new Map<string, AssemblyMatch[]>();

        for (const match of this._matches) {
            // Group by source file basename (e.g., put.hip, message_passing.hip)
            const sourceFileName = path.basename(match.sourceFile);

            if (!groups.has(sourceFileName)) {
                groups.set(sourceFileName, []);
            }
            groups.get(sourceFileName)!.push(match);
        }

        return groups;
    }

    private extractSourceFilesFromAssembly(content: string): Map<number, string> {
        const sourceFiles = new Map<number, string>();
        const lines = content.split('\n');

        for (const line of lines) {
            const format1Match = line.match(/\.file\s+(\d+)\s+"([^"]+)"\s+"([^"]+)"/);
            if (format1Match) {
                const fileId = parseInt(format1Match[1]);
                const directory = format1Match[2];
                const filename = format1Match[3];
                sourceFiles.set(fileId, path.join(directory, filename));
                continue;
            }

            const format2Match = line.match(/\.file\s+(\d+)\s+"([^"]+)"/);
            if (format2Match) {
                const fileId = parseInt(format2Match[1]);
                sourceFiles.set(fileId, format2Match[2]);
            }
        }

        return sourceFiles;
    }

    private async selectMatch(fileIndex: number, kernelIndex: number) {
        const fileGroups = this.groupMatchesByFile();
        const files = Array.from(fileGroups.keys());

        if (fileIndex < 0 || fileIndex >= files.length) {
            return;
        }

        const fileKey = files[fileIndex];
        const matchesForFile = fileGroups.get(fileKey) || [];

        if (kernelIndex < 0 || kernelIndex >= matchesForFile.length) {
            return;
        }

        this._selectedMatch = matchesForFile[kernelIndex];
        this._lineMapping = this._mappingBuilder.buildMapping(
            this._selectedMatch.assemblyContent,
            this.extractSourceFilesFromAssembly(this._selectedMatch.assemblyContent)
        );

        // Refresh the view
        this._panel.webview.html = await this.getWebviewContent(fileGroups);
    }

    public async highlightAssemblyForSourceLine(document: vscode.TextDocument, sourceLine: number) {
        if (!this._selectedMatch) {
            return;
        }

        const assemblyLines = this._mappingBuilder.getAssemblyLines(
            this._lineMapping,
            document.uri.fsPath,
            sourceLine
        );

        if (assemblyLines.length > 0) {
            this._panel.webview.postMessage({
                command: 'highlightAssembly',
                lines: assemblyLines
            });
        }
    }

    private async highlightSourceFromAssembly(assemblyLine: number) {
        if (!this._selectedMatch) {
            logger.log(`[Assembly Click] No selected match`);
            return;
        }

        logger.log(`[Assembly Click] Line ${assemblyLine} clicked in kernel ${this._selectedMatch.kernelSymbol}`);
        const sourceLocation = this._mappingBuilder.getSourceLocation(this._lineMapping, assemblyLine);

        if (sourceLocation) {
            logger.log(`[Assembly Click] Mapped to: ${sourceLocation.file}:${sourceLocation.line}`);
            AssemblyViewerPanel._isProgrammaticSelection = true;
            this._highlightManager.highlightFromAssembly(sourceLocation.file, sourceLocation.line);

            setTimeout(() => {
                AssemblyViewerPanel._isProgrammaticSelection = false;
            }, 200);
        } else {
            logger.log(`[Assembly Click] No source mapping found for assembly line ${assemblyLine}`);
        }
    }

    private async getWebviewContent(fileGroups: Map<string, AssemblyMatch[]>): Promise<string> {
        const files = Array.from(fileGroups.keys());
        const selectedFileIndex = files.findIndex(f =>
            fileGroups.get(f)!.some(m => m === this._selectedMatch)
        );

        const selectedFile = files[selectedFileIndex] || files[0];
        let kernels = fileGroups.get(selectedFile) || [];

        // Sort kernels by timestamp (most recent first)
        kernels = kernels.sort((a, b) => {
            try {
                const statsA = fs.statSync(a.assemblyFile);
                const statsB = fs.statSync(b.assemblyFile);
                return statsB.mtime.getTime() - statsA.mtime.getTime();
            } catch (e) {
                return 0;
            }
        });

        const selectedKernelIndex = kernels.findIndex(k => k === this._selectedMatch);

        // Demangle kernel names for display and add build directory suffix
        const demangledKernels = await Promise.all(
            kernels.map(async (k) => ({
                mangled: k.kernelSymbol,
                demangled: await this._compiler.demangleSymbol(k.kernelSymbol),
                buildDirectory: k.buildDirectory,
                displayName: `${await this._compiler.demangleSymbol(k.kernelSymbol)} (${k.buildDirectory})`
            }))
        );

        // Find all versions of this kernel and determine which is latest by timestamp
        const sameKernelMatches = this._matches.filter(m =>
            m.kernelSymbol === this._selectedMatch?.kernelSymbol
        );
        const hasOtherVersions = sameKernelMatches.length > 1;

        let isLatest = true;
        let latestBuildDir = this._selectedMatch?.buildDirectory || '';
        let outdatedWarning = '';

        if (hasOtherVersions && this._selectedMatch) {
            // Get timestamps for all versions
            const matchesWithTimestamps = sameKernelMatches.map(m => {
                try {
                    const stats = fs.statSync(m.assemblyFile);
                    return { match: m, timestamp: stats.mtime.getTime() };
                } catch (e) {
                    return { match: m, timestamp: 0 };
                }
            });

            // Sort by timestamp descending (newest first)
            matchesWithTimestamps.sort((a, b) => b.timestamp - a.timestamp);

            // Check if current match is the latest
            const latestMatch = matchesWithTimestamps[0].match;
            isLatest = latestMatch.assemblyFile === this._selectedMatch.assemblyFile;
            latestBuildDir = latestMatch.buildDirectory;

            if (!isLatest) {
                outdatedWarning = `
                    <div class="outdated-warning">
                        ⚠️ This is an older version from "${this._selectedMatch.buildDirectory}". Source code may have changed. Latest version is in "${latestBuildDir}".
                    </div>
                `;
            }
        }

        // Show compare button if there are other versions
        const showCompareButton = hasOtherVersions;

        // Extract only the lines for this kernel from the full assembly
        const assemblyLines = this._selectedMatch ?
            this._selectedMatch.assemblyContent.split('\n').slice(
                this._selectedMatch.startLine,
                this._selectedMatch.endLine + 1
            ) : [];

        // Get assembly file info
        let fileTimestamp = '';
        let fullFilePath = '';
        if (this._selectedMatch) {
            fullFilePath = this._selectedMatch.assemblyFile;
            try {
                const stats = fs.statSync(fullFilePath);
                fileTimestamp = stats.mtime.toLocaleString();
            } catch (e) {
                fileTimestamp = 'Unknown';
            }
        }

        const demangledKernelName = this._selectedMatch ?
            await this._compiler.demangleSymbol(this._selectedMatch.kernelSymbol) : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://unpkg.com/@vscode/codicons@latest/dist/codicon.css" rel="stylesheet" />
    <title>Hipster</title>
    <style>
        body {
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            padding: 0;
            margin: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .header {
            position: sticky;
            top: 0;
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            z-index: 1000;
        }
        .dropdown-row {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            align-items: center;
        }
        .spacer {
            flex: 1;
        }
        .action-buttons {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        select {
            flex: 1;
            padding: 5px 8px;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 2px;
            font-family: inherit;
            font-size: 12px;
            height: 32px;
        }

        select:hover {
            background-color: var(--vscode-dropdown-listBackground);
        }

        select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        /* Style dropdown options (important for Windows) */
        select option {
            background-color: var(--vscode-dropdown-background) !important;
            color: var(--vscode-dropdown-foreground) !important;
        }

        select option:hover,
        select option:checked {
            background-color: var(--vscode-list-activeSelectionBackground) !important;
            color: var(--vscode-list-activeSelectionForeground) !important;
        }

        #kernelSelect, #fileSelect {
            max-width: 250px;
            text-overflow: ellipsis;
        }
        .assembly-container {
            padding: 10px;
        }
        .assembly-line {
            display: flex;
            line-height: 1.5;
            cursor: pointer;
            padding: 2px 0;
        }
        .assembly-line:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .line-number {
            color: var(--vscode-editorLineNumber-foreground);
            text-align: right;
            padding-right: 10px;
            min-width: 50px;
            user-select: none;
        }
        .line-content {
            flex: 1;
            white-space: pre;
        }
        .highlight {
            background-color: var(--vscode-editor-selectionBackground);
            border-left: 3px solid var(--vscode-editor-selectionHighlightBorder);
        }
        /* Syntax highlighting for assembly - using VSCode theme colors */
        .comment {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .directive {
            color: var(--vscode-textLink-foreground);
            font-weight: bold;
        }
        .instruction {
            color: var(--vscode-textPreformat-foreground);
            font-weight: 500;
        }
        .register {
            color: var(--vscode-editor-foreground);
            opacity: 0.9;
        }
        .immediate {
            color: var(--vscode-charts-green);
        }
        .label {
            color: var(--vscode-symbolIcon-functionForeground);
            font-weight: bold;
        }
        .refresh-btn, .compare-btn {
            padding: 5px 15px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            margin-left: 5px;
        }
        .refresh-btn:hover, .compare-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .outdated-warning {
            background-color: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            color: var(--vscode-inputValidation-warningForeground);
            padding: 10px;
            margin: 10px;
            border-radius: 3px;
            font-size: 13px;
        }
        .kernel-info {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .kernel-title-display {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            font-weight: bold;
            color: var(--vscode-editor-foreground);
            flex: 1;
        }
        .kernel-timestamp {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
        }
        .assembly-file-path {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 11px;
            color: var(--vscode-textLink-foreground);
            opacity: 0.7;
            cursor: pointer;
            text-decoration: underline;
            text-decoration-style: dotted;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 400px;
        }
        .assembly-file-path:hover {
            opacity: 1;
            text-decoration-style: solid;
        }
        .icon-btn {
            padding: 6px;
            background-color: transparent;
            border: none;
            cursor: pointer;
            color: var(--vscode-foreground);
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .icon-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .filter-menu {
            position: fixed;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 2px;
            padding: 8px;
            z-index: 1000;
            min-width: 300px;
            max-height: 500px;
            overflow-y: auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }
        .filter-section {
            margin-bottom: 12px;
        }
        .filter-section-title {
            font-weight: bold;
            margin-bottom: 6px;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 4px;
        }
        .filter-menu label {
            display: block;
            padding: 4px 0;
            cursor: pointer;
            color: var(--vscode-dropdown-foreground);
            user-select: none;
        }
        .filter-menu label:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .filter-menu input[type="checkbox"] {
            margin-right: 8px;
            cursor: pointer;
        }
        .filter-search-container {
            padding: 4px 0 8px 0;
        }
        .filter-search-container input {
            width: 100%;
            padding: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
        }
        .filter-actions {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }
        .filter-action-btn {
            flex: 1;
            padding: 4px;
            font-size: 11px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            cursor: pointer;
        }
        .filter-action-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .filter-hidden {
            display: none !important;
        }
        #instructionList {
            max-height: 300px;
            overflow-y: auto;
            display: block;
        }
        #instructionList label {
            display: block !important;
            padding: 4px 0 !important;
            white-space: nowrap;
        }
        .search-bar {
            position: sticky;
            top: 44px;
            background-color: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            padding: 6px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            z-index: 999;
        }
        .search-bar input {
            flex: 1;
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-family: inherit;
        }
        .search-nav-btn {
            padding: 4px 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            cursor: pointer;
            font-size: 12px;
        }
        .search-nav-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .search-close-btn {
            padding: 4px 8px;
            background-color: transparent;
            color: var(--vscode-foreground);
            border: none;
            cursor: pointer;
            font-size: 16px;
        }
        .search-results {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .search-match {
            background-color: rgba(255, 230, 100, 0.35) !important;
            outline: 2px solid rgba(255, 200, 0, 0.6);
            outline-offset: -2px;
        }
        .search-match-current {
            background-color: rgba(255, 140, 0, 0.5) !important;
            outline: 2px solid rgba(255, 100, 0, 0.9);
            outline-offset: -2px;
        }
        .hidden {
            display: none !important;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="dropdown-row">
            <select id="kernelSelect">
                ${demangledKernels.map((k, i) => `<option value="${i}" ${i === selectedKernelIndex ? 'selected' : ''}>${this.escapeHtml(k.displayName)}</option>`).join('')}
            </select>
            <select id="fileSelect">
                ${files.map((f, i) => `<option value="${i}" ${i === selectedFileIndex ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
            <div class="spacer"></div>
            <div class="action-buttons">
                ${showCompareButton ? '<button class="compare-btn" onclick="compare()">Compare</button>' : ''}
                <button class="refresh-btn" onclick="refresh()">Refresh</button>
                <button class="icon-btn" onclick="toggleSearch()" title="Search in assembly (Ctrl+F)"><i class="codicon codicon-search"></i></button>
                <button class="icon-btn" id="filterBtn" onclick="toggleFilterMenu(event)" title="Filter assembly lines"><i class="codicon codicon-filter"></i></button>
            </div>
        </div>
    </div>
    <div class="filter-menu" id="filterMenu" style="display: none;">
        <div class="filter-section">
            <div class="filter-section-title">General</div>
            <label><input type="checkbox" id="filterDirectives" onchange="applyFilters()"> Hide directives</label>
            <label><input type="checkbox" id="filterComments" onchange="applyFilters()"> Hide comments</label>
            <label><input type="checkbox" id="filterEmpty" onchange="applyFilters()"> Hide empty lines</label>
        </div>
        <div class="filter-section" id="instructionFilters">
            <div class="filter-section-title">Instructions</div>
            <div class="filter-search-container">
                <input type="text" id="instrSearchBox" placeholder="Search instructions..." onkeyup="filterInstructionList()" />
            </div>
            <div class="filter-actions">
                <button class="filter-action-btn" onclick="selectAllInstructions()">Select All</button>
                <button class="filter-action-btn" onclick="selectNoneInstructions()">Select None</button>
            </div>
            <div id="instructionList">
                <!-- Dynamic instruction filters will be inserted here -->
            </div>
        </div>
    </div>
    <div class="search-bar" id="searchBar" style="display: none;">
        <input type="text" id="searchInput" placeholder="Find in assembly..." />
        <button class="search-nav-btn" onclick="findPrevious()" title="Previous match (Shift+F3)">▲</button>
        <button class="search-nav-btn" onclick="findNext()" title="Next match (F3)">▼</button>
        <span id="searchResults" class="search-results"></span>
        <button class="search-close-btn" onclick="toggleSearch()">✕</button>
    </div>
    ${outdatedWarning}
    <div class="kernel-info">
        <span class="kernel-title-display">${this.escapeHtml(demangledKernelName)}</span>
        <span class="kernel-timestamp">${this.escapeHtml(fileTimestamp)}</span>
        <span class="assembly-file-path" title="${this.escapeHtml(fullFilePath)} - Click to open file" onclick="openAssemblyFile('${this.escapeHtml(fullFilePath)}')">${this.escapeHtml(fullFilePath)}</span>
    </div>
    <div class="assembly-container">
        ${assemblyLines.map((line, i) => {
            const actualLineNumber = (this._selectedMatch?.startLine || 0) + i;
            const filterClasses = this.getFilterClasses(line);
            return `
                <div class="assembly-line ${filterClasses}" data-line="${actualLineNumber}">
                    <span class="line-number">${actualLineNumber + 1}</span>
                    <span class="line-content">${this.highlightAssemblyLine(line)}</span>
                </div>`;
        }).join('')}
    </div>
    <script>
        const vscode = acquireVsCodeApi();

        document.getElementById('kernelSelect').addEventListener('change', (e) => {
            const fileIndex = parseInt(document.getElementById('fileSelect').value);
            const kernelIndex = parseInt(e.target.value);
            vscode.postMessage({
                command: 'selectMatch',
                fileIndex: fileIndex,
                kernelIndex: kernelIndex
            });
        });

        document.getElementById('fileSelect').addEventListener('change', (e) => {
            const fileIndex = parseInt(e.target.value);
            document.getElementById('kernelSelect').selectedIndex = 0;
            vscode.postMessage({
                command: 'selectMatch',
                fileIndex: fileIndex,
                kernelIndex: 0
            });
        });

        // Click handler for assembly lines - use data-line attribute which preserves original line numbers
        document.querySelectorAll('.assembly-line').forEach(line => {
            line.addEventListener('click', () => {
                const lineNum = parseInt(line.dataset.line);
                vscode.postMessage({
                    command: 'highlightSource',
                    line: lineNum
                });
            });
        });

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function compare() {
            vscode.postMessage({ command: 'compare' });
        }

        function openAssemblyFile(filePath) {
            vscode.postMessage({
                command: 'openAssemblyFile',
                filePath: filePath
            });
        }

        // Filter functionality
        function toggleFilterMenu(event) {
            const menu = document.getElementById('filterMenu');
            if (menu.style.display === 'none') {
                const btn = event?.target?.closest('.icon-btn') || event?.target;
                if (btn) {
                    const rect = btn.getBoundingClientRect();
                    menu.style.top = (rect.bottom + 4) + 'px';
                    menu.style.left = 'auto';
                    menu.style.right = (window.innerWidth - rect.right) + 'px';
                }
                menu.style.display = 'block';
            } else {
                menu.style.display = 'none';
            }
        }

        function buildInstructionFilters() {
            const instructionCounts = {};

            document.querySelectorAll('.assembly-line').forEach(line => {
                line.classList.forEach(cls => {
                    if (cls.startsWith('instr-')) {
                        const instr = cls.substring(6);
                        instructionCounts[instr] = (instructionCounts[instr] || 0) + 1;
                    }
                });
            });

            // Filter out instructions starting with underscore or semicolon and sort
            const sortedInstructions = Object.keys(instructionCounts)
                .filter(instr => !instr.startsWith('_') && !instr.startsWith(';'))
                .sort();
            const instructionListDiv = document.getElementById('instructionList');
            if (instructionListDiv && sortedInstructions.length > 0) {
                let html = '';
                sortedInstructions.forEach(instr => {
                    const count = instructionCounts[instr];
                    const id = 'filter-instr-' + instr.replace(/[^a-z0-9]/g, '_');
                    html += '<label data-instr-name="' + instr.toLowerCase() + '"><input type="checkbox" id="' + id + '" data-instr="' + instr + '" onchange="applyFilters()"> ' + instr + ' (' + count + ')</label>';
                });
                instructionListDiv.innerHTML = html;
            }

            const titleDiv = document.querySelector('#instructionFilters .filter-section-title');
            if (titleDiv) {
                titleDiv.textContent = 'Instructions (' + sortedInstructions.length + ')';
            }
        }

        function filterInstructionList() {
            const searchText = document.getElementById('instrSearchBox').value.toLowerCase();
            const labels = document.querySelectorAll('#instructionList label');

            labels.forEach(label => {
                const instrName = label.getAttribute('data-instr-name');
                if (instrName.includes(searchText)) {
                    label.classList.remove('filter-hidden');
                } else {
                    label.classList.add('filter-hidden');
                }
            });
        }

        function selectAllInstructions() {
            const checkboxes = document.querySelectorAll('#instructionList label:not(.filter-hidden) input[type="checkbox"]');
            checkboxes.forEach(cb => { cb.checked = true; });
            applyFilters();
        }

        function selectNoneInstructions() {
            const checkboxes = document.querySelectorAll('#instructionList input[type="checkbox"]');
            checkboxes.forEach(cb => { cb.checked = false; });
            applyFilters();
        }

        function applyFilters() {
            const hideDirectives = document.getElementById('filterDirectives').checked;
            const hideComments = document.getElementById('filterComments').checked;
            const hideEmpty = document.getElementById('filterEmpty').checked;

            const instrCheckboxes = document.querySelectorAll('#instructionList input[type="checkbox"]');
            const hiddenInstructions = new Set();
            instrCheckboxes.forEach(cb => {
                if (cb.checked) {
                    hiddenInstructions.add('instr-' + cb.getAttribute('data-instr'));
                }
            });

            document.querySelectorAll('.assembly-line').forEach(line => {
                line.classList.remove('hidden');

                let isHidden = false;
                if (hideDirectives && line.classList.contains('filter-directive')) {
                    line.classList.add('hidden');
                    isHidden = true;
                }
                if (hideComments && line.classList.contains('filter-comment')) {
                    line.classList.add('hidden');
                    isHidden = true;
                }
                if (hideEmpty && line.classList.contains('filter-empty')) {
                    line.classList.add('hidden');
                    isHidden = true;
                }

                if (!isHidden) {
                    line.classList.forEach(cls => {
                        if (hiddenInstructions.has(cls)) {
                            line.classList.add('hidden');
                            isHidden = true;
                        }
                    });
                }
            });
        }

        // Search functionality
        let searchMatches = [];
        let currentMatchIndex = -1;

        function toggleSearch() {
            const searchBar = document.getElementById('searchBar');
            const searchInput = document.getElementById('searchInput');

            if (searchBar.style.display === 'none') {
                searchBar.style.display = 'flex';
                searchInput.focus();
                searchInput.select();
            } else {
                searchBar.style.display = 'none';
                clearSearch();
            }
        }

        function clearSearch() {
            document.querySelectorAll('.search-match, .search-match-current').forEach(el => {
                el.classList.remove('search-match', 'search-match-current');
            });
            searchMatches = [];
            currentMatchIndex = -1;
            document.getElementById('searchResults').textContent = '';
        }

        function performSearch() {
            const searchText = document.getElementById('searchInput').value;
            clearSearch();

            if (!searchText) return;

            const lines = document.querySelectorAll('.assembly-line .line-content');
            lines.forEach((line, index) => {
                const text = line.textContent;
                if (text.toLowerCase().includes(searchText.toLowerCase())) {
                    line.parentElement.classList.add('search-match');
                    searchMatches.push(line.parentElement);
                }
            });

            if (searchMatches.length > 0) {
                currentMatchIndex = 0;
                highlightCurrentMatch();
                updateSearchResults();
            } else {
                document.getElementById('searchResults').textContent = 'No results';
            }
        }

        function highlightCurrentMatch() {
            searchMatches.forEach((match, index) => {
                if (index === currentMatchIndex) {
                    match.classList.add('search-match-current');
                    match.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    match.classList.remove('search-match-current');
                }
            });
        }

        function updateSearchResults() {
            const resultsText = (currentMatchIndex + 1) + ' of ' + searchMatches.length;
            document.getElementById('searchResults').textContent = resultsText;
        }

        function findNext() {
            if (searchMatches.length === 0) return;
            currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
            highlightCurrentMatch();
            updateSearchResults();
        }

        function findPrevious() {
            if (searchMatches.length === 0) return;
            currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
            highlightCurrentMatch();
            updateSearchResults();
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                toggleSearch();
            } else if (e.key === 'F3') {
                e.preventDefault();
                if (e.shiftKey) {
                    findPrevious();
                } else {
                    findNext();
                }
            } else if (e.key === 'Escape') {
                const searchBar = document.getElementById('searchBar');
                const filterMenu = document.getElementById('filterMenu');
                if (searchBar.style.display !== 'none') {
                    toggleSearch();
                } else if (filterMenu.style.display !== 'none') {
                    toggleFilterMenu();
                }
            }
        });

        document.getElementById('searchInput').addEventListener('input', performSearch);
        document.getElementById('searchInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    findPrevious();
                } else {
                    findNext();
                }
            }
        });

        // Initialize filters after DOM is ready
        setTimeout(() => {
            buildInstructionFilters();
        }, 100);

        // Close filter menu when clicking outside
        document.addEventListener('click', (e) => {
            const filterMenu = document.getElementById('filterMenu');
            const filterBtn = document.getElementById('filterBtn');
            if (filterMenu.style.display !== 'none' &&
                !filterMenu.contains(e.target) &&
                !filterBtn.contains(e.target)) {
                filterMenu.style.display = 'none';
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'highlightAssembly') {
                document.querySelectorAll('.assembly-line').forEach(el => {
                    el.classList.remove('highlight');
                });
                message.lines.forEach(line => {
                    const el = document.querySelector(\`.assembly-line[data-line="\${line}"]\`);
                    if (el) {
                        el.classList.add('highlight');
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                });
            }
        });
    </script>
</body>
</html>`;
    }

    private getNoAssemblyContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hipster</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .warning {
            padding: 20px;
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            background-color: var(--vscode-inputValidation-warningBackground);
            border-radius: 4px;
        }
        h3 {
            margin-top: 0;
        }
        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="warning">
        <h3>⚠️ No Assembly Found</h3>
        <p>No assembly files with debug information were found for this source file.</p>
        <p>To generate assembly with debug info, rebuild your project with:</p>
        <ul>
            <li><code>cmake -DCMAKE_BUILD_TYPE=Debug ..</code></li>
            <li>or add <code>-g</code> flag to HIP compiler options</li>
        </ul>
    </div>
</body>
</html>`;
    }

    /**
     * Apply syntax highlighting to GCN assembly line
     * Uses regex-based token highlighting similar to Trident
     */
    private highlightAssemblyLine(line: string): string {
        let escaped = this.escapeHtml(line);

        // Comments (anything after // or ; or #)
        escaped = escaped.replace(/(\/\/|;|#)(.*)$/, '<span class="comment">$1$2</span>');

        // Directives (start with .)
        escaped = escaped.replace(/^(\s*)(\.\w+)/g, '$1<span class="directive">$2</span>');

        // Instructions (v_ for VALU, s_ for SALU, ds_ for LDS, etc.)
        escaped = escaped.replace(/\b([vs]_\w+|ds_\w+|buffer_\w+|flat_\w+|tbuffer_\w+|image_\w+)\b/g,
            '<span class="instruction">$1</span>');

        // Registers (v[num], s[num], vcc, exec, etc.)
        escaped = escaped.replace(/\b(v\[\d+:\d+\]|v\[\d+\]|s\[\d+:\d+\]|s\[\d+\]|vcc|exec|m0|tma|tba|flat_scratch)\b/g,
            '<span class="register">$1</span>');

        // Immediate values (hex and decimal)
        escaped = escaped.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, '<span class="immediate">$1</span>');

        // Labels (word followed by :)
        escaped = escaped.replace(/^(\s*)(\w+):/g, '$1<span class="label">$2</span>:');

        return escaped;
    }

    private getFilterClasses(line: string): string {
        const trimmed = line.trim();
        const isDirective = trimmed.startsWith('.');
        const isComment = trimmed.startsWith(';') || trimmed.startsWith('//') || trimmed.startsWith('#');
        const isEmpty = trimmed.length === 0;

        const filterClasses = [];
        if (isDirective) {
            filterClasses.push('filter-directive');
        }
        if (isComment) {
            filterClasses.push('filter-comment');
        }
        if (isEmpty) {
            filterClasses.push('filter-empty');
        }

        // Extract instruction name and add as class
        if (!isDirective && !isComment && !isEmpty) {
            const instrMatch = trimmed.match(/^\s*(\w+)/);
            if (instrMatch) {
                const instr = instrMatch[1].toLowerCase();

                // Filter out labels
                const isLabel = trimmed.endsWith(':');

                if (!isLabel) {
                    filterClasses.push('instr-' + instr);
                }
            }
        }

        return filterClasses.join(' ');
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private async showComparePicker() {
        if (!this._selectedMatch) {
            return;
        }

        const currentKernelSymbol = this._selectedMatch.kernelSymbol;
        const currentIndex = this._matches.findIndex(m => m === this._selectedMatch);

        // Find all matches with the same kernel symbol but different build directories
        const compatibleMatches = this._matches
            .map((match, index) => ({ match, index }))
            .filter(({ match, index }) =>
                match.kernelSymbol === currentKernelSymbol &&
                index !== currentIndex
            );

        if (compatibleMatches.length === 0) {
            vscode.window.showInformationMessage('No other versions of this kernel found for comparison');
            return;
        }

        // Sort by timestamp (most recent first)
        compatibleMatches.sort((a, b) => {
            try {
                const statsA = fs.statSync(a.match.assemblyFile);
                const statsB = fs.statSync(b.match.assemblyFile);
                return statsB.mtime.getTime() - statsA.mtime.getTime();
            } catch (e) {
                return 0;
            }
        });

        // Create picker items
        const items = await Promise.all(compatibleMatches.map(async ({ match, index }) => {
            const timestamp = (() => {
                try {
                    const stats = fs.statSync(match.assemblyFile);
                    return stats.mtime.toLocaleString();
                } catch (e) {
                    return '';
                }
            })();
            return {
                label: await this._compiler.demangleSymbol(match.kernelSymbol),
                description: `(${match.buildDirectory})`,
                detail: `${match.assemblyFile} - ${timestamp}`,
                index: index
            };
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a version to compare with'
        });

        if (selected) {
            await this.compareMatches(currentIndex, selected.index);
        }
    }

    private async compareMatches(index1: number, index2: number) {
        const match1 = this._matches[index1];
        const match2 = this._matches[index2];

        logger.log(`Comparing: ${match1.kernelSymbol} [${match1.buildDirectory}] vs [${match2.buildDirectory}]`);

        this._diffState = {
            match1,
            match2,
            index1,
            index2
        };

        this._panel.webview.html = await this.getDiffViewContent(this._diffState);
    }

    private async getDiffViewContent(diffState: DiffState): Promise<string> {
        const { match1, match2 } = diffState;

        // Get the kernel-specific assembly lines for both matches
        const lines1 = match1.assemblyContent.split('\n').slice(match1.startLine, match1.endLine + 1);
        const lines2 = match2.assemblyContent.split('\n').slice(match2.startLine, match2.endLine + 1);

        const maxLines = Math.max(lines1.length, lines2.length);

        let leftHtml = '';
        let rightHtml = '';

        for (let i = 0; i < maxLines; i++) {
            const line1 = lines1[i] || '';
            const line2 = lines2[i] || '';

            const isDifferent = line1 !== line2;
            const diffClass = isDifferent ? 'diff-changed' : '';

            // Actual line numbers in the original files
            const lineNum1 = match1.startLine + i + 1;
            const lineNum2 = match2.startLine + i + 1;

            leftHtml += `<div class="asm-line ${diffClass}" data-line="${match1.startLine + i}" data-side="left" onclick="highlightSource(${match1.startLine + i}, 'left')"><span class="line-number">${lineNum1}</span><span class="asm-content">${this.highlightAssemblyLine(line1 || ' ')}</span></div>\n`;
            rightHtml += `<div class="asm-line ${diffClass}" data-line="${match2.startLine + i}" data-side="right" onclick="highlightSource(${match2.startLine + i}, 'right')"><span class="asm-content">${this.highlightAssemblyLine(line2 || ' ')}</span><span class="line-number">${lineNum2}</span></div>\n`;
        }

        const demangledName = await this._compiler.demangleSymbol(match1.kernelSymbol);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://unpkg.com/@vscode/codicons@latest/dist/codicon.css" rel="stylesheet" />
    <title>Compare: ${demangledName}</title>
    <style>
        body {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 12px;
            padding: 0;
            margin: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .header {
            position: sticky;
            top: 0;
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            z-index: 1000;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .title {
            font-weight: bold;
            font-size: 14px;
        }
        .exit-btn {
            padding: 5px 15px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
        }
        .exit-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .diff-container {
            display: flex;
            height: calc(100vh - 50px);
        }
        .diff-side {
            flex: 1;
            overflow-y: auto;
            overflow-x: auto;
            border-right: 1px solid var(--vscode-panel-border);
            padding: 10px;
        }
        .diff-side:last-child {
            border-right: none;
        }
        .diff-side-header {
            font-weight: bold;
            padding: 5px 0;
            position: sticky;
            top: 0;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 10px;
        }
        .asm-line {
            display: flex;
            line-height: 1.5;
            cursor: pointer;
            padding: 2px 0;
            min-height: 1.5em;
        }
        .asm-line:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .line-number {
            color: var(--vscode-editorLineNumber-foreground);
            text-align: right;
            padding-right: 10px;
            min-width: 50px;
            user-select: none;
        }
        .asm-content {
            flex: 1;
            white-space: pre;
        }
        .diff-changed {
            background-color: var(--vscode-diffEditor-insertedTextBackground);
        }
        /* Syntax Highlighting */
        .comment {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .directive {
            color: var(--vscode-textLink-foreground);
            font-weight: bold;
        }
        .instruction {
            color: var(--vscode-textPreformat-foreground);
            font-weight: 500;
        }
        .register {
            color: var(--vscode-editor-foreground);
            opacity: 0.9;
        }
        .immediate {
            color: var(--vscode-charts-green);
        }
        .label {
            color: var(--vscode-symbolIcon-functionForeground);
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">Compare: ${this.escapeHtml(demangledName)}</div>
        <button class="exit-btn" onclick="exitDiff()">Exit Diff</button>
    </div>
    <div class="diff-container">
        <div class="diff-side" id="leftSide">
            <div class="diff-side-header">${this.escapeHtml(match1.buildDirectory)}</div>
            ${leftHtml}
        </div>
        <div class="diff-side" id="rightSide">
            <div class="diff-side-header">${this.escapeHtml(match2.buildDirectory)}</div>
            ${rightHtml}
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();

        // Synchronized scrolling
        const leftSide = document.getElementById('leftSide');
        const rightSide = document.getElementById('rightSide');
        let isScrolling = false;

        leftSide.addEventListener('scroll', () => {
            if (!isScrolling) {
                isScrolling = true;
                rightSide.scrollTop = leftSide.scrollTop;
                setTimeout(() => isScrolling = false, 50);
            }
        });

        rightSide.addEventListener('scroll', () => {
            if (!isScrolling) {
                isScrolling = true;
                leftSide.scrollTop = rightSide.scrollTop;
                setTimeout(() => isScrolling = false, 50);
            }
        });

        function highlightSource(line, side) {
            vscode.postMessage({
                command: 'highlightSourceFromDiff',
                line: line,
                side: side
            });
        }

        function exitDiff() {
            vscode.postMessage({ command: 'exitDiff' });
        }
    </script>
</body>
</html>`;
    }

    private async highlightSourceFromDiff(assemblyLine: number, side: string) {
        if (!this._diffState) {
            return;
        }

        const match = side === 'left' ? this._diffState.match1 : this._diffState.match2;

        // Build line mapping for this specific match
        const sourceFiles = this.extractSourceFilesFromAssembly(match.assemblyContent);
        const lineMapping = this._mappingBuilder.buildMapping(match.assemblyContent, sourceFiles);

        const sourceLocation = this._mappingBuilder.getSourceLocation(lineMapping, assemblyLine);

        if (sourceLocation) {
            logger.log(`[Diff Click] Line ${assemblyLine} (${side}) mapped to: ${sourceLocation.file}:${sourceLocation.line}`);
            AssemblyViewerPanel._isProgrammaticSelection = true;
            this._highlightManager.highlightFromAssembly(sourceLocation.file, sourceLocation.line);

            setTimeout(() => {
                AssemblyViewerPanel._isProgrammaticSelection = false;
            }, 200);
        } else {
            logger.log(`[Diff Click] No source mapping found for assembly line ${assemblyLine}`);
        }
    }

    private async openAssemblyFile(filePath: string) {
        if (!filePath) {
            return;
        }

        try {
            const uri = vscode.Uri.file(filePath);
            await vscode.window.showTextDocument(uri, {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true,
                preview: false
            });
            logger.log(`Opened assembly file: ${filePath}`);
        } catch (error) {
            vscode.window.showWarningMessage(`Could not open assembly file: ${path.basename(filePath)}`);
            logger.log(`Error opening assembly file: ${error}`);
        }
    }

    private dispose() {
        AssemblyViewerPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

