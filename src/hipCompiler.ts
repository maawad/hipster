import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { logger } from './logger';

const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const execAsync = promisify(exec);

export interface AssemblyFile {
    assemblyPath: string;       // Full path to .s file
    assemblyContent: string;    // Full assembly text (entire file)
    kernelSymbol: string;       // Mangled name from .globl
    sourceFiles: Map<number, string>; // File ID → normalized path
    startLine: number;          // Start line of this kernel in the full file
    endLine: number;            // End line of this kernel in the full file
    buildDirectory: string;     // Build directory name (e.g., "build", "build-old")
}

export interface AssemblyMatch {
    sourceFile: string;         // Source file that contains the clicked line
    kernelSymbol: string;       // Kernel name (mangled)
    assemblyFile: string;       // Path to assembly file
    assemblyLines: number[];    // Assembly lines mapping to clicked source line
    assemblyContent: string;    // Full assembly text (entire file)
    startLine: number;          // Start line of this kernel in the full file
    endLine: number;            // End line of this kernel in the full file
    buildDirectory: string;     // Build directory name (e.g., "build", "build-old")
}

export class HipCompiler {
    private buildDirectories: string[] = ['build'];

    constructor() {
        this.updateBuildDirectories();
    }

    /**
     * Update build directories from configuration
     */
    private updateBuildDirectories(): void {
        const config = vscode.workspace.getConfiguration('hipster');
        this.buildDirectories = config.get<string[]>('buildDirectories', ['build']);

        // Ensure we always have at least one directory
        if (this.buildDirectories.length === 0) {
            this.buildDirectories = ['build'];
        }
    }

    /**
     * Get the current build directories
     */
    public getBuildDirectories(): string[] {
        return this.buildDirectories;
    }

    /**
     * Find all GCN assembly files across all configured build directories
     */
    async findAssemblyFiles(workspaceFolder: string): Promise<AssemblyFile[]> {
        this.updateBuildDirectories();

        const allAssemblyFiles: AssemblyFile[] = [];

        // Scan each build directory
        for (const buildDir of this.buildDirectories) {
            const buildPath = path.join(workspaceFolder, buildDir);

            if (!fs.existsSync(buildPath)) {
                logger.log(`Build directory not found: ${buildPath}`);
                continue;
            }

            logger.log(`Scanning build directory: ${buildPath}`);
            const assemblyFiles: AssemblyFile[] = [];
            await this.scanDirectory(buildPath, assemblyFiles, buildDir);

            logger.log(`Found ${assemblyFiles.length} assembly files in ${buildDir}`);
            allAssemblyFiles.push(...assemblyFiles);
        }

        logger.log(`Total: Found ${allAssemblyFiles.length} assembly files across ${this.buildDirectories.length} directories`);
        return allAssemblyFiles;
    }

    /**
     * Recursively scan directory for assembly files
     */
    private async scanDirectory(dir: string, results: AssemblyFile[], buildDirectoryName: string): Promise<void> {
        try {
            const entries = await readdir(dir);

            for (const entry of entries) {
                const fullPath = path.join(dir, entry);
                const entryStat = await stat(fullPath);

                if (entryStat.isDirectory()) {
                    await this.scanDirectory(fullPath, results, buildDirectoryName);
                } else if (entryStat.isFile() && this.isGCNAssembly(entry)) {
                    try {
                        const content = await readFile(fullPath, 'utf-8');
                        const kernels = this.extractAllKernels(content);
                        const sourceFiles = this.extractSourceFiles(content);

                        for (const kernel of kernels) {
                            results.push({
                                assemblyPath: fullPath,
                                assemblyContent: content,  // Keep full content, not split
                                kernelSymbol: kernel.symbol,
                                sourceFiles,
                                startLine: kernel.startLine,
                                endLine: kernel.endLine,
                                buildDirectory: buildDirectoryName
                            });
                            logger.log(`Found kernel: ${kernel.symbol} in ${path.basename(fullPath)} [${buildDirectoryName}] (lines ${kernel.startLine}-${kernel.endLine})`);
                        }
                    } catch (error) {
                        logger.log(`Error reading assembly file ${fullPath}: ${error}`);
                    }
                }
            }
        } catch (error) {
            logger.log(`Error scanning directory ${dir}: ${error}`);
        }
    }

    /**
     * Check if filename is a GCN assembly file
     */
    private isGCNAssembly(filename: string): boolean {
        // Match: *-hip-amdgcn-amd-amdhsa-*.s
        return filename.includes('-hip-amdgcn-amd-amdhsa-') && filename.endsWith('.s');
    }

