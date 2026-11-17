import { describe, expect, it } from "vitest";
import { APP_NAME } from "./index";

describe("@veki/web", () => {
  it("exporta el nombre de la app", () => {
    expect(APP_NAME).toBe("@veki/web");
  });
});
