import { ArtworkImage } from "./ArtworkImage"
import { useLayoutEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { IconX } from "@tabler/icons-react"

interface ImageModalProps {
  src: string
  alt: string
  onClose: () => void
  overlay?: "dark" | "medium" // "dark"=black/90 (hero), "medium"=black/80 (art). Default "medium"
}

export function ImageModal({
  src,
  alt,
  onClose,
  overlay = "medium",
}: ImageModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const nativeModal = useRef(false)
  useLayoutEffect(() => {
    const dialog = dialogRef.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    nativeModal.current = typeof dialog.showModal === "function"
    const hidden: {
      element: Element
      aria: string | null
      inert: string | null
    }[] = []
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) closeRef.current?.focus()
    }
    if (nativeModal.current) {
      // The browser's top layer escapes every player/hero stacking context.
      dialog.showModal()
    } else {
      // Older system WebKit does not implement showModal. Preserve modal focus
      // and screen-reader isolation without raising the app's browser target.
      dialog.setAttribute("open", "")
      for (const element of [...document.body.children]) {
        if (element === dialog) continue
        hidden.push({
          element,
          aria: element.getAttribute("aria-hidden"),
          inert: element.getAttribute("inert"),
        })
        element.setAttribute("aria-hidden", "true")
        element.setAttribute("inert", "")
      }
      document.addEventListener("focusin", containFocus, true)
      closeRef.current?.focus()
    }
    return () => {
      if (nativeModal.current && dialog.open) dialog.close()
      else dialog.removeAttribute("open")
      document.removeEventListener("focusin", containFocus, true)
      for (const { element, aria, inert } of hidden) {
        if (aria === null) element.removeAttribute("aria-hidden")
        else element.setAttribute("aria-hidden", aria)
        if (inert === null) element.removeAttribute("inert")
        else element.setAttribute("inert", inert)
      }
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true })
    }
  }, [])
  const isDark = overlay === "dark"
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={alt || "Artwork"}
      aria-modal="true"
      className={`fixed inset-0 z-[20000] m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 p-0 text-white backdrop-blur-sm backdrop:bg-transparent open:flex ${isDark ? "bg-black/90" : "bg-black/80"}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => {
        // This viewer has one keyboard control. Keep Tab in the viewer and let
        // its controls own their keys instead of triggering playback hotkeys.
        e.stopPropagation()
        if (e.key === "Tab") {
          e.preventDefault()
          closeRef.current?.focus()
        }
        if (e.key === "Escape" && !nativeModal.current) {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close image"
        title="Close (Esc)"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        onClick={onClose}
      >
        <IconX size={24} aria-hidden="true" />
      </button>
      <ArtworkImage loading="eager"
        src={src}
        alt={alt}
        className={
          isDark
            ? "max-h-[95vh] max-w-[95vw] rounded-lg object-contain shadow-2xl"
            : "max-h-[85vh] max-w-[85vw] rounded-2xl shadow-2xl"
        }
      />
    </dialog>,
    document.body
  )
}