    /**
     * Extract kernel symbol from .globl directive
     */
    private extractKernelSymbol(content: string): string | undefined {
        // Look for .globl directive followed by kernel name
        // Prefer symbols that look like kernel functions (contain common patterns)
        const globalMatches = Array.from(content.matchAll(/\.globl\s+(\S+)/g));

        for (const match of globalMatches) {
            const symbol = match[1];
            // Skip non-kernel symbols (like metadata)
            if (!symbol.includes('.') && symbol.length > 5) {
                logger.log(`Extracted kernel symbol: ${symbol}`);
                return symbol;
            }
        }

        return undefined;
    }

    /**
     * Extract ALL kernels from an assembly file and their line ranges
     * Returns the full content for each kernel (not split) along with line range info
     * Uses .section directives to identify boundaries, then finds .globl for kernel name
     */
    private extractAllKernels(content: string): Array<{ symbol: string; startLine: number; endLine: number }> {
        const kernels: Array<{ symbol: string; startLine: number; endLine: number }> = [];
        const lines = content.split('\n');

        // Find all .section directives that define kernel sections
        // Format: .section .text.<kernel_name>,"axG",@progbits,<kernel_name>,comdat
        const sectionLines: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match .section directives with .text prefix
            if (line.match(/\.section\s+\.text\./)) {
                sectionLines.push(i);
            }
        }

