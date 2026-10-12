const CONTROL_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "summary",
  '[data-keyboard-scroll="true"]',
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  ...[
    "button",
    "link",
    "slider",
    "spinbutton",
    "combobox",
    "textbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "checkbox",
    "switch",
    "radio",
    "listbox",
    "option",
    "grid",
    "tree",
    "treeitem",
  ].map((role) => `[role="${role}"]`),
].join(",")

/** Local controls and editors own their key events, including shadow contents. */
export function isKeyboardControl(event: KeyboardEvent): boolean {
  return event.composedPath().some((node) => {
    const element = node as Element
    return (
      typeof element?.closest === "function" &&
      element.closest(CONTROL_SELECTOR) !== null
    )
  })
}

export function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.key === "Process" || event.keyCode === 229
}

export function hasKeyboardModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey
}
