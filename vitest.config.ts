import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/parser/**/*.ts', 'src/core/**/*.ts', 'src/translation/**/*.ts', 'src/config.ts', 'src/renderer.ts', 'src/controller.ts', 'src/commentFormat.ts', 'src/reader*.ts'],
      exclude: ['src/parser/grammars.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { 'src/parser/commentParser.ts': { statements: 90, branches: 90, functions: 90, lines: 90 } }
    }
  }
});
