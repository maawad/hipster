import * as path from 'path';
import { logger } from './logger';

/**
 * Unified line mapping data structure
 */
export interface LineMapping {
    // Maps "filepath:line" -> array of assembly line numbers
    sourceToAsm: Map<string, number[]>;
    // Maps assembly line number -> source location
    asmToSource: Map<number, { file: string; line: number }>;
}

/**
 * Line mapping builder for GCN assembly
 */
export class LineMappingBuilder {
    /**
     * Build line mapping from GCN assembly content
     */
    public buildMapping(
        assemblyContent: string,
        sourceFiles: Map<number, string>
    ): LineMapping {
        const sourceToAsm = new Map<string, number[]>();
        const asmToSource = new Map<number, { file: string; line: number }>();

        const lines = assemblyContent.split('\n');
        let currentFileId = -1;
        let currentSourceLine = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Parse .loc directive: .loc <file_id> <line> <column>
            const locMatch = line.match(/\.loc\s+(\d+)\s+(\d+)\s+\d+/);
            if (locMatch) {
                currentFileId = parseInt(locMatch[1]);
                currentSourceLine = parseInt(locMatch[2]) - 1; // Convert to 0-indexed
            }

            // Track which source location this assembly line belongs to
            if (currentFileId >= 0 && currentSourceLine >= 0) {
                const sourceFilePath = sourceFiles.get(currentFileId);
                if (sourceFilePath) {
                    const normalizedPath = path.normalize(sourceFilePath);

                    // Store asm → source mapping for click handling
                    asmToSource.set(i, {
                        file: normalizedPath,
                        line: currentSourceLine
                    });

                    // Only add actual instructions to source → asm mapping
                    const trimmed = line.trim();
                    const isDirective = trimmed.startsWith('.');
                    const isComment = trimmed.startsWith(';') || trimmed.startsWith('//');
                    const isEmpty = trimmed.length === 0;
                    const isLabel = trimmed.endsWith(':') && !trimmed.includes(' ');

                    if (!isEmpty && !isDirective && !isComment && !isLabel) {
                        const key = `${normalizedPath}:${currentSourceLine}`;

                        if (!sourceToAsm.has(key)) {
                            sourceToAsm.set(key, []);
                        }

                        sourceToAsm.get(key)!.push(i);
                    }
                }
            }
        }

        logger.log(`Built line mapping: ${sourceToAsm.size} source lines, ${asmToSource.size} assembly lines`);

        return {
            sourceToAsm,
            asmToSource
        };
    }

    /**
     * Get assembly lines for a given source file and line
     */
    public getAssemblyLines(
        mapping: LineMapping,
        sourceFile: string,
        sourceLine: number
    ): number[] {
        const normalizedPath = path.normalize(sourceFile);
        const key = `${normalizedPath}:${sourceLine}`;
        return mapping.sourceToAsm.get(key) || [];
    }

    /**
     * Get source location for a given assembly line
     */
    public getSourceLocation(
        mapping: LineMapping,
        assemblyLine: number
    ): { file: string; line: number } | undefined {
        const result = mapping.asmToSource.get(assemblyLine);
        if (result) {
            logger.log(`[Line Mapping] Assembly line ${assemblyLine} -> ${result.file}:${result.line}`);
        } else {
            logger.log(`[Line Mapping] Assembly line ${assemblyLine} has no mapping`);
        }
        return result;
    }
}

