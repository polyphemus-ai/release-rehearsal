import { defineConfig } from 'vitest/config';

// Tests never start containers unless they're about workers: those find Docker or Podman directly
// (detectRuntime with candidates) and hand it to polyphemus themselves, and clean up what they started.
export default defineConfig({
  test: {
    // The owner is named for the fixture, not after whoever's account runs the tests.
    env: { POLYPHEMUS_CONTAINER_RUNTIME: 'off', POLYPHEMUS_OWNER_NAME: 'Alex' },
  },
});
