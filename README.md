<h1 align="center">🔥 Hipster 🔥</h1>

<p align="center">
  <a href="https://github.com/maawad/hipster/actions/workflows/main.yml">
    <img src="https://github.com/maawad/hipster/actions/workflows/main.yml/badge.svg" alt="CI Status">
  </a>
  <a href="https://github.com/maawad/hipster/actions/workflows/main.yml">
    <img src="https://img.shields.io/badge/Download-Latest%20VSIX-blue?style=flat-square" alt="Download VSIX">
  </a>
  <a href="https://open-vsx.org/extension/TinkerCode/hipster">
    <img src="https://img.shields.io/open-vsx/v/TinkerCode/hipster?label=Open%20VSX&style=flat-square" alt="Open VSX">
  </a>
</p>

<p align="center">
  <img src="resources/icon.png" alt="Hipster Icon" width="128" height="128">
</p>

<p align="center">
  <strong>Navigate HIP GPU assembly with bidirectional source-assembly highlighting and powerful inspection tools.</strong>
</p>

## 📦 Installation

### Download Latest Version

[![Download VSIX](https://img.shields.io/badge/Download-Latest%20VSIX-blue?style=for-the-badge)](https://github.com/maawad/hipster/actions/workflows/main.yml)

1. Go to [Actions](https://github.com/maawad/hipster/actions)
2. Click on the latest successful workflow run
3. Scroll to "Artifacts" and download `hipster-vsix`
4. Extract the `.vsix` file from the zip
5. In VS Code: `Extensions` → `...` → `Install from VSIX`
6. Select the downloaded `.vsix` file

### From Open VSX

[![Open VSX Version](https://img.shields.io/open-vsx/v/TinkerCode/hipster?label=Open%20VSX&style=for-the-badge)](https://open-vsx.org/extension/TinkerCode/hipster)

Visit [Open VSX](https://open-vsx.org/extension/TinkerCode/hipster) to download the `.vsix` file.

## 🚀 Quick Start

1. Build your HIP project with debug info:
   ```bash
   cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_HIP_FLAGS="-g -save-temps" ..
   make
   ```

2. Open a HIP/C++ source file (`.hip`, `.cu`, `.cpp`, `.h`)
3. Right-click → `Hipster: View Assembly` or click the chip icon in the toolbar
4. Click source lines to highlight assembly, click assembly to jump to source

## ✨ Features

- **Bidirectional Highlighting**: Click source ↔ assembly to navigate
- **Assembly Viewer**: Side-by-side view with GCN syntax highlighting
- **Advanced Filtering**: Hide directives, comments, filter by instruction type
- **In-Webview Search**: Press `Ctrl+F` to search assembly
- **Version Comparison**: Compare different kernel versions side-by-side
- **Multi-Build Support**: Scans multiple build directories with version tracking
- **Smart Discovery**: Auto-detects assembly files with debug info

## ⚙️ Configuration

Set custom build directories in VS Code settings:

```json
{
  "hipster.buildDirectories": ["build", "build-debug", "build-release"]
}
```

Default: `["build"]`

## 🔧 Development

```bash
npm install
npm run compile
npm run lint
```

Press `F5` in VS Code to debug.

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

---

**Made with 🔥 for HIP kernel developers**
