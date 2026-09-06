import type { PiPartRendererProps } from "./registry";

// Minimal RFC4180-style split: quoted cells, escaped quotes, CRLF/CR/LF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      pushCell();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length > 0) pushRow();
  return rows;
}

export function TableCsvRenderer({ part }: PiPartRendererProps) {
  const rows = parseCsv(part.text ?? "");
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <table className="my-1 w-full border-collapse text-[11px]">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th
              key={i}
              className="border border-border bg-accent/40 px-1.5 py-0.5 text-left font-medium"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, ri) => (
          <tr key={ri}>
            {r.map((c, ci) => (
              <td key={ci} className="border border-border px-1.5 py-0.5">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
