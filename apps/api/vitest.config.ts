import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/edumin_test',
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      EMAIL_DRIVER: 'none',
      UPLOAD_DIR: './.test-uploads',
    },
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
