import { describe, expect, it } from "vitest";
import {
  ASSISTANT_MENTION,
  assistantErrorMessage,
  withAssistantMention,
} from "../src/lib/assistant";

describe("withAssistantMention", () => {
  it("prefixes the mention, including onto an empty composer", () => {
    expect(withAssistantMention("")).toBe(`${ASSISTANT_MENTION} `);
    expect(withAssistantMention("summarise this")).toBe(
      `${ASSISTANT_MENTION} summarise this`,
    );
  });

  it("does not add a second mention", () => {
    expect(withAssistantMention("@nextalk help")).toBe("@nextalk help");
    expect(withAssistantMention("hey @NexTalk, help")).toBe("hey @NexTalk, help");
    expect(withAssistantMention(withAssistantMention("x"))).toBe("@nextalk x");
  });

  it("treats look-alikes as not mentioned", () => {
    expect(withAssistantMention("mail me@nextalk.com")).toBe(
      "@nextalk mail me@nextalk.com",
    );
    expect(withAssistantMention("@nextalks")).toBe("@nextalk @nextalks");
  });

  it("tolerates non-string input", () => {
    expect(withAssistantMention(undefined)).toBe("@nextalk ");
  });
});

describe("assistantErrorMessage", () => {
  it("maps known reason codes", () => {
    expect(assistantErrorMessage("rate_limited")).toMatch(/limit/i);
    expect(assistantErrorMessage("unavailable")).toMatch(/unavailable/i);
  });

  it("falls back to the generic message for unknown or missing reasons", () => {
    expect(assistantErrorMessage("boom")).toBe(assistantErrorMessage("unavailable"));
    expect(assistantErrorMessage(undefined)).toBe(assistantErrorMessage("unavailable"));
  });
});
