import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Manages bidirectional highlighting between source code and assembly
 */
export class HighlightManager {
    private sourceDecorations: vscode.TextEditorDecorationType;
    private assemblyHighlightCallback?: (lines: number[]) => void;
    private lastDecoratedEditor?: vscode.TextEditor;

    constructor() {
        this.sourceDecorations = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.selectionBackground'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('editor.selectionHighlightBorder'),
            isWholeLine: true
        });
    }

    /**
     * Register callback for assembly highlighting
     */
    registerAssemblyHighlightCallback(callback: (lines: number[]) => void) {
        this.assemblyHighlightCallback = callback;
    }

    /**
     * Highlight source lines and notify assembly viewer
     */
    highlightSource(editor: vscode.TextEditor, lines: number[]) {
        // Clear highlights from the previous editor if it's different
        if (this.lastDecoratedEditor && this.lastDecoratedEditor !== editor) {
            this.lastDecoratedEditor.setDecorations(this.sourceDecorations, []);
        }

        const ranges = lines.map(line =>
            editor.document.lineAt(Math.min(line, editor.document.lineCount - 1)).range
        );

        editor.setDecorations(this.sourceDecorations, ranges);
        this.lastDecoratedEditor = editor;

        // Notify assembly viewer to highlight corresponding lines
        if (this.assemblyHighlightCallback) {
            this.assemblyHighlightCallback(lines);
        }
    }

    /**
     * Highlight source from assembly line click
     */
    highlightFromAssembly(filePath: string, sourceLine: number) {
        logger.log(`[Highlight] Attempting to open: ${filePath} at line ${sourceLine}`);

        // Find or open the source file
        vscode.workspace.openTextDocument(filePath).then(
            document => {
                logger.log(`[Highlight] Successfully opened: ${document.uri.fsPath}`);
                vscode.window.showTextDocument(document, {
                    viewColumn: vscode.ViewColumn.One,
                    preserveFocus: false
                }).then(editor => {
                    // Highlight the line
                    const range = editor.document.lineAt(sourceLine).range;
                    const ranges = [range];
                    editor.setDecorations(this.sourceDecorations, ranges);
                    this.lastDecoratedEditor = editor;

                    // Scroll to the line
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    logger.log(`[Highlight] Highlighted line ${sourceLine} in ${document.uri.fsPath}`);
                });
            },
            error => {
                logger.log(`[Highlight] ERROR: Could not open ${filePath}: ${error.message}`);
                vscode.window.showErrorMessage(`Could not open source file: ${error.message}`);
            }
        );
    }

    /**
     * Clear all highlights
     */
    clearHighlights() {
        // Clear decorations from all visible editors
        vscode.window.visibleTextEditors.forEach(editor => {
            editor.setDecorations(this.sourceDecorations, []);
        });
        this.lastDecoratedEditor = undefined;
    }

    dispose() {
        this.sourceDecorations.dispose();
    }
}

