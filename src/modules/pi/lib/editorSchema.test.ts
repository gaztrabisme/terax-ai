import { getSchema } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { piEditorExtensions } from "@/modules/pi/components/renderers/Markdown";

// The schema is built at editor creation, inside a React render; a missing
// node type throws there and unmounts the app. Build it here, outside React.
describe("piEditorExtensions schema", () => {
  it("builds without throwing and includes the table node family", () => {
    const schema = getSchema(piEditorExtensions());
    for (const name of ["table", "tableRow", "tableHeader", "tableCell", "paragraph"]) {
      expect(schema.nodes[name], name).toBeDefined();
    }
  });
});
