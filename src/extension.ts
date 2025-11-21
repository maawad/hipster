import * as vscode from 'vscode';
import { HipCompiler } from './hipCompiler';
import { AssemblyViewerPanel } from './assemblyViewer';
import { HighlightManager } from './highlighting';
import { logger } from './logger';

export function activate(context: vscode.ExtensionContext) {
    logger.log('Hipster extension activated');
    logger.log(`Log file location: ${logger.getLogFilePath()}`);

    const compiler = new HipCompiler();
    const highlightManager = new HighlightManager();

    // Command: Show Assembly Side by Side
    const showAssemblySideBySide = vscode.commands.registerCommand(
        'hipster.showAssemblySideBySide',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }

            const document = editor.document;
            const ext = document.fileName.split('.').pop()?.toLowerCase();

            if (ext !== 'hip' && ext !== 'cu' && ext !== 'cpp' && ext !== 'hpp' && ext !== 'h') {
                vscode.window.showWarningMessage('This command only works with HIP/C++/CUDA files');
                return;
            }

            // Get the current line number where cursor is
            const currentLine = editor.selection.active.line;

            AssemblyViewerPanel.createOrShow(
                context.extensionUri,
                compiler,
                document,
                highlightManager,
                currentLine
            );
        }
    );

    // Auto-highlight assembly when clicking on source code
    let selectionTimeout: NodeJS.Timeout | undefined;
    const onSelectionChangeHandler = vscode.window.onDidChangeTextEditorSelection(async (event) => {
        const editor = event.textEditor;
        const document = editor.document;

        // Only process HIP/C++/CUDA files
        const ext = document.fileName.split('.').pop()?.toLowerCase();
        if (ext !== 'hip' && ext !== 'cu' && ext !== 'cpp' && ext !== 'hpp' && ext !== 'h') {
            return;
        }

        // Only highlight if assembly viewer is already open
        if (!AssemblyViewerPanel.currentPanel) {
            return;
        }

        // Skip if this is a programmatic selection (from clicking assembly)
        if (AssemblyViewerPanel.isProgrammaticSelection()) {
            logger.log('Skipping highlight - programmatic selection');
            return;
        }

        // Debounce to avoid excessive updates while moving cursor
        if (selectionTimeout) {
            clearTimeout(selectionTimeout);
        }

        selectionTimeout = setTimeout(async () => {
            const currentLine = editor.selection.active.line;
            logger.log(`Selection changed to line ${currentLine} in ${document.fileName}`);

            // Clear previous highlights
            highlightManager.clearHighlights();

            // Highlight the assembly for the current line
            await AssemblyViewerPanel.currentPanel?.highlightAssemblyForSourceLine(document, currentLine);
        }, 150); // 150ms debounce
    });

    context.subscriptions.push(showAssemblySideBySide, onSelectionChangeHandler, highlightManager);
}

export function deactivate() {
    logger.log('Hipster extension deactivated');
}

