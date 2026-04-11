/* ── localforage-esm.js — thin ES module shim ────────────────────
   localforage ships only a UMD build. index.html loads it as a
   plain <script> which sets window.localforage. This shim re-exports
   that global so ES modules can: import localforage from './localforage-esm.js'
   ─────────────────────────────────────────────────────────────── */
export default window.localforage;
