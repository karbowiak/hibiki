import { useLayoutEffect, useRef, type RefObject } from "react"

interface ModalOptions {
  onClose(): void
  canClose?: boolean
  initialFocus: RefObject<HTMLElement | null>
  /** macOS keyboard settings can otherwise skip buttons in a form. */
  ownTabOrder?: boolean
}
interface ModalStack {
  dialogs: { element: HTMLDialogElement; native: boolean }[]
  overflow: string
  returnFocus: HTMLElement | null
  hidden: Map<Element, { aria: string | null; inert: string | null }>
}
const stacks = new WeakMap<Document, ModalStack>()
function isolate(document: Document, stack: ModalStack) {
  for (const [node, saved] of stack.hidden) {
    for (const [attribute, value] of [
      ["aria-hidden", saved.aria],
      ["inert", saved.inert],
    ]) {
      if (value === null) node.removeAttribute(attribute)
      else node.setAttribute(attribute, value)
    }
  }
  if (!stack.dialogs.some((dialog) => !dialog.native)) {
    stack.hidden.clear()
    return
  }
  const top = stack.dialogs.at(-1)?.element
  for (const node of document.body.children) {
    if (node === top) continue
    if (!stack.hidden.has(node))
      stack.hidden.set(node, {
        aria: node.getAttribute("aria-hidden"),
        inert: node.getAttribute("inert"),
      })
    node.setAttribute("aria-hidden", "true")
    node.setAttribute("inert", "")
  }
}

/** Shared top-layer/fallback isolation, focus, shortcuts and scroll restoration. */
export function useModalLifecycle(
  dialog: RefObject<HTMLDialogElement | null>,
  options: ModalOptions
) {
  const current = useRef(options)
  current.current = options
  useLayoutEffect(() => {
    const element = dialog.current!
    const document = element.ownerDocument
    const window = document.defaultView!
    const previous = document.activeElement as HTMLElement | null
    let stack = stacks.get(document)
    if (!stack) {
      stack = {
        dialogs: [],
        overflow: document.body.style.overflow,
        returnFocus: previous,
        hidden: new Map(),
      }
      stacks.set(document, stack)
    }
    const native = typeof element.showModal === "function"
    stack.dialogs.push({ element, native })
    document.body.style.overflow = "hidden"
    if (native) element.showModal()
    else element.setAttribute("open", "")
    isolate(document, stack)
    const top = () => stack.dialogs.at(-1)?.element === element
    const focus = () => {
      if (current.current.canClose !== false)
        (
          current.current.initialFocus.current ??
          element.querySelector<HTMLElement>("button:not(:disabled)") ??
          element
        ).focus()
      else element.focus()
    }
    focus()
    const contain = (event: FocusEvent) => {
      if (top() && !element.contains(event.target as Node)) focus()
    }
    const keydown = (event: KeyboardEvent) => {
      if (!top() || (event.target as Element)?.closest?.("dialog") !== element)
        return
      if (!native && event.key === "Escape") {
        event.preventDefault()
        if (current.current.canClose !== false) current.current.onClose()
      }
      if (event.key !== "Tab" || event.defaultPrevented) return
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          "button, a[href], input, textarea, select, [tabindex]"
        ),
      ].filter(
        (node) =>
          !node.hasAttribute("disabled") &&
          node.tabIndex >= 0 &&
          !node.closest("[hidden], [inert]")
      )
      const index = controls.indexOf(document.activeElement as HTMLElement)
      if (!controls.length) {
        event.preventDefault()
        element.focus()
      } else if (
        current.current.ownTabOrder ||
        index < 0 ||
        (event.shiftKey ? index === 0 : index === controls.length - 1)
      ) {
        event.preventDefault()
        controls[
          index < 0
            ? event.shiftKey
              ? controls.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + controls.length) %
              controls.length
        ].focus()
      }
    }
    const shortcuts = (event: KeyboardEvent) => {
      if (
        top() &&
        (event.target as Element)?.closest?.("dialog") === element &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ["k", "f", "r"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    element.addEventListener("keydown", keydown)
    document.addEventListener("focusin", contain, true)
    window.addEventListener("keydown", shortcuts, true)
    return () => {
      element.removeEventListener("keydown", keydown)
      document.removeEventListener("focusin", contain, true)
      window.removeEventListener("keydown", shortcuts, true)
      const wasTop = top()
      stack.dialogs = stack.dialogs.filter(
        (dialog) => dialog.element !== element
      )
      if (native && element.open) element.close()
      else element.removeAttribute("open")
      isolate(document, stack)
      if (!stack.dialogs.length) {
        document.body.style.overflow = stack.overflow
        stacks.delete(document)
      }
      const restore = previous?.isConnected
        ? previous
        : !stack.dialogs.length
          ? stack.returnFocus
          : null
      if (wasTop && restore?.isConnected && !restore.closest("[inert]"))
        restore.focus({ preventScroll: true })
    }
  }, [dialog])
}
