import { describe, expect, it } from "vitest";
import { APP_NAME } from "./app-name";

describe("@veki/bot", () => {
  it("exporta el nombre de la app", () => {
    expect(APP_NAME).toBe("@veki/bot");
  });
});
