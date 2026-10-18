import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
} from "react"
import clsx from "clsx"

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  indeterminate?: boolean
}

/** A real form control: label clicks, Space, validation and change events stay native. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ className, indeterminate = false, ...props }, ref) {
    const input = useRef<HTMLInputElement>(null)
    useImperativeHandle(ref, () => input.current!)
    useLayoutEffect(() => {
      if (input.current) input.current.indeterminate = indeterminate
    }, [indeterminate])
    return (
      <input
        {...props}
        ref={input}
        type="checkbox"
        className={clsx("ui-checkbox", className)}
      />
    )
  }
)

export const Switch = forwardRef<
  HTMLInputElement,
  Omit<CheckboxProps, "indeterminate">
>(function Switch({ className, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      type="checkbox"
      role="switch"
      className={clsx("ui-switch", className)}
    />
  )
})
