import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

class Logger {
    private outputChannel: vscode.OutputChannel;
    private logFilePath: string;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Hipster');

        // Create log file in temp directory
        const tempDir = os.tmpdir();
        this.logFilePath = path.join(tempDir, 'hipster-debug.log');

        // Clear old log on startup
        try {
            fs.writeFileSync(this.logFilePath, '');
            this.log(`Log file: ${this.logFilePath}`);
        } catch (error) {
            console.error('Failed to create log file:', error);
        }
    }

    log(message: string): void {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}`;

        // Write to output channel
        this.outputChannel.appendLine(logLine);

        // Write to file
        try {
            fs.appendFileSync(this.logFilePath, logLine + '\n');
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    show(): void {
        this.outputChannel.show();
    }

    getLogFilePath(): string {
        return this.logFilePath;
    }

    dispose(): void {
        this.outputChannel.dispose();
    }
}

export const logger = new Logger();

