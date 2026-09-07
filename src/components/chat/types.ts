// Local, dependency-free shapes for the chat UI components. These replace the
// `ToolUIPart` / `DynamicToolUIPart` / `UIMessage` types that used to come
// from the `ai` package.

export type MessageRole = "user" | "assistant" | "system";

export type ConversationMessage = {
  role: MessageRole;
  parts: Array<{ type: string; text?: string }>;
};

export type ToolPart = {
  toolName: string;
  state: "running" | "done" | "error";
  input: unknown;
  output?: string;
  errorText?: string;
};
