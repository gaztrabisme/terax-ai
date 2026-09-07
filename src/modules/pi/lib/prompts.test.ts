import { describe, expect, it } from "vitest";
import {
  completeSlashLine,
  filterPrompts,
  parseCommandArgs,
  slashDraft,
  substituteArgs,
  type PiPromptEntry,
} from "./prompts";

function entry(name: string, description = ""): PiPromptEntry {
  return { name, description, path: `/prompts/${name}.md`, source: "agent" };
}

describe("slashDraft", () => {
  it("accepts a bare slash and partial names", () => {
    expect(slashDraft("/")).toEqual({ nameToken: "", rest: "" });
    expect(slashDraft("/rev")).toEqual({ nameToken: "rev", rest: "" });
    expect(slashDraft("/rev src/main.rs")).toEqual({
      nameToken: "rev",
      rest: "src/main.rs",
    });
  });

  it("rejects anything that is not a one-line slash command", () => {
    expect(slashDraft("hello /world")).toBeNull();
    expect(slashDraft("plain text")).toBeNull();
    expect(slashDraft("/multi\nline")).toBeNull();
    expect(slashDraft("")).toBeNull();
  });
});

describe("completeSlashLine", () => {
  it("completes the name and keeps the args tail", () => {
    expect(completeSlashLine("/rev", "review")).toBe("/review");
    expect(completeSlashLine("/rev src/x", "review")).toBe("/review src/x");
    expect(completeSlashLine("/b  two  args ", "brief")).toBe(
      "/brief two  args",
    );
  });

  it("leaves non-slash text alone", () => {
    expect(completeSlashLine("not a slash", "review")).toBe("not a slash");
  });
});

describe("filterPrompts", () => {
  const prompts = [
    entry("brief"),
    entry("review"),
    entry("ticket"),
    entry("wiki-close"),
  ];

  it("matches prefixes, substrings and subsequences, in that rank", () => {
    expect(filterPrompts(prompts, "rev")).toEqual([entry("review")]);
    // "ket" is a substring of ticket.
    expect(filterPrompts(prompts, "ket")).toEqual([entry("ticket")]);
    // "wc" is only a subsequence of wiki-close.
    expect(filterPrompts(prompts, "wc")).toEqual([entry("wiki-close")]);
  });

  it("is case-insensitive and keeps order on equal scores", () => {
    expect(filterPrompts(prompts, "BRI")).toEqual([entry("brief")]);
    // "i" appears in every name: all substrings, list order kept.
    expect(filterPrompts(prompts, "i").map((p) => p.name)).toEqual([
      "brief",
      "review",
      "ticket",
      "wiki-close",
    ]);
  });

  it("drops non-matches and passes an empty query through", () => {
    expect(filterPrompts(prompts, "zzz")).toEqual([]);
    expect(filterPrompts([], "")).toEqual([]);
    expect(filterPrompts(prompts, "")).toEqual(prompts);
  });
});

// The arg grammar mirrors pi's parse_command_args (vendor resources.rs), so
// the vendor's own example values must round-trip identically.
describe("parseCommandArgs", () => {
  it("splits on whitespace and groups quoted tokens", () => {
    expect(parseCommandArgs('one "two three" four')).toEqual([
      "one",
      "two three",
      "four",
    ]);
    expect(parseCommandArgs("'a b' c")).toEqual(["a b", "c"]);
  });

  it("keeps embedded apostrophes literal", () => {
    expect(parseCommandArgs("don't stop")).toEqual(["don't", "stop"]);
  });

  it("keeps an empty quoted token and handles empty input", () => {
    expect(parseCommandArgs('"" tail')).toEqual(["", "tail"]);
    expect(parseCommandArgs("")).toEqual([]);
  });
});

// Same mirror check for substitute_args (vendor resources.rs tests).
describe("substituteArgs", () => {
  const args = ["one", "two", "three"];

  it("substitutes positionals and leaves $0 empty", () => {
    expect(substituteArgs("hello $1", args)).toBe("hello one");
    expect(substituteArgs("$3 $1", args)).toBe("three one");
    expect(substituteArgs("missing: $9 end", args)).toBe("missing:  end");
    expect(substituteArgs("$0", args)).toBe("");
  });

  it("joins everything for $@ and $ARGUMENTS", () => {
    expect(substituteArgs("$@", args)).toBe("one two three");
    expect(substituteArgs("$ARGUMENTS", args)).toBe("one two three");
    expect(substituteArgs("Task: $@", [])).toBe("Task: ");
  });

  it("slices with ${@:N} and ${@:N:L}", () => {
    expect(substituteArgs("${@:2}", args)).toBe("two three");
    expect(substituteArgs("${@:2:1}", args)).toBe("two");
    expect(substituteArgs("${@:4}", args)).toBe("");
  });
});
