import { forwardRef, type ButtonHTMLAttributes } from "react"
import clsx from "clsx"

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Bare keeps a structural control's layout (cards, transport, tabs). */
  variant?: "primary" | "secondary" | "ghost" | "danger" | "menu" | "bare"
  size?: "sm" | "md" | "icon"
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "sm",
      className,
      type = "button",
      ...props
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={clsx(
          "ui-button",
          `ui-button--${variant}`,
          variant !== "bare" && variant !== "menu" && `ui-button--${size}`,
          className
        )}
        {...props}
      />
    )
  }
)
