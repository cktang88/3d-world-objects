import { defineConfig } from 'vite';

// Each git worktree symlinks the shared node_modules; keep Vite's dependency cache per checkout
// (not node_modules/.vite) so parallel dev servers don't invalidate each other
// ("504 Outdated Optimize Dep").
export default defineConfig({
  cacheDir: '.vite-cache',
});
