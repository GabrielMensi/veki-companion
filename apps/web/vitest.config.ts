import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@veki/web",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
