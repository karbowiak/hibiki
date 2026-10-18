import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react"
import { createPortal } from "react-dom"
import { IconCheck, IconChevronDown } from "@tabler/icons-react"
import clsx from "clsx"
import { Button } from "./Button"
import { DropdownSurface } from "./DropdownSurface"

export type SelectOption = {
  value: string
  label: string
  disabled: boolean
  group?: string
}
export type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "multiple" | "size" | "onFocus" | "onBlur" | "onKeyDown" | "onClick"
> &
  Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onFocus" | "onBlur" | "onKeyDown" | "onClick"
  > & {
    size?: "sm" | "md"
    /** Presentation only; native labels still drive forms and keyboard search. */
    renderOption?: (option: SelectOption) => ReactNode
  }

/** Custom single-select with native form values/change events and a portalled, keyboard-driven list. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    {
      children,
      className,
      style,
      id,
      size = "sm",
      renderOption,
      onChange,
      onFocus,
      onBlur,
      onKeyDown,
      onClick,
      autoFocus,
      "aria-label": ariaLabel,
      "aria-labelledby": labelledBy,
      ...props
    },
    ref
  ) {
    const uid = useId(),
      triggerId = id ?? `${uid}-trigger`,
      listId = `${uid}-list`
    const native = useRef<HTMLSelectElement>(null),
      trigger = useRef<HTMLButtonElement>(null),
      list = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => native.current!)
    const [options, setOptions] = useState<SelectOption[]>([]),
      [selected, setSelected] = useState(""),
      [open, setOpen] = useState(false),
      [active, setActive] = useState(-1),
      [label, setLabel] = useState<string>(),
      [position, setPosition] = useState<CSSProperties>({}),
      [portal, setPortal] = useState<HTMLElement | null>(null)
    const search = useRef({ text: "", at: 0 })

    useLayoutEffect(() => {
      // The hidden form select must not steal an implicit label from the visible control.
      const wrappingLabel = trigger.current?.closest("label")
      if (!wrappingLabel || wrappingLabel.htmlFor) return
      wrappingLabel.htmlFor = triggerId
      return () => {
        if (wrappingLabel.htmlFor === triggerId)
          wrappingLabel.removeAttribute("for")
      }
    }, [triggerId])

    useLayoutEffect(() => {
      const select = native.current!,
        button = trigger.current!
      const next = Array.from(select.options, (option) => ({
        value: option.value,
        label: option.label,
        disabled:
          option.disabled ||
          (option.parentElement?.tagName === "OPTGROUP" &&
            (option.parentElement as HTMLOptGroupElement).disabled),
        group:
          option.parentElement?.tagName === "OPTGROUP"
            ? (option.parentElement as HTMLOptGroupElement).label
            : undefined,
      }))
      setOptions((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      )
      setSelected(select.value)
      if (!ariaLabel && !labelledBy) {
        const text = Array.from(button.labels ?? [], (label) => {
          const copy = label.cloneNode(true) as HTMLElement
          copy
            .querySelectorAll("button, select, svg")
            .forEach((node) => node.remove())
          return copy.textContent?.trim()
        })
          .filter(Boolean)
          .join(" ")
        setLabel(text || undefined)
      }
    })

    function close(restore = false) {
      setOpen(false)
      if (restore) trigger.current?.focus({ preventScroll: true })
    }
    function choose(index: number) {
      const option = options[index]
      if (!option || option.disabled) return
      const select = native.current!
      if (select.value !== option.value) {
        select.value = option.value
        select.dispatchEvent(
          new select.ownerDocument.defaultView!.Event("change", {
            bubbles: true,
          })
        )
      }
      close(true)
    }
    function move(from: number, direction: number) {
      for (
        let index = from + direction;
        index >= 0 && index < options.length;
        index += direction
      )
        if (!options[index].disabled) return index
      return from
    }
    function show(last = false) {
      if (trigger.current?.disabled || native.current?.matches(":disabled"))
        return
      setPortal(trigger.current!.closest("dialog") ?? document.body)
      trigger.current?.focus({ preventScroll: true })
      const selectedIndex = options.findIndex(
        (option) => option.value === selected && !option.disabled
      )
      setActive(
        selectedIndex >= 0
          ? selectedIndex
          : move(last ? options.length : -1, last ? -1 : 1)
      )
      setOpen(true)
    }
    function keydown(event: KeyboardEvent<HTMLButtonElement>) {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      const { key } = event
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Enter",
          " ",
          "Escape",
        ].includes(key)
      ) {
        if (key === "Escape" && !open) return
        event.preventDefault()
        event.stopPropagation()
        if (key === "Escape") close(true)
        else if (!open) show(key === "ArrowUp" || key === "End")
        else if (key === "Enter" || key === " ") choose(active)
        else if (key === "Home") setActive(move(-1, 1))
        else if (key === "End") setActive(move(options.length, -1))
        else setActive(move(active, key === "ArrowDown" ? 1 : -1))
      } else if (key === "Tab") close()
      else if (
        key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        const previous =
          Date.now() - search.current.at < 600 ? search.current.text : ""
        const text = (previous + key).toLocaleLowerCase()
        search.current = { text, at: Date.now() }
        const query = [...text].every((char) => char === text[0])
          ? text[0]
          : text
        const start = open
          ? active
          : options.findIndex((option) => option.value === selected)
        const matching = options
          .map((_, index) => (index + start + 1) % options.length)
          .find(
            (index) =>
              !options[index].disabled &&
              options[index].label.toLocaleLowerCase().startsWith(query)
          )
        if (matching !== undefined) {
          if (open) setActive(matching)
          else choose(matching)
        }
      }
    }

    useLayoutEffect(() => {
      if (!open || !portal) return
      function place() {
        const button = trigger.current!
        if (button.disabled || native.current?.matches(":disabled")) {
          close()
          return
        }
        const rect = button.getBoundingClientRect(),
          viewport = window.visualViewport
        const width = viewport?.width ?? window.innerWidth,
          height = viewport?.height ?? window.innerHeight
        const inset = 8,
          gap = 6,
          above = rect.top - inset - gap,
          below = height - rect.bottom - inset - gap
        const up =
          below < Math.min(260, list.current?.scrollHeight ?? 260) &&
          above > below
        const palette = getComputedStyle(button),
          inherited: Record<string, string> = {}
        // Portals keep the local artwork/output palette, font and opacity settings.
        for (let index = 0; index < palette.length; index++) {
          const name = palette[index]
          if (name.startsWith("--"))
            inherited[name] = palette.getPropertyValue(name)
        }
        // Top-layer backdrop blur varies across WebViews. Keep options legible
        // over text and busy artwork even where the browser cannot blur beneath them.
        inherited["--overlay-glass-opacity"] = String(
          Math.max(
            0.97,
            parseFloat(palette.getPropertyValue("--overlay-glass-opacity")) || 0
          )
        )
        const dialog = button.closest("dialog")
        const fallback =
          dialog &&
          !list.current?.showPopover &&
          getComputedStyle(dialog).backdropFilter !== "none"
        const offset = fallback
          ? dialog.getBoundingClientRect()
          : { left: 0, top: 0 }
        setPosition({
          ...inherited,
          position: "fixed",
          zIndex: 21000,
          margin: 0,
          right: "auto",
          left:
            Math.max(
              inset,
              Math.min(rect.left, width - Math.max(rect.width, 180) - inset)
            ) - offset.left,
          width: Math.min(Math.max(rect.width, 180), width - inset * 2),
          maxHeight: Math.max(48, Math.min(320, up ? above : below)),
          top: up
            ? rect.top -
              gap -
              Math.min(320, above, list.current?.scrollHeight ?? 320) -
              offset.top
            : rect.bottom + gap - offset.top,
          bottom: "auto",
          fontFamily: palette.fontFamily,
          fontSize: palette.fontSize,
        })
      }
      function outside(event: PointerEvent) {
        const target = event.target as Node
        if (
          !trigger.current?.contains(target) &&
          !list.current?.contains(target)
        )
          close()
      }
      function blur() {
        close()
      }
      function dialogCancel(event: Event) {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      }
      const dialog = trigger.current?.closest("dialog")
      // Top-layer popovers escape clipping and remain interactive inside modal dialogs.
      list.current?.showPopover?.()
      place()
      const observer = new ResizeObserver(place)
      observer.observe(trigger.current!)
      document.addEventListener("pointerdown", outside, true)
      window.addEventListener("resize", place)
      window.addEventListener("scroll", place, true)
      window.addEventListener("blur", blur)
      dialog?.addEventListener("cancel", dialogCancel)
      return () => {
        observer.disconnect()
        document.removeEventListener("pointerdown", outside, true)
        window.removeEventListener("resize", place)
        window.removeEventListener("scroll", place, true)
        window.removeEventListener("blur", blur)
        dialog?.removeEventListener("cancel", dialogCancel)
      }
    }, [open, portal])

    useEffect(() => {
      const form = native.current?.form
      function reset() {
        close()
        requestAnimationFrame(() => {
          if (native.current) setSelected(native.current.value)
        })
      }
      form?.addEventListener("reset", reset)
      return () => form?.removeEventListener("reset", reset)
    }, [props.form])

    useLayoutEffect(() => {
      if (open && (!options[active] || options[active].disabled)) {
        setActive(
          options.findIndex(
            (option) => option.value === selected && !option.disabled
          ) >= 0
            ? options.findIndex(
                (option) => option.value === selected && !option.disabled
              )
            : options.findIndex((option) => !option.disabled)
        )
        return
      }
      if (open && active >= 0)
        list.current
          ?.querySelector(`[data-index="${active}"]`)
          ?.scrollIntoView({ block: "nearest" })
    }, [open, active, options, selected])

    return (
      <span className={clsx("ui-select", className)} style={style}>
        <select
          {...props}
          id={`${triggerId}-native`}
          ref={native}
          hidden
          tabIndex={-1}
          aria-hidden="true"
          aria-label={ariaLabel}
          onInvalid={(event) => {
            event.preventDefault()
            trigger.current?.focus()
            props.onInvalid?.(event)
          }}
          onChange={(event) => {
            setSelected(event.currentTarget.value)
            onChange?.(event)
          }}
        >
          {children}
        </select>
        <Button
          ref={trigger}
          id={triggerId}
          variant="bare"
          className={`ui-select-trigger ui-select-trigger--${size}`}
          role="combobox"
          aria-label={ariaLabel ?? label}
          aria-labelledby={labelledBy}
          aria-describedby={props["aria-describedby"]}
          aria-invalid={props["aria-invalid"]}
          aria-required={props.required}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && active >= 0 ? `${listId}-${active}` : undefined
          }
          tabIndex={props.tabIndex ?? 0}
          autoFocus={autoFocus}
          onFocus={onFocus}
          disabled={props.disabled}
          title={props.title}
          onKeyDown={keydown}
          onClick={(event) => {
            onClick?.(event)
            if (event.defaultPrevented) return
            event.preventDefault()
            open ? close() : show()
          }}
          onBlur={(event) => {
            onBlur?.(event)
            if (!list.current?.contains(event.relatedTarget as Node)) close()
          }}
        >
          <span className="ui-select-value">
            {(() => {
              const option = options.find((option) => option.value === selected)
              return option ? renderOption?.(option) ?? option.label : ""
            })()}
          </span>
          <IconChevronDown
            size={14}
            aria-hidden="true"
            className="ui-select-chevron"
          />
        </Button>
        {open &&
          portal &&
          createPortal(
            <DropdownSurface
              ref={list}
              id={listId}
              role="listbox"
              popover="manual"
              aria-label={ariaLabel ?? label}
              aria-labelledby={labelledBy}
              className="ui-select-options"
              style={position}
              onPointerDown={(event) => {
                if ((event.target as Element).closest('[role="option"]'))
                  event.preventDefault()
                event.stopPropagation()
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              {options.map((option, index) => (
                <div key={`${option.value}-${index}`}>
                  {option.group &&
                    option.group !== options[index - 1]?.group && (
                      <div className="ui-menu-caption">{option.group}</div>
                    )}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={selected === option.value}
                    aria-disabled={option.disabled || undefined}
                    data-index={index}
                    data-highlighted={active === index || undefined}
                    className="ui-select-option"
                    onPointerMove={() => {
                      if (!option.disabled) setActive(index)
                    }}
                    onClick={() => choose(index)}
                  >
                    <span className="min-w-0 flex-1">{renderOption?.(option) ?? option.label}</span>
                    <IconCheck
                      size={15}
                      aria-hidden="true"
                      className={selected === option.value ? "" : "invisible"}
                    />
                  </div>
                </div>
              ))}
            </DropdownSurface>,
            portal
          )}
      </span>
    )
  }
)