        if (sectionLines.length === 0) {
            // Fallback: try to find .globl directives and use them as section boundaries
            logger.log('No .section directives found, falling back to .globl boundaries');
            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(/\.globl\s+(\S+)/);
                if (match) {
                    const symbol = match[1];
                    if (!symbol.includes('.') && symbol.length > 5) {
                        sectionLines.push(i);
                    }
                }
            }
        }

        if (sectionLines.length === 0) {
            return kernels;
        }

        // For each section, find the .globl directive inside it to get the kernel name
        for (let i = 0; i < sectionLines.length; i++) {
            const startLine = sectionLines[i];
            const endLine = (i + 1 < sectionLines.length) ? sectionLines[i + 1] - 1 : lines.length - 1;

            // Search for .globl directive within this section
            let kernelSymbol: string | undefined;
            for (let j = startLine; j <= Math.min(endLine, startLine + 20); j++) {
                // Look within first 20 lines of section for .globl
                const globlMatch = lines[j].match(/\.globl\s+(\S+)/);
                if (globlMatch) {
                    const symbol = globlMatch[1];
                    // Skip non-kernel symbols (metadata, etc.)
                    if (!symbol.includes('.') && symbol.length > 5) {
                        kernelSymbol = symbol;
                        logger.log(`Found kernel symbol: ${symbol} at line ${j} (section starts at ${startLine})`);
                        break;
                    }
                }
            }

            // If we found a kernel symbol, add it
            if (kernelSymbol) {
                kernels.push({
                    symbol: kernelSymbol,
                    startLine: startLine,
                    endLine: endLine
                });
            } else {
                logger.log(`Warning: Section at line ${startLine} has no .globl directive, skipping`);
            }
        }

        return kernels;
    }

    /**
     * Extract source file mappings from .file directives
     * Format 1: .file <id> "directory" "filename"
     * Format 2: .file <id> "full/path"
     */
    private extractSourceFiles(content: string): Map<number, string> {
        const sourceFiles = new Map<number, string>();
        const lines = content.split('\n');

        for (const line of lines) {
            // Format 1: .file 7 "/home/user/project" "src/kernel.hip"
            const format1Match = line.match(/\.file\s+(\d+)\s+"([^"]+)"\s+"([^"]+)"/);
            if (format1Match) {
                const fileId = parseInt(format1Match[1]);
                const directory = format1Match[2];
                const filename = format1Match[3];
                const fullPath = path.join(directory, filename);
                sourceFiles.set(fileId, path.normalize(fullPath));
                continue;
            }

            // Format 2: .file 7 "/full/path/to/kernel.hip"
            const format2Match = line.match(/\.file\s+(\d+)\s+"([^"]+)"/);
            if (format2Match) {
                const fileId = parseInt(format2Match[1]);
                const filePath = format2Match[2];
                sourceFiles.set(fileId, path.normalize(filePath));
            }
        }

        return sourceFiles;
    }

    /**
     * Find assembly files that contain references to the given source file and line
     */
    async findMatchingAssemblies(
        workspaceFolder: string,
        sourceFile: string,
        sourceLine: number
    ): Promise<AssemblyMatch[]> {
        const assemblyFiles = await this.findAssemblyFiles(workspaceFolder);
        const matches: AssemblyMatch[] = [];
        const normalizedSource = path.normalize(sourceFile);
        const sourceBasename = path.basename(sourceFile);

        logger.log(`\n=== Looking for matches ===`);
        logger.log(`Source file: ${normalizedSource}`);
        logger.log(`Basename: ${sourceBasename}`);
        logger.log(`Source line: ${sourceLine}`);
        logger.log(`Found ${assemblyFiles.length} assembly files`);

        for (const asmFile of assemblyFiles) {
            logger.log(`\nChecking: ${path.basename(asmFile.assemblyPath)}`);
            logger.log(`  Kernel: ${asmFile.kernelSymbol}`);
            logger.log(`  Has ${asmFile.sourceFiles.size} source files`);

            // Find which file ID corresponds to our source file
            let targetFileId: number | undefined;
            for (const [fileId, filePath] of asmFile.sourceFiles.entries()) {
                const asmBasename = path.basename(filePath);
                logger.log(`    [${fileId}] ${asmBasename} (full: ${filePath})`);

                // Try basename match first (most reliable across different build paths)
                if (asmBasename === sourceBasename) {
                    targetFileId = fileId;
                    logger.log(`    ✓ MATCH on basename!`);
                    break;
                }
            }

            if (targetFileId === undefined) {
                logger.log(`  ✗ No matching source file`);
                continue;
            }

            logger.log(`  → Using file ID ${targetFileId}`);

            // Find all assembly lines that reference this source line (if sourceLine provided)
            let assemblyLines: number[] = [];
            if (sourceLine > 0) {
                assemblyLines = this.findAssemblyLinesForSourceLine(
                    asmFile.assemblyContent,
                    targetFileId,
                    sourceLine
                );
            }

            // Always add the match even if no specific lines (user can navigate later)
            matches.push({
                sourceFile: normalizedSource,
                kernelSymbol: asmFile.kernelSymbol,
                assemblyFile: asmFile.assemblyPath,
                assemblyLines,
                assemblyContent: asmFile.assemblyContent,
                startLine: asmFile.startLine,
                endLine: asmFile.endLine,
                buildDirectory: asmFile.buildDirectory
            });

            logger.log(`  ✓ Added match: ${asmFile.kernelSymbol} [${asmFile.buildDirectory}] (${assemblyLines.length} asm lines for line ${sourceLine}, kernel at lines ${asmFile.startLine}-${asmFile.endLine})`);
        }

        return matches;
    }

    /**
     * Find assembly lines that map to a specific source line
     * Parses .loc directives: .loc <file_id> <line> <column>
     */
    private findAssemblyLinesForSourceLine(
        assemblyContent: string,
        fileId: number,
        sourceLine: number
    ): number[] {
        const lines = assemblyContent.split('\n');
        const matchingLines: number[] = [];
        let currentFileId = -1;
        let currentSourceLine = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Parse .loc directive: .loc <file_id> <line> <column>
            const locMatch = line.match(/\.loc\s+(\d+)\s+(\d+)\s+\d+/);
            if (locMatch) {
                currentFileId = parseInt(locMatch[1]);
                currentSourceLine = parseInt(locMatch[2]);
            }

            // If this assembly line maps to our target source line
            if (currentFileId === fileId && currentSourceLine === sourceLine) {
                // Only add actual instruction lines (not directives/comments)
                const trimmed = line.trim();
                const isDirective = trimmed.startsWith('.');
                const isComment = trimmed.startsWith(';') || trimmed.startsWith('//');
                const isEmpty = trimmed.length === 0;

                if (!isEmpty && !isDirective && !isComment) {
                    matchingLines.push(i);
                }
            }
        }

        return matchingLines;
    }

    /**
     * Get all unique source files referenced by assembly files
     */
    getUniqueSourceFiles(assemblyFiles: AssemblyFile[]): string[] {
        const sourceFilesSet = new Set<string>();

        for (const asmFile of assemblyFiles) {
            for (const filePath of asmFile.sourceFiles.values()) {
                // Extract just the filename for display
                const basename = path.basename(filePath);
                sourceFilesSet.add(basename);
            }
        }

        return Array.from(sourceFilesSet).sort();
    }

    /**
     * Demangle a C++ symbol name using c++filt
     */
    async demangleSymbol(mangledName: string): Promise<string> {
        try {
            const { stdout } = await execAsync(`echo "${mangledName}" | c++filt -n`);
            const demangled = stdout.trim();
            return demangled || mangledName;
        } catch (error) {
            logger.log(`Failed to demangle ${mangledName}: ${error}`);
            return mangledName;
        }
    }
}

