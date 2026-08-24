import { defineConfig } from 'vitest/config'

export default defineConfig({
  coverage: {
    enabled: false
  },
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/**/*.test.ts',
            'apps/desktop/main/**/*.test.ts',
            'apps/desktop/preload/**/*.test.ts',
            'apps/desktop/scripts/**/*.test.ts'
          ]
        }
      },
      {
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['apps/desktop/renderer/**/*.test.tsx', 'apps/desktop/renderer/**/*.test.ts']
        }
      }
    ]
  }
})
