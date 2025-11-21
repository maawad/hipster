# Hipster 🔥

Navigate HIP GPU assembly with bidirectional source-assembly highlighting and powerful inspection tools.

## Features

- **Bidirectional Highlighting**: Click on source code to highlight corresponding assembly, or click on assembly to jump to source
- **Smart Assembly Discovery**: Automatically finds assembly files in your build directory
- **Multi-Kernel Support**: Handles multiple kernels and template instantiations
- **File & Kernel Selection**: Searchable dropdowns to navigate between files and kernels
- **Debug Info Parsing**: Parses GCN assembly `.loc` and `.file` directives for accurate line mapping

## Requirements

- Your HIP project must be compiled with debug information (`-g` flag)
- Assembly files must be generated in the build directory (typically with `-save-temps`)

## Usage

1. Build your HIP project with debug info:
   ```bash
   cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_HIP_FLAGS="-g -save-temps" ..
   make
   ```

2. Open a `.hip`, `.cu`, or `.cpp` file in VS Code

3. Click the chip icon (🔧) in the editor toolbar, or use the command palette:
   - `Hipster: View Assembly`

4. The assembly viewer opens side-by-side with your source code

5. Click on any line in your source to highlight the corresponding assembly

6. Click on any assembly instruction to jump to the source line

## Configuration

- `hipster.buildDirectory`: Build directory name to search for assembly files (default: `build`)

## How It Works

Hipster scans your build directory for GCN assembly files (`*-hip-amdgcn-amd-amdhsa-*.s`) and parses the debug information to create bidirectional mappings between source code and assembly instructions.

## Supported File Types

- `.hip` (HIP)
- `.cu` (CUDA)
- `.cpp`, `.hpp`, `.h` (C++)

## Known Limitations

- Requires debug information in assembly files
- Only supports GCN assembly format (AMD GPUs)

## License

MIT

