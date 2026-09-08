function closest(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

export function isModalTarget(target: EventTarget | null): boolean {
  return closest(
    target,
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
  );
}

export function isTerminalTarget(target: EventTarget | null): boolean {
  return closest(
    target,
    '.xterm, [data-uat="terminal-emulator"], [data-uat="terminal-composer"]',
  );
}

export function hasLocalKeyPriority(target: EventTarget | null): boolean {
  return (
    isModalTarget(target) ||
    closest(
      target,
      '[contenteditable="true"], .cm-editor, [data-uat="editor-input"], [data-uat="prompt-menu"], [data-uat="keystone-card"]',
    )
  );
}
