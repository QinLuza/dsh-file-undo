import type { UserConfig } from 'tsdown'

/**
 * Two artifacts:
 * - lib/index.js — the host half (Node, bundled ESM).
 * - lib/client.js — the browser half, wrapped in the official
 *   window.__ModuleLoader__.load({ id, factory }) registration shape (same
 *   contract as the platform's own client plugins): react / react-dom /
 *   react/jsx-runtime stay external and resolve through the module table the
 *   shell seeds before any plugin bundle runs.
 */
const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: 'dsh-file-undo',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;`

const CLIENT_FOOTER = `    return module.exports;
  }
});`

export default [
  {
    // index.js stays a self-contained host bundle; store/diff/api also build
    // as standalone artifacts so isolated verification scripts can exercise
    // each unit directly (the store's persistence medium is the JSONL file,
    // so separate module instances stay coherent).
    entry: {
      index: 'src/index.ts',
      store: 'src/store.ts',
      diff: 'src/diff.ts',
      api: 'src/api.ts',
      // 会话跟随（v0.5.0）：client 侧跟随模块零依赖（无 React / DOM / fetch），
      // 同时构建为 node 产物，verify-follow.mjs 可直接对其做隔离验证。
      follow: 'src/client/follow.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime'] },
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
  },
] satisfies UserConfig[]
